"""MinerU cloud precision API adapter returning the existing outline contract."""
from __future__ import annotations

from io import BytesIO
import json
import os
from pathlib import Path
import time
from typing import Any
import uuid
from zipfile import BadZipFile, ZipFile

import httpx

from ...config import settings
from .local_parser import _pdf_page_count, _title_from_filename, parse_toc_text
from .store import OUTLINE_SCHEMA, DocumentParseError, DocumentParserUnavailableError

MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024


def content_list_to_pages(content: Any, page_count: int) -> list[str]:
    """Keep source page boundaries; ignore image/footer blocks when reading TOC.

    MinerU V4 precision exports a Content List V1 alongside Markdown. The
    page_idx fields are zero-based; printed TOC destination pages stay intact.
    Do not derive page numbers from the flattened Markdown document.
    """
    if not isinstance(content, list):
        raise DocumentParseError("MinerU content_list 不是有效的内容列表")
    pages: list[list[str]] = [[] for _ in range(page_count)]
    for block in content:
        if not isinstance(block, dict):
            continue
        page = block.get("page_idx")
        if isinstance(page, bool) or not isinstance(page, int) or not 0 <= page < page_count:
            raise DocumentParseError("MinerU 内容块缺少有效的原 PDF 页码")
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            pages[page].append(block["text"])
    return ["\n".join(page) for page in pages]


def _api_data(response: httpx.Response) -> dict[str, Any]:
    # Never persist request headers, signed URLs, or arbitrary server error text.
    if response.status_code in (401, 403):
        raise DocumentParserUnavailableError("MinerU 鉴权失败，请检查 MINERU_API_TOKEN")
    response.raise_for_status()
    try:
        value = response.json()
    except ValueError as exc:
        raise DocumentParseError("MinerU 返回的内容不是有效 JSON") from exc
    if not isinstance(value, dict) or value.get("code") != 0:
        code = value.get("code") if isinstance(value, dict) else None
        safe_code = str(code)[:20] if isinstance(code, (str, int)) else "unknown"
        raise DocumentParseError(f"MinerU 请求失败（code={safe_code}），请检查账号额度和 API 配置")
    if not isinstance(value.get("data"), dict):
        raise DocumentParseError("MinerU 响应缺少任务数据")
    return value["data"]


def _read_artifacts(archive_bytes: bytes) -> tuple[bytes, bytes]:
    try:
        with ZipFile(BytesIO(archive_bytes)) as archive:
            files = archive.infolist()
            if len(files) > 10000 or sum(item.file_size for item in files) > MAX_EXTRACTED_BYTES:
                raise DocumentParseError("MinerU 结果包超过解压大小限制")
            markdown = [item for item in files if Path(item.filename).name == "full.md"]
            content = [item for item in files if item.filename.endswith("_content_list.json")]
            if len(markdown) != 1 or len(content) != 1:
                raise DocumentParseError("MinerU 结果缺少唯一的 full.md 或 content_list.json")
            # Read known members into fixed filenames; never extract archive paths.
            return archive.read(markdown[0]), archive.read(content[0])
    except DocumentParseError:
        raise
    except (BadZipFile, RuntimeError) as exc:
        raise DocumentParseError("MinerU 结果不是可读取的 ZIP 文件") from exc


def _save_artifact(directory: Path, name: str, content: bytes) -> None:
    current = Path(os.path.abspath(directory))
    for part in (current, *current.parents):
        if part.is_symlink():
            raise DocumentParseError("MinerU 结果目录不允许符号链接")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    if target.is_symlink():
        raise DocumentParseError("MinerU 结果文件不允许符号链接")
    temporary = directory / f".{name}.{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_bytes(content)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def parse_mineru_pdf(
    path: Path, *, document_id: str, filename: str, sha256: str,
    scan_pages: int, executable: str, timeout_seconds: float,
) -> dict[str, Any]:
    token = settings.mineru_api_token.strip()
    if not token:
        raise DocumentParserUnavailableError("MinerU 未配置，请设置 MINERU_API_TOKEN")
    page_count = _pdf_page_count(path)
    if page_count > 200:
        raise DocumentParseError("MinerU 在线精准接口当前单文件最多 200 页，请先分段上传教材")
    base = (settings.mineru_api_base or "https://mineru.net/api/v4").rstrip("/")
    model = settings.mineru_model_version
    parser_name = f"mineru-{model}"
    budget = max(1.0, settings.mineru_timeout_seconds)
    started = time.monotonic()
    deadline = started + budget

    def remaining() -> float:
        value = deadline - time.monotonic()
        if value <= 0:
            raise DocumentParseError("MinerU 解析超时，可重试或调整 MINERU_TIMEOUT_SECONDS")
        return max(0.1, min(60.0, value))

    try:
        with httpx.Client(follow_redirects=False) as client:
            headers = {"Authorization": f"Bearer {token}"}
            data = _api_data(client.post(
                base + "/file-urls/batch", headers=headers, timeout=remaining(),
                json={
                    "files": [{"name": filename, "data_id": document_id}],
                    "model_version": model, "language": "ch",
                    "enable_formula": True, "enable_table": True,
                },
            ))
            batch_id = data.get("batch_id")
            urls = data.get("file_urls")
            if not isinstance(batch_id, str) or not isinstance(urls, list) or len(urls) != 1:
                raise DocumentParseError("MinerU 未返回有效的上传任务")
            with path.open("rb") as stream:
                response = client.put(urls[0], content=stream, timeout=remaining())
            response.raise_for_status()
            while True:
                result = _api_data(client.get(
                    base + "/extract-results/batch/" + batch_id,
                    headers=headers, timeout=remaining(),
                ))
                items = result.get("extract_result")
                if not isinstance(items, list) or not items or not isinstance(items[0], dict):
                    raise DocumentParseError("MinerU 未返回有效的任务状态")
                item = items[0]
                state = item.get("state")
                if state == "failed":
                    raise DocumentParseError("MinerU 文档解析失败，请在 MinerU 控制台查看任务原因")
                if state == "done":
                    url = item.get("full_zip_url")
                    if not isinstance(url, str) or not url:
                        raise DocumentParseError("MinerU 任务完成但未提供结果下载地址")
                    chunks = []
                    size = 0
                    # Authentication is scoped to API calls, not storage/downloads.
                    with client.stream("GET", url, follow_redirects=True, timeout=remaining()) as response:
                        response.raise_for_status()
                        for chunk in response.iter_bytes():
                            remaining()
                            size += len(chunk)
                            if size > MAX_ARCHIVE_BYTES:
                                raise DocumentParseError("MinerU 结果下载超过大小限制")
                            chunks.append(chunk)
                    archive_bytes = b"".join(chunks)
                    break
                if state not in {"waiting-file", "pending", "running", "converting"}:
                    raise DocumentParseError("MinerU 返回未知的任务状态")
                time.sleep(min(2.0, remaining()))
        markdown, content_bytes = _read_artifacts(archive_bytes)
        try:
            content = json.loads(content_bytes)
        except (ValueError, UnicodeError) as exc:
            raise DocumentParseError("MinerU 内容列表不是有效 JSON") from exc
        raw = path.parent / parser_name
        _save_artifact(raw, "result.zip", archive_bytes)
        _save_artifact(raw, "full.md", markdown)
        _save_artifact(raw, "content-list.json", content_bytes)
        _save_artifact(raw, "task.json", json.dumps({
            "batch_id": batch_id, "parser": parser_name, "sha256": sha256,
            "page_count": page_count, "elapsed_seconds": round(time.monotonic()-started, 2),
        }, ensure_ascii=False, indent=2).encode("utf-8"))
        pages = content_list_to_pages(content, page_count)
        pages_to_scan = min(max(1, int(scan_pages)), page_count)
        chapters = parse_toc_text("\f".join(pages[:pages_to_scan]))
        return {
            "schema_version": OUTLINE_SCHEMA, "document_id": document_id,
            "title": _title_from_filename(filename),
            "source": {"filename": filename, "sha256": sha256, "page_count": page_count,
                       "parser": parser_name, "toc_pages": pages_to_scan},
            "chapters": chapters,
        }
    except httpx.TimeoutException as exc:
        raise DocumentParseError("MinerU 网络请求超时，请重试") from exc
    except httpx.HTTPStatusError as exc:
        raise DocumentParseError(f"MinerU HTTP 请求失败（{exc.response.status_code}），请检查服务和额度") from exc
    except httpx.HTTPError as exc:
        raise DocumentParserUnavailableError("无法连接 MinerU，请检查网络和 MINERU_API_BASE") from exc
