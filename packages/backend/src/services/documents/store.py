"""Durable storage and lifecycle management for uploaded textbook PDFs."""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import uuid
from typing import Any, BinaryIO, Callable

from ...config import settings


DOCUMENT_SCHEMA = "document-import/1.0"
OUTLINE_SCHEMA = "textbook-outline/1.0"
LOCAL_PARSER_NAME = "local-pdftotext"

_DOCUMENT_ID_RE = re.compile(r"^doc-[0-9a-f]{24}(?:-[0-9a-f]{8})?$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# ``0`` is reserved for the synthetic ``chapter-0`` bucket used when a PDF
# lists front matter without a numeric chapter (for example, ``前言`` or
# ``安装``).  Ordinary source chapters remain positive integers.
_CHAPTER_NUMBER_RE = re.compile(r"^(?:0|[1-9]\d*)$")
# A chapter without numbered subsections is represented by the chapter itself
# as one textbook point (for example ``1``), while ordinary descendants use
# ``2.1``/``2.1.1`` notation.
_POINT_NUMBER_RE = re.compile(r"^(?:0(?:\.\d+)*|[1-9]\d*(?:\.\d+)*)$")
_STATUSES = frozenset({"uploaded", "parsing", "ready", "failed"})
_MAX_JSON_BYTES = 16 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024
# Browsers and reverse proxies do not always preserve ``application/pdf``.
# Treat an absent or generic binary declaration as an advisory hint and rely
# on the file signature below for the authoritative PDF check.  A clearly
# non-PDF declaration is still rejected early so that an accidental image or
# text upload receives a useful 415 response before it is persisted.
_PERMITTED_UPLOAD_MEDIA_TYPES = frozenset(
    {
        "application/pdf",
        "application/octet-stream",
        "binary/octet-stream",
        "application/x-pdf",
    }
)


class DocumentError(RuntimeError):
    """Base class for safe, user-facing document errors."""


class DocumentNotFoundError(DocumentError):
    """The requested document does not exist."""


class DocumentConflictError(DocumentError):
    """The requested operation conflicts with the document lifecycle."""


class DocumentNotReadyError(DocumentConflictError):
    """An outline was requested before parsing completed."""


class DocumentUnsupportedMediaTypeError(DocumentError):
    """An upload declares an unsupported media type or lacks a PDF signature."""


class DocumentTooLargeError(DocumentError):
    """An upload exceeds the configured size limit."""


class DocumentValidationError(DocumentError):
    """Stored or parsed document data does not satisfy the public contract."""


class DocumentParserUnavailableError(DocumentError):
    """The configured parser cannot run in this environment."""


class DocumentParseError(DocumentError):
    """The parser ran but could not produce a usable textbook outline."""


class DocumentStorageError(DocumentError):
    """Document data could not be persisted safely."""


OutlineParser = Callable[..., dict[str, Any]]


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _safe_filename(value: str | None) -> str:
    raw = str(value or "document.pdf").replace("\\", "/").split("/")[-1]
    cleaned = "".join(ch for ch in raw if ch >= " " and ch != "\x7f").strip()
    if not cleaned:
        cleaned = "document.pdf"
    if len(cleaned) > 240:
        suffix = Path(cleaned).suffix[-16:]
        cleaned = cleaned[: 240 - len(suffix)].rstrip() + suffix
    return cleaned


class DocumentStore:
    """Store immutable source PDFs and their retryable outline parse results."""

    def __init__(
        self,
        root: Path | None = None,
        *,
        max_upload_bytes: int | None = None,
        toc_scan_pages: int | None = None,
        parse_timeout_seconds: float | None = None,
        pdftotext_executable: str | None = None,
    ):
        # Keep the operator-provided path lexical until its directory chain has
        # been checked.  Calling ``resolve()`` here would erase the symlink bit
        # and make later ``is_symlink()`` checks ineffective.
        self.root = Path(root or settings.document_library_dir).absolute()
        self.max_upload_bytes = int(
            max_upload_bytes
            if max_upload_bytes is not None
            else settings.document_max_upload_bytes
        )
        self.toc_scan_pages = int(
            toc_scan_pages
            if toc_scan_pages is not None
            else settings.document_toc_scan_pages
        )
        self.parse_timeout_seconds = float(
            parse_timeout_seconds
            if parse_timeout_seconds is not None
            else settings.document_parse_timeout_seconds
        )
        self.pdftotext_executable = (
            pdftotext_executable
            if pdftotext_executable is not None
            else settings.document_pdftotext_executable
        )
        if self.max_upload_bytes <= 0:
            raise ValueError("max_upload_bytes must be positive")
        if self.toc_scan_pages <= 0:
            raise ValueError("toc_scan_pages must be positive")
        if self.parse_timeout_seconds <= 0:
            raise ValueError("parse_timeout_seconds must be positive")
        try:
            self._assert_path_chain(self.root, allow_missing=True)
            self.root.mkdir(parents=True, exist_ok=True)
            self._assert_path_chain(self.root, allow_missing=False)
        except (OSError, DocumentValidationError) as exc:
            raise DocumentStorageError("文档存储目录不可用") from exc
        if not self.root.is_dir() or self.root.is_symlink():
            raise DocumentStorageError("文档存储目录不可用")
        self._lock = threading.RLock()
        self._active_parses: set[str] = set()

    # ------------------------------------------------------------------
    # Safe paths and JSON I/O
    # ------------------------------------------------------------------

    @staticmethod
    def _assert_no_symlink_chain(path: Path) -> None:
        """Reject symlink/non-directory ancestors without resolving them."""

        absolute = Path(os.path.abspath(path))
        current = Path(absolute.anchor)
        parts = absolute.parts[1:] if absolute.anchor else absolute.parts
        for index, part in enumerate(parts):
            current /= part
            if not os.path.lexists(current):
                continue
            if current.is_symlink():
                raise DocumentValidationError(
                    f"文档路径不允许符号链接：{current}"
                )
            if index < len(parts) - 1 and not current.is_dir():
                raise DocumentValidationError(
                    f"文档路径祖先不是目录：{current}"
                )

    def _assert_path_chain(
        self,
        path: Path,
        *,
        allow_missing: bool = True,
    ) -> Path:
        """Return an absolute lexical path after checking it stays in root.

        ``Path.resolve`` is intentionally avoided: it follows symlinks before
        the caller can reject them.  Existing path components are inspected
        with ``lexists``/``is_symlink`` and missing leaves are allowed for
        atomic writes.
        """

        absolute = Path(os.path.abspath(path))
        root = Path(os.path.abspath(self.root))
        try:
            relative = absolute.relative_to(root)
        except ValueError as exc:
            raise DocumentValidationError("文档路径超出受控存储目录") from exc
        self._assert_no_symlink_chain(root)
        current = root
        if not relative.parts:
            if os.path.lexists(current) and current.is_symlink():
                raise DocumentValidationError(f"文档路径不允许符号链接：{current}")
            return absolute
        for index, part in enumerate(relative.parts):
            current /= part
            exists = os.path.lexists(current)
            if not exists:
                if not allow_missing:
                    raise DocumentValidationError(f"文档路径不存在：{current}")
                # A missing component means all later components are missing
                # for a normal lexical path; leave creation to the caller.
                break
            if current.is_symlink():
                raise DocumentValidationError(f"文档路径不允许符号链接：{current}")
            if index < len(relative.parts) - 1 and not current.is_dir():
                raise DocumentValidationError(f"文档路径祖先不是目录：{current}")
        return absolute

    def _within_root(self, path: Path) -> Path:
        return self._assert_path_chain(path)

    def _document_dir(self, document_id: str, *, required: bool = True) -> Path:
        if not isinstance(document_id, str) or not _DOCUMENT_ID_RE.fullmatch(document_id):
            raise DocumentNotFoundError("文档不存在")
        path = self._within_root(self.root / document_id)
        if required and (not path.is_dir() or path.is_symlink()):
            raise DocumentNotFoundError(f"文档不存在：{document_id}")
        return path

    def _read_json(self, path: Path) -> dict[str, Any]:
        safe_path = self._within_root(path)
        if not safe_path.is_file() or safe_path.is_symlink():
            raise DocumentNotFoundError("文档数据不存在")
        try:
            if safe_path.stat().st_size > _MAX_JSON_BYTES:
                raise DocumentValidationError("文档数据文件过大")
            value = json.loads(safe_path.read_text(encoding="utf-8"))
        except DocumentError:
            raise
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise DocumentValidationError("文档数据损坏或无法读取") from exc
        if not isinstance(value, dict):
            raise DocumentValidationError("文档数据格式无效")
        return value

    def _write_json_atomic(self, path: Path, value: dict[str, Any]) -> None:
        safe_path = self._within_root(path)
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        self._assert_path_chain(safe_path, allow_missing=True)
        if safe_path.exists() and safe_path.is_symlink():
            raise DocumentValidationError("文档数据目标不能是符号链接")
        temporary = safe_path.with_name(f".{safe_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write(_json_bytes(value))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, safe_path)
        except OSError as exc:
            raise DocumentStorageError("无法保存文档数据") from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    # ------------------------------------------------------------------
    # Upload and read API
    # ------------------------------------------------------------------

    def create_upload(
        self,
        stream: BinaryIO,
        *,
        filename: str | None,
        content_type: str | None,
    ) -> dict[str, Any]:
        media_type = str(content_type or "").split(";", 1)[0].strip().lower()
        # Content-Type is only a hint: empty and generic binary declarations
        # are accepted because clients/proxies frequently omit or rewrite the
        # PDF MIME type.  The %PDF- signature check below remains mandatory.
        if media_type and media_type not in _PERMITTED_UPLOAD_MEDIA_TYPES:
            raise DocumentUnsupportedMediaTypeError(
                "上传声明的媒体类型不受支持；请上传 PDF 文件"
            )

        safe_filename = _safe_filename(filename)
        temporary_dir = self._within_root(self.root / f".upload-{uuid.uuid4().hex}")
        source_path = temporary_dir / "source.pdf"
        digest = hashlib.sha256()
        size = 0
        signature = bytearray()

        try:
            temporary_dir.mkdir(parents=False, exist_ok=False)
            with source_path.open("xb") as destination:
                while True:
                    chunk = stream.read(_READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    if not isinstance(chunk, (bytes, bytearray)):
                        raise DocumentValidationError("上传流返回了无效数据")
                    size += len(chunk)
                    if size > self.max_upload_bytes:
                        raise DocumentTooLargeError(
                            f"PDF 超过大小限制（最大 {self.max_upload_bytes} 字节）"
                        )
                    if len(signature) < 5:
                        signature.extend(chunk[: 5 - len(signature)])
                    digest.update(chunk)
                    destination.write(chunk)
                destination.flush()
                os.fsync(destination.fileno())

            if size == 0:
                raise DocumentUnsupportedMediaTypeError("PDF 文件不能为空")
            if bytes(signature) != b"%PDF-":
                raise DocumentUnsupportedMediaTypeError("文件内容不是有效的 PDF")

            sha256 = digest.hexdigest()
            base_id = f"doc-{sha256[:24]}"
            timestamp = _now()
            metadata: dict[str, Any] = {
                "schema_version": DOCUMENT_SCHEMA,
                "id": base_id,
                "filename": safe_filename,
                "content_type": "application/pdf",
                "size_bytes": size,
                "sha256": sha256,
                "status": "uploaded",
                "created_at": timestamp,
                "updated_at": timestamp,
                "parser": None,
                "page_count": None,
                "error": None,
                "outline_summary": None,
            }

            with self._lock:
                document_id = base_id
                destination_dir = self._document_dir(document_id, required=False)
                if destination_dir.exists():
                    existing = self._matching_existing(destination_dir, sha256)
                    if existing is not None:
                        return existing
                    while True:
                        document_id = f"{base_id}-{uuid.uuid4().hex[:8]}"
                        destination_dir = self._document_dir(document_id, required=False)
                        if not destination_dir.exists():
                            break
                metadata["id"] = document_id
                self._write_json_atomic(temporary_dir / "metadata.json", metadata)
                try:
                    os.replace(temporary_dir, destination_dir)
                except OSError as exc:
                    raise DocumentStorageError("无法保存上传的 PDF") from exc
                return deepcopy(metadata)
        except DocumentError:
            raise
        except OSError as exc:
            raise DocumentStorageError("无法接收上传的 PDF") from exc
        finally:
            if temporary_dir.exists():
                shutil.rmtree(temporary_dir, ignore_errors=True)

    def _matching_existing(
        self,
        directory: Path,
        sha256: str,
    ) -> dict[str, Any] | None:
        if not directory.is_dir() or directory.is_symlink():
            return None
        try:
            metadata = self._read_json(directory / "metadata.json")
            self._validate_metadata(metadata)
        except DocumentError:
            return None
        if metadata.get("sha256") != sha256:
            return None
        source = directory / "source.pdf"
        if not source.is_file() or source.is_symlink():
            return None
        try:
            self._verify_source_integrity(source, metadata)
        except DocumentError:
            return None
        return deepcopy(metadata)

    def get(self, document_id: str) -> dict[str, Any]:
        with self._lock:
            directory = self._document_dir(document_id)
            metadata = self._read_json(directory / "metadata.json")
            self._validate_metadata(metadata, expected_id=document_id)
            return deepcopy(metadata)

    def get_outline(self, document_id: str) -> dict[str, Any]:
        with self._lock:
            directory = self._document_dir(document_id)
            metadata = self._read_json(directory / "metadata.json")
            self._validate_metadata(metadata, expected_id=document_id)
            if metadata["status"] != "ready":
                raise DocumentNotReadyError(
                    f"文档纲要尚未就绪，当前状态：{metadata['status']}"
                )
            self._verify_source_integrity(directory / "source.pdf", metadata)
            outline = self._read_json(directory / "outline.json")
            self._validate_outline(outline, metadata)
            return deepcopy(outline)

    # ------------------------------------------------------------------
    # Parse lifecycle
    # ------------------------------------------------------------------

    def parse(
        self, document_id: str, *, parser: OutlineParser, parser_name: str | None = None
    ) -> dict[str, Any]:
        with self._lock:
            directory = self._document_dir(document_id)
            metadata = self._read_json(directory / "metadata.json")
            self._validate_metadata(metadata, expected_id=document_id)
            source_path = self._within_root(directory / "source.pdf")
            try:
                self._verify_source_integrity(source_path, metadata)
            except DocumentError as exc:
                # Never feed a replacement file to the parser under the old
                # upload identity.  Mark the document failed so retries see
                # the integrity problem instead of a stale ready state.
                self._record_failure(directory, metadata, exc)
                raise
            if metadata["status"] == "ready" and (
                parser_name is None or metadata.get("parser") == parser_name
            ):
                try:
                    outline = self._read_json(directory / "outline.json")
                    self._validate_outline(outline, metadata)
                    return {
                        "document": deepcopy(metadata),
                        "outline": deepcopy(outline),
                    }
                except (DocumentNotFoundError, DocumentValidationError):
                    # A missing/corrupt derived artifact is safe to regenerate.
                    pass
            if document_id in self._active_parses:
                raise DocumentConflictError("该文档正在解析，请稍后重试")
            self._active_parses.add(document_id)
            parsing_metadata = {
                **metadata,
                "status": "parsing",
                "updated_at": _now(),
                "parser": parser_name or LOCAL_PARSER_NAME,
                "error": None,
                "outline_summary": None,
            }
            try:
                self._write_json_atomic(directory / "metadata.json", parsing_metadata)
            except BaseException:
                # The parser try/finally below has not started yet.  Avoid
                # leaving a permanent in-memory lease after a storage error.
                self._active_parses.discard(document_id)
                raise

        try:
            self._verify_source_integrity(source_path, metadata)
            outline = parser(
                source_path,
                document_id=document_id,
                filename=str(metadata["filename"]),
                sha256=str(metadata["sha256"]),
                scan_pages=self.toc_scan_pages,
                executable=self.pdftotext_executable,
                timeout_seconds=self.parse_timeout_seconds,
            )
            self._validate_outline(outline, metadata)
            point_count = sum(len(chapter["points"]) for chapter in outline["chapters"])
            ready_metadata = {
                **metadata,
                "status": "ready",
                "updated_at": _now(),
                "parser": outline["source"]["parser"],
                "page_count": outline["source"]["page_count"],
                "error": None,
                "outline_summary": {
                    "title": outline["title"],
                    "chapter_count": len(outline["chapters"]),
                    "knowledge_point_count": point_count,
                },
            }
            with self._lock:
                self._write_json_atomic(directory / "outline.json", outline)
                self._write_json_atomic(directory / "metadata.json", ready_metadata)
            return {
                "document": deepcopy(ready_metadata),
                "outline": deepcopy(outline),
            }
        except (DocumentParserUnavailableError, DocumentParseError, DocumentValidationError) as exc:
            self._record_failure(directory, metadata, exc)
            raise
        except DocumentError as exc:
            self._record_failure(directory, metadata, exc)
            raise DocumentParseError("教材目录解析失败") from exc
        except Exception as exc:
            safe_error = DocumentParseError("教材目录解析失败")
            self._record_failure(directory, metadata, safe_error)
            raise safe_error from exc
        finally:
            with self._lock:
                self._active_parses.discard(document_id)

    @staticmethod
    def _verify_source_integrity(path: Path, metadata: dict[str, Any]) -> None:
        """Verify that the immutable source still matches its upload record."""

        if path.is_symlink() or not path.is_file():
            raise DocumentValidationError("原始 PDF 不存在或不可读取")
        expected_size = metadata.get("size_bytes")
        expected_sha256 = metadata.get("sha256")
        try:
            if path.stat().st_size != expected_size:
                raise DocumentValidationError("原始 PDF 大小与上传记录不一致")
            digest = hashlib.sha256()
            with path.open("rb") as source:
                while True:
                    chunk = source.read(_READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    digest.update(chunk)
        except DocumentError:
            raise
        except OSError as exc:
            raise DocumentValidationError("原始 PDF 不存在或不可读取") from exc
        if digest.hexdigest() != expected_sha256:
            raise DocumentValidationError("原始 PDF 摘要与上传记录不一致")

    def _record_failure(
        self,
        directory: Path,
        metadata: dict[str, Any],
        error: DocumentError,
    ) -> None:
        message = " ".join(str(error).split())[:500] or "教材目录解析失败"
        failed_metadata = {
            **metadata,
            "status": "failed",
            "updated_at": _now(),
            "parser": LOCAL_PARSER_NAME,
            "error": message,
            "outline_summary": None,
        }
        with self._lock:
            try:
                self._write_json_atomic(directory / "metadata.json", failed_metadata)
            except (DocumentStorageError, DocumentValidationError):
                pass

    # ------------------------------------------------------------------
    # Contract validation
    # ------------------------------------------------------------------

    def _validate_metadata(
        self,
        value: dict[str, Any],
        *,
        expected_id: str | None = None,
    ) -> None:
        required = {
            "schema_version",
            "id",
            "filename",
            "content_type",
            "size_bytes",
            "sha256",
            "status",
            "created_at",
            "updated_at",
            "parser",
            "page_count",
            "error",
            "outline_summary",
        }
        if set(value) != required:
            raise DocumentValidationError("文档元数据字段无效")
        document_id = value.get("id")
        if not isinstance(document_id, str) or not _DOCUMENT_ID_RE.fullmatch(document_id):
            raise DocumentValidationError("文档 ID 无效")
        if expected_id is not None and document_id != expected_id:
            raise DocumentValidationError("文档 ID 与存储记录不一致")
        if value.get("schema_version") != DOCUMENT_SCHEMA:
            raise DocumentValidationError("文档元数据版本不受支持")
        if value.get("content_type") != "application/pdf":
            raise DocumentValidationError("文档媒体类型无效")
        if not isinstance(value.get("filename"), str) or not value["filename"].strip():
            raise DocumentValidationError("文档文件名无效")
        if not _is_int(value.get("size_bytes")) or value["size_bytes"] <= 0:
            raise DocumentValidationError("文档大小无效")
        if not isinstance(value.get("sha256"), str) or not _SHA256_RE.fullmatch(value["sha256"]):
            raise DocumentValidationError("文档摘要无效")
        if value.get("status") not in _STATUSES:
            raise DocumentValidationError("文档状态无效")
        for field in ("created_at", "updated_at"):
            if not isinstance(value.get(field), str) or not value[field]:
                raise DocumentValidationError("文档时间戳无效")
        parser = value.get("parser")
        if parser is not None and (not isinstance(parser, str) or not parser.strip()):
            raise DocumentValidationError("文档解析器标识无效")
        page_count = value.get("page_count")
        if page_count is not None and (not _is_int(page_count) or page_count <= 0):
            raise DocumentValidationError("文档页数无效")
        error = value.get("error")
        if error is not None and not isinstance(error, str):
            raise DocumentValidationError("文档错误信息无效")
        summary = value.get("outline_summary")
        if summary is not None:
            if not isinstance(summary, dict) or set(summary) != {
                "title",
                "chapter_count",
                "knowledge_point_count",
            }:
                raise DocumentValidationError("文档纲要摘要无效")
            if not isinstance(summary["title"], str) or not summary["title"].strip():
                raise DocumentValidationError("文档纲要标题无效")
            if not _is_int(summary["chapter_count"]) or summary["chapter_count"] <= 0:
                raise DocumentValidationError("文档章节数无效")
            if (
                not _is_int(summary["knowledge_point_count"])
                or summary["knowledge_point_count"] <= 0
            ):
                raise DocumentValidationError("文档知识点数无效")

    def _validate_outline(
        self,
        value: Any,
        metadata: dict[str, Any],
    ) -> None:
        if not isinstance(value, dict) or set(value) != {
            "schema_version",
            "document_id",
            "title",
            "source",
            "chapters",
        }:
            raise DocumentValidationError("教材纲要根结构无效")
        if value.get("schema_version") != OUTLINE_SCHEMA:
            raise DocumentValidationError("教材纲要版本不受支持")
        if value.get("document_id") != metadata.get("id"):
            raise DocumentValidationError("教材纲要与文档 ID 不一致")
        if not isinstance(value.get("title"), str) or not value["title"].strip():
            raise DocumentValidationError("教材标题不能为空")

        source = value.get("source")
        if not isinstance(source, dict) or set(source) != {
            "filename",
            "sha256",
            "page_count",
            "parser",
            "toc_pages",
        }:
            raise DocumentValidationError("教材纲要来源信息无效")
        if source.get("filename") != metadata.get("filename"):
            raise DocumentValidationError("教材纲要文件名与文档不一致")
        if source.get("sha256") != metadata.get("sha256"):
            raise DocumentValidationError("教材纲要摘要与文档不一致")
        if not isinstance(source.get("parser"), str) or not source["parser"].strip():
            raise DocumentValidationError("教材纲要解析器标识无效")
        if not _is_int(source.get("page_count")) or source["page_count"] <= 0:
            raise DocumentValidationError("教材页数无效")
        if not _is_int(source.get("toc_pages")) or source["toc_pages"] <= 0:
            raise DocumentValidationError("教材目录扫描页数无效")

        chapters = value.get("chapters")
        if not isinstance(chapters, list) or not chapters:
            raise DocumentValidationError("教材纲要至少需要一个章节")
        if len(chapters) > 1000:
            raise DocumentValidationError("教材章节数量超过限制")

        chapter_ids: set[str] = set()
        chapter_numbers: set[str] = set()
        point_ids: set[str] = set()
        point_numbers: set[str] = set()
        point_count = 0
        for chapter_index, chapter in enumerate(chapters):
            if not isinstance(chapter, dict) or set(chapter) != {
                "id",
                "number",
                "title",
                "page",
                "order",
                "points",
            }:
                raise DocumentValidationError("教材章节结构无效")
            number = chapter.get("number")
            expected_id = f"chapter-{number}" if isinstance(number, str) else ""
            if not isinstance(number, str) or not _CHAPTER_NUMBER_RE.fullmatch(number):
                raise DocumentValidationError("教材章节编号无效")
            if chapter.get("id") != expected_id:
                raise DocumentValidationError("教材章节 ID 与编号不一致")
            if chapter["id"] in chapter_ids or number in chapter_numbers:
                raise DocumentValidationError("教材章节 ID 或编号重复")
            chapter_ids.add(chapter["id"])
            chapter_numbers.add(number)
            if not isinstance(chapter.get("title"), str) or not chapter["title"].strip():
                raise DocumentValidationError("教材章节标题不能为空")
            if chapter.get("order") != chapter_index:
                raise DocumentValidationError("教材章节顺序无效")
            self._validate_page(chapter.get("page"))
            points = chapter.get("points")
            if not isinstance(points, list):
                raise DocumentValidationError("教材知识点列表无效")
            for point_index, point in enumerate(points):
                if not isinstance(point, dict) or set(point) != {
                    "id",
                    "number",
                    "title",
                    "page",
                    "order",
                    "origin",
                }:
                    raise DocumentValidationError("教材知识点结构无效")
                point_number = point.get("number")
                if (
                    not isinstance(point_number, str)
                    or not _POINT_NUMBER_RE.fullmatch(point_number)
                    or not (
                        point_number == number
                        or point_number.startswith(f"{number}.")
                    )
                ):
                    raise DocumentValidationError("教材知识点编号无效")
                expected_point_id = f"point-{point_number.replace('.', '-')}"
                if point.get("id") != expected_point_id:
                    raise DocumentValidationError("教材知识点 ID 与编号不一致")
                if point["id"] in point_ids or point_number in point_numbers:
                    raise DocumentValidationError("教材知识点 ID 或编号重复")
                point_ids.add(point["id"])
                point_numbers.add(point_number)
                if not isinstance(point.get("title"), str) or not point["title"].strip():
                    raise DocumentValidationError("教材知识点标题不能为空")
                if point.get("order") != point_index:
                    raise DocumentValidationError("教材知识点顺序无效")
                if point.get("origin") != "textbook":
                    raise DocumentValidationError("教材知识点来源必须为 textbook")
                self._validate_page(point.get("page"))
                point_count += 1
                if point_count > 10000:
                    raise DocumentValidationError("教材知识点数量超过限制")
        if point_count == 0:
            raise DocumentValidationError("教材纲要至少需要一个知识点")

    @staticmethod
    def _validate_page(value: Any) -> None:
        if value is not None and (not _is_int(value) or value <= 0):
            raise DocumentValidationError("教材目录页码无效")


_document_store: DocumentStore | None = None
_document_store_lock = threading.Lock()


def get_document_store() -> DocumentStore:
    global _document_store
    with _document_store_lock:
        if _document_store is None:
            _document_store = DocumentStore()
        return _document_store
