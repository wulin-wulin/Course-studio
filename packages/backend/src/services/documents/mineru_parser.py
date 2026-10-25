"""MinerU cloud precision API adapter returning the existing outline contract."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import time
from typing import Any
import unicodedata
import uuid
from urllib.parse import quote, urlsplit
from zipfile import BadZipFile, ZipFile

import httpx
from pypdf import PdfReader, PdfWriter

from ...config import settings
from .local_parser import _pdf_page_count, _title_from_filename, _TOC_HEADING_RE, parse_toc_text
from .store import OUTLINE_SCHEMA, DocumentParseError, DocumentParserUnavailableError
from .structure_candidates import (
    StructureCandidateError,
    build_mineru_structure_candidate,
)

MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
MAX_PART_PAGES = 100
MAX_PARALLEL_PARTS = 5
_CONTENT_LIST_KEYS = ("content_list", "content", "items", "data", "result")


def _is_http_url(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = urlsplit(value)
        return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)
    except ValueError:
        return False


def _block_text(block: dict[str, Any]) -> str | None:
    """Read text from MinerU V1 and common wrapped block shapes.

    V1 normally exposes ``text``; a few compatible exporters use a string
    ``content`` field or a list of inline objects.  Keeping this normalization
    local lets page mapping and structure analysis see the same evidence.
    """

    text = block.get("text")
    if isinstance(text, str) and text.strip():
        return text
    content = block.get("content")
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                value = item.get("text") or item.get("content")
                if isinstance(value, str):
                    parts.append(value)
        joined = "".join(parts)
        return joined if joined.strip() else None
    return None


def _unwrap_content_list(content: Any) -> list[Any]:
    """Unwrap the list from common MinerU/API response envelopes."""

    value = content
    for _ in range(5):
        if isinstance(value, list):
            return value
        if not isinstance(value, dict):
            break
        next_value = next(
            (
                value.get(key)
                for key in _CONTENT_LIST_KEYS
                if isinstance(value.get(key), (list, dict))
            ),
            None,
        )
        if next_value is None or next_value is value:
            break
        value = next_value
    raise DocumentParseError("MinerU content_list 不是有效的内容列表")


def content_list_to_pages(content: Any, page_count: int) -> list[str]:
    """Keep source page boundaries; ignore image/footer blocks when reading TOC.

    MinerU V4 precision exports a Content List V1 alongside Markdown. The
    page_idx fields are zero-based; printed TOC destination pages stay intact.
    Do not derive page numbers from the flattened Markdown document.
    """
    content = _unwrap_content_list(content)
    pages: list[list[str]] = [[] for _ in range(page_count)]
    for block in content:
        if not isinstance(block, dict):
            continue
        # Layout/image blocks are useful for rendering but do not contribute
        # to the textual TOC.  Some MinerU versions omit page_idx on those
        # auxiliary records; ignore them before applying the strict text-page
        # contract below.
        if block.get("type") not in {"text", "header", "ref_text", None}:
            continue
        page = block.get("page_idx")
        if isinstance(page, bool) or not isinstance(page, int) or not 0 <= page < page_count:
            raise DocumentParseError("MinerU 内容块缺少有效的原 PDF 页码")
        text = _block_text(block)
        if text is not None:
            pages[page].append(text)
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


def _read_artifacts(archive_bytes: bytes, directory: Path) -> tuple[bytes, bytes]:
    try:
        with ZipFile(BytesIO(archive_bytes)) as archive:
            files = archive.infolist()
            if len(files) > 10000 or sum(item.file_size for item in files) > MAX_EXTRACTED_BYTES:
                raise DocumentParseError("MinerU 结果包超过解压大小限制")
            markdown = [item for item in files if Path(item.filename).name == "full.md"]
            content_candidates = [
                item
                for item in files
                if Path(item.filename).name in {"content-list.json", "content_list.json"}
                or item.filename.endswith("_content_list.json")
            ]
            v1_content = [
                item
                for item in content_candidates
                if not Path(item.filename).stem.endswith("_v2")
            ]
            content = v1_content if len(v1_content) == 1 else content_candidates
            if len(markdown) != 1 or len(content) != 1:
                raise DocumentParseError("MinerU 结果缺少唯一的 full.md 或 content_list.json")
            image_directory = Path(markdown[0].filename).parent / "images"
            for item in files:
                image = Path(item.filename)
                if not item.is_dir() and image.parent == image_directory and image.suffix.lower() in {
                    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
                }:
                    _save_artifact(directory / "images", image.name, archive.read(item))
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


def _read_stable_file(path: Path, *, max_bytes: int) -> bytes | None:
    """Read one parser artifact only when it is a complete, regular file.

    MinerU artifacts are normally written through ``_save_artifact``.  The
    extra size/stat checks make cache replay safe even when an older process is
    still finishing a write or an operator copied a document directory while
    the server was running.
    """

    try:
        if path.is_symlink() or not path.is_file():
            return None
        before = path.stat()
        if before.st_size <= 0 or before.st_size > max_bytes:
            return None
        value = path.read_bytes()
        after = path.stat()
    except OSError:
        return None
    if (
        before.st_mtime_ns != after.st_mtime_ns
        or before.st_size != after.st_size
        or len(value) != after.st_size
    ):
        return None
    return value


def _markdown_sha256(value: bytes) -> str:
    try:
        normalized = value.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    except UnicodeDecodeError as exc:
        raise DocumentParseError("MinerU full.md 不是有效的 UTF-8 文本") from exc
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _content_sha256(value: Any) -> str:
    try:
        encoded = json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise DocumentParseError("MinerU 内容列表无法计算摘要") from exc
    return hashlib.sha256(encoded).hexdigest()


def _load_cached_mineru_content(
    directory: Path,
    *,
    parser_name: str,
    sha256: str,
    page_count: int,
) -> list[Any] | dict[str, Any] | None:
    """Return validated raw content from a previous complete MinerU attempt.

    A failed post-processing step should not force a second cloud task.  The
    task sidecar binds the cache to the immutable upload and parser version;
    the content list is then checked against the current PDF page count before
    it can be reused.  ``None`` means the cache is absent or stale, so the
    normal online path may proceed.
    """

    if directory.is_symlink() or not directory.is_dir():
        return None
    task_bytes = _read_stable_file(directory / "task.json", max_bytes=1 * 1024 * 1024)
    markdown_bytes = _read_stable_file(
        directory / "full.md", max_bytes=MAX_EXTRACTED_BYTES
    )
    content_bytes = _read_stable_file(
        directory / "content-list.json", max_bytes=MAX_EXTRACTED_BYTES
    )
    if task_bytes is None or markdown_bytes is None or content_bytes is None:
        return None
    try:
        task = json.loads(task_bytes.decode("utf-8"))
        if not isinstance(task, dict):
            return None
        cached_page_count = task.get("page_count")
        if (
            task.get("parser") != parser_name
            or task.get("sha256") != sha256
            or isinstance(cached_page_count, bool)
            or not isinstance(cached_page_count, int)
            or cached_page_count != page_count
        ):
            return None
        parts = task.get("parts")
        if parts is not None:
            if not isinstance(parts, list) or not parts:
                return None
            expected_start = 1
            for part in parts:
                if not isinstance(part, dict):
                    return None
                start = part.get("page_start")
                end = part.get("page_end")
                if (
                    isinstance(start, bool)
                    or not isinstance(start, int)
                    or isinstance(end, bool)
                    or not isinstance(end, int)
                    or start != expected_start
                    or end < start
                    or end > page_count
                    or not isinstance(part.get("name"), str)
                    or not str(part.get("name")).strip()
                ):
                    return None
                expected_start = end + 1
            if expected_start != page_count + 1:
                return None
        if not markdown_bytes.strip():
            return None
        content = json.loads(content_bytes.decode("utf-8-sig"))
        # This validates every page_idx and rejects a truncated/foreign
        # content-list before it is handed to the structure pipeline.
        content_list_to_pages(content, page_count)
        markdown_digest = _markdown_sha256(markdown_bytes)
        content_digest = _content_sha256(content)
        if (
            task.get("markdown_sha256") is not None
            and task.get("markdown_sha256") != markdown_digest
        ) or (
            task.get("content_sha256") is not None
            and task.get("content_sha256") != content_digest
        ):
            return None
    except (TypeError, ValueError, UnicodeError, DocumentParseError):
        return None
    if not isinstance(content, (list, dict)):
        return None
    return content


def _parse_mineru_part(
    path: Path, *, document_id: str, filename: str, sha256: str,
    page_count: int, directory: Path,
) -> tuple[bytes, list[Any], dict[str, Any]]:
    token = settings.mineru_api_token.strip()
    if not token:
        raise DocumentParserUnavailableError("MinerU 未配置，请设置 MINERU_API_TOKEN")
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
        # ``mineru_timeout_seconds`` is the budget for the complete part
        # (requesting an upload URL, uploading the PDF, polling the task and
        # downloading the result).  Do not cap an individual HTTP operation
        # at an unrelated 60-second value: a large scanned PDF can quite
        # legitimately need longer than that just to upload or download.  A
        # monotonic deadline still guarantees that the sequence cannot run
        # past the configured budget.
        return max(0.1, value)

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
            if (
                not isinstance(batch_id, str)
                or not batch_id.strip()
                or not isinstance(urls, list)
                or len(urls) != 1
                or not _is_http_url(urls[0])
            ):
                raise DocumentParseError("MinerU 未返回有效的上传任务")
            with path.open("rb") as stream:
                response = client.put(urls[0], content=stream, timeout=remaining())
            response.raise_for_status()
            while True:
                result = _api_data(client.get(
                    base + "/extract-results/batch/" + quote(batch_id, safe=""),
                    headers=headers, timeout=remaining(),
                ))
                items = result.get("extract_result")
                if not isinstance(items, list) or not items or not isinstance(items[0], dict):
                    raise DocumentParseError("MinerU 未返回有效的任务状态")
                item = items[0]
                state = item.get("state")
                if isinstance(state, str):
                    state = state.strip().lower()
                if state == "failed":
                    raise DocumentParseError("MinerU 文档解析失败，请在 MinerU 控制台查看任务原因")
                if state == "done":
                    url = item.get("full_zip_url")
                    if not _is_http_url(url):
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
        markdown, content_bytes = _read_artifacts(archive_bytes, directory)
        try:
            content = json.loads(content_bytes)
        except (ValueError, UnicodeError) as exc:
            raise DocumentParseError("MinerU 内容列表不是有效 JSON") from exc
        content_list_to_pages(content, page_count)
        _save_artifact(directory, "result.zip", archive_bytes)
        _save_artifact(directory, "full.md", markdown)
        _save_artifact(directory, "content-list.json", content_bytes)
        task = {
            "batch_id": batch_id, "parser": parser_name, "sha256": sha256,
            "page_count": page_count, "elapsed_seconds": round(time.monotonic() - started, 2),
            "markdown_sha256": _markdown_sha256(markdown),
            "content_sha256": _content_sha256(content),
        }
        _save_artifact(directory, "task.json", json.dumps(task, ensure_ascii=False, indent=2).encode("utf-8"))
        return markdown, content, task
    except httpx.TimeoutException as exc:
        raise DocumentParseError("MinerU 网络请求超时，请重试") from exc
    except httpx.HTTPStatusError as exc:
        raise DocumentParseError(f"MinerU HTTP 请求失败（{exc.response.status_code}），请检查服务和额度") from exc
    except httpx.HTTPError as exc:
        raise DocumentParserUnavailableError("无法连接 MinerU，请检查网络和 MINERU_API_BASE") from exc


def _extract_native_page_text(page: Any) -> str:
    """Return layout text when available, tolerating genuinely blank pages."""
    try:
        return page.extract_text(extraction_mode="layout") or ""
    except Exception:
        # A damaged/odd page object should not discard an otherwise valid
        # MinerU result.  The Content List remains the fallback TOC source.
        return ""


def parse_mineru_pdf(
    path: Path, *, document_id: str, filename: str, sha256: str,
    scan_pages: int, executable: str, timeout_seconds: float,
) -> dict[str, Any]:
    """Split long PDFs into at most 100-page parts and merge in source order."""
    page_count = _pdf_page_count(path)
    parser_name = f"mineru-{settings.mineru_model_version}"
    raw = path.parent / parser_name
    started = time.monotonic()
    cached_content = _load_cached_mineru_content(
        raw,
        parser_name=parser_name,
        sha256=sha256,
        page_count=page_count,
    )
    if cached_content is not None:
        # A complete raw result is enough for the deterministic structure
        # promotion below.  In particular, this branch is allowed to run
        # without a token: a previous cloud attempt already paid for the
        # result and only local post-processing remains.
        content = cached_content
    else:
        if not settings.mineru_api_token.strip():
            raise DocumentParserUnavailableError("MinerU 未配置，请设置 MINERU_API_TOKEN")
        if page_count <= MAX_PART_PAGES:
            _, content, _ = _parse_mineru_part(
                path, document_id=document_id, filename=filename, sha256=sha256,
                page_count=page_count, directory=raw,
            )
        else:
            with TemporaryDirectory(prefix="mineru-") as temporary:
                reader = PdfReader(path)
                if reader.is_encrypted:
                    reader.decrypt("")
                parts = []
                for start in range(0, page_count, MAX_PART_PAGES):
                    end = min(start + MAX_PART_PAGES, page_count)
                    part = Path(temporary) / f"part-{len(parts) + 1:04d}.pdf"
                    with PdfWriter() as writer:
                        for page in reader.pages[start:end]:
                            writer.add_page(page)
                        writer.write(part)
                    parts.append((part, start, end))

                def parse_part(part):
                    source, start, end = part
                    return _parse_mineru_part(
                        source, document_id=f"{document_id}-{source.stem}",
                        filename=source.name, sha256=sha256, page_count=end - start,
                        directory=raw / "parts" / source.stem,
                    )

                markdown_parts = []
                content = []
                tasks = []
                with ThreadPoolExecutor(max_workers=MAX_PARALLEL_PARTS) as pool:
                    # map yields in input order even when later parts finish first.
                    for (part, start, end), (markdown, blocks, task) in zip(parts, pool.map(parse_part, parts)):
                        prefix = f"parts/{part.stem}/"
                        for marker in (b"](", b'src="', b"src='"):
                            for image_path in (b"images/", b"./images/"):
                                markdown = markdown.replace(marker + image_path, marker + prefix.encode() + b"images/")
                        markdown_parts.append(markdown.rstrip())
                        for block in _unwrap_content_list(blocks):
                            if isinstance(block, dict):
                                block = {**block, "page_idx": block["page_idx"] + start}
                                image_path = block.get("img_path")
                                if isinstance(image_path, str) and image_path.startswith(("images/", "./images/")):
                                    block["img_path"] = prefix + image_path.removeprefix("./")
                            content.append(block)
                        tasks.append({"name": part.stem, "page_start": start + 1, "page_end": end,
                                      "batch_id": task["batch_id"]})
            # A failed part raises before any combined output is published.
            _save_artifact(raw, "full.md", b"\n\n".join(markdown_parts) + b"\n")
            _save_artifact(raw, "content-list.json", json.dumps(content, ensure_ascii=False).encode("utf-8"))
            _save_artifact(raw, "task.json", json.dumps({
                "parser": parser_name, "sha256": sha256, "page_count": page_count,
                "parts": tasks, "elapsed_seconds": round(time.monotonic() - started, 2),
                "markdown_sha256": _markdown_sha256(b"\n\n".join(markdown_parts) + b"\n"),
                "content_sha256": _content_sha256(content),
            }, ensure_ascii=False, indent=2).encode("utf-8"))
    # Keep a separately auditable, evidence-only structure candidate beside
    # the immutable MinerU files.  The legacy/native outline is still returned
    # for API compatibility; DocumentStore promotes this candidate only after
    # it has been joined to Markdown and contract-validated.
    try:
        markdown_text = (raw / "full.md").read_text(encoding="utf-8-sig")
        candidate = build_mineru_structure_candidate(
            content,
            markdown_text,
            page_count=page_count,
        )
    except (OSError, UnicodeError, StructureCandidateError):
        candidate = None
    if candidate is not None:
        _save_artifact(
            raw,
            "structure-candidate.json",
            json.dumps(candidate, ensure_ascii=False, indent=2).encode("utf-8"),
        )

    pages = content_list_to_pages(content, page_count)
    pages_to_scan = min(max(1, int(scan_pages)), page_count)
    reader = PdfReader(path)
    if reader.is_encrypted:
        reader.decrypt("")
    # Native text keeps TOC leaders and chapter numbers that OCR can omit.
    # Blank PDF pages produced by lightweight fixtures (and some scanners) may
    # not contain a /Contents stream; treat those pages as empty instead of
    # letting pypdf's layout extractor abort the whole MinerU request.
    toc_text = unicodedata.normalize("NFKC", "\f".join(
        _extract_native_page_text(page) for page in reader.pages[:pages_to_scan]
    ))
    if not any(_TOC_HEADING_RE.fullmatch(line) for line in toc_text.splitlines()):
        toc_text = unicodedata.normalize("NFKC", "\f".join(pages[:pages_to_scan]))
    chapters = parse_toc_text(toc_text)
    return {
        "schema_version": OUTLINE_SCHEMA, "document_id": document_id,
        "title": _title_from_filename(filename),
        "source": {"filename": filename, "sha256": sha256, "page_count": page_count,
                   "parser": parser_name, "toc_pages": pages_to_scan},
        "chapters": chapters,
    }
