"""Durable storage and lifecycle management for uploaded textbook documents."""

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
_PERMITTED_MARKDOWN_MEDIA_TYPES = frozenset(
    {
        "text/markdown",
        "text/x-markdown",
        "text/plain",
        "application/markdown",
        "application/octet-stream",
        "binary/octet-stream",
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
    """An upload's declared type, extension, encoding, or signature is invalid."""


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
    """Store immutable source documents and their retryable parse results."""

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

    def _write_bytes_atomic(self, path: Path, value: bytes) -> None:
        safe_path = self._within_root(path)
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        self._assert_path_chain(safe_path, allow_missing=True)
        if safe_path.exists() and safe_path.is_symlink():
            raise DocumentValidationError("文档数据目标不能是符号链接")
        temporary = safe_path.with_name(f".{safe_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write(value)
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

    def _source_path(self, directory: Path, metadata: dict[str, Any]) -> Path:
        filename = "source.md" if metadata.get("content_type") == "text/markdown" else "source.pdf"
        return self._within_root(directory / filename)

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
                        if existing.get("content_type") != "application/pdf":
                            raise DocumentConflictError("相同摘要已被另一种文档格式占用")
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

    def create_markdown_upload(
        self,
        stream: BinaryIO,
        *,
        filename: str | None,
        content_type: str | None,
    ) -> dict[str, Any]:
        """Persist one UTF-8 Markdown textbook under the document lifecycle.

        Markdown uses the same content-addressed ``document_id`` and parse
        endpoint as PDF so the rest of course creation does not need a second
        binding protocol.
        """

        media_type = str(content_type or "").split(";", 1)[0].strip().lower()
        if media_type and media_type not in _PERMITTED_MARKDOWN_MEDIA_TYPES:
            raise DocumentUnsupportedMediaTypeError(
                "上传声明的媒体类型不受支持；请上传 Markdown 文件"
            )
        safe_filename = _safe_filename(filename or "textbook.md")
        if Path(safe_filename).suffix.lower() not in {".md", ".markdown"}:
            raise DocumentUnsupportedMediaTypeError("Markdown 文件名必须以 .md 或 .markdown 结尾")

        temporary_dir = self._within_root(self.root / f".upload-{uuid.uuid4().hex}")
        source_path = temporary_dir / "source.md"
        digest = hashlib.sha256()
        size = 0
        content = bytearray()
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
                            f"Markdown 超过大小限制（最大 {self.max_upload_bytes} 字节）"
                        )
                    digest.update(chunk)
                    content.extend(chunk)
                    destination.write(chunk)
                destination.flush()
                os.fsync(destination.fileno())

            if size == 0:
                raise DocumentUnsupportedMediaTypeError("Markdown 文件不能为空")
            try:
                decoded = bytes(content).decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise DocumentUnsupportedMediaTypeError("Markdown 文件必须使用 UTF-8 编码") from exc
            if "\x00" in decoded:
                raise DocumentUnsupportedMediaTypeError("Markdown 文件包含无效的 NUL 字符")

            sha256 = digest.hexdigest()
            base_id = f"doc-{sha256[:24]}"
            timestamp = _now()
            metadata: dict[str, Any] = {
                "schema_version": DOCUMENT_SCHEMA,
                "id": base_id,
                "filename": safe_filename,
                "content_type": "text/markdown",
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
                        if existing.get("content_type") != "text/markdown":
                            raise DocumentConflictError("相同摘要已被另一种文档格式占用")
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
                    raise DocumentStorageError("无法保存上传的 Markdown") from exc
                return deepcopy(metadata)
        except DocumentError:
            raise
        except OSError as exc:
            raise DocumentStorageError("无法接收上传的 Markdown") from exc
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
        source = self._source_path(directory, metadata)
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

    def _validate_mineru_structure_cache(
        self,
        directory: Path,
        outline: dict[str, Any],
        metadata: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Validate the evidence sidecar before exposing a MinerU cache.

        A legacy parser callback may not have a raw directory at all; that
        remains compatible with unit tests. Once a real MinerU directory is
        present, however, a missing or stale structure candidate must never be
        exposed as a ready textbook.
        """

        parser_name = str(outline.get("source", {}).get("parser", ""))
        if not parser_name.startswith("mineru-"):
            return None
        raw_directory = self._within_root(directory / parser_name)
        if not raw_directory.exists():
            return None
        if raw_directory.is_symlink():
            raise DocumentValidationError("MinerU 原始结果目录不允许符号链接")
        raw_content_path = self._within_root(raw_directory / "content-list.json")
        candidate_path = self._within_root(raw_directory / "structure-candidate.json")
        raw_markdown_path = self._within_root(raw_directory / "full.md")
        # A few legacy parser adapters persist only ``full.md`` under a
        # MinerU-named directory.  That is not enough evidence to validate a
        # real MinerU parse, but it is still a valid hand-written test cache.
        # Treat the directory as legacy until a raw content-list is present;
        # once content-list.json exists, enforce the complete evidence bundle.
        if not raw_content_path.exists():
            return None
        if (
            not raw_content_path.is_file()
            or raw_content_path.is_symlink()
            or not candidate_path.is_file()
            or candidate_path.is_symlink()
            or not raw_markdown_path.is_file()
            or raw_markdown_path.is_symlink()
        ):
            raise DocumentValidationError(
                "MinerU 缓存缺少结构候选或原始证据，需要重新解析"
            )
        from .structure_candidates import (
            StructureCandidateError,
            validate_structure_candidate,
        )

        try:
            if raw_content_path.stat().st_size > _MAX_JSON_BYTES:
                raise DocumentValidationError("MinerU content-list 文件过大")
            raw_content = json.loads(raw_content_path.read_text(encoding="utf-8-sig"))
            candidate = self._read_json(candidate_path)
            if not isinstance(candidate, dict):
                raise DocumentValidationError("MinerU 结构候选必须是 JSON 对象")
            raw_markdown = raw_markdown_path.read_text(encoding="utf-8-sig")
            diagnostics = candidate.get("diagnostics")
            if not isinstance(diagnostics, dict) or not diagnostics.get("markdown_sha256") or not diagnostics.get("content_sha256"):
                raise DocumentValidationError("MinerU 结构候选缺少原始产物摘要")
            validate_structure_candidate(
                candidate,
                raw_content,
                raw_markdown,
                page_count=int(outline["source"]["page_count"]),
            )
        except (OSError, UnicodeError, json.JSONDecodeError, StructureCandidateError) as exc:
            raise DocumentValidationError(
                "MinerU 缓存原始证据或结构候选无效，需要重新解析"
            ) from exc
        if candidate.get("diagnostics", {}).get("needs_review"):
            raise DocumentValidationError(
                "MinerU 缓存中的结构候选仍需审核，需要重新解析"
            )
        outline_chapters = outline.get("chapters", [])
        candidate_chapters = candidate.get("chapters", [])
        if [str(chapter["number"]) for chapter in outline_chapters] != [
            str(chapter["number"]) for chapter in candidate_chapters
        ] or [str(chapter["title"]) for chapter in outline_chapters] != [
            str(chapter["title"]) for chapter in candidate_chapters
        ]:
            raise DocumentValidationError(
                "MinerU 缓存目录与结构候选不一致，需要重新解析"
            )
        return candidate

    def get_outline(self, document_id: str) -> dict[str, Any]:
        with self._lock:
            directory = self._document_dir(document_id)
            metadata = self._read_json(directory / "metadata.json")
            self._validate_metadata(metadata, expected_id=document_id)
            if metadata["status"] != "ready":
                raise DocumentNotReadyError(
                    f"文档纲要尚未就绪，当前状态：{metadata['status']}"
                )
            self._verify_source_integrity(self._source_path(directory, metadata), metadata)
            outline = self._read_json(directory / "outline.json")
            self._validate_outline(outline, metadata)
            self._validate_mineru_structure_cache(directory, outline, metadata)
            return deepcopy(outline)

    def get_material(self, document_id: str) -> dict[str, Any]:
        """Return the normalized Markdown evidence map for a ready document."""

        with self._lock:
            directory = self._document_dir(document_id)
            metadata = self._read_json(directory / "metadata.json")
            self._validate_metadata(metadata, expected_id=document_id)
            if metadata["status"] != "ready":
                raise DocumentNotReadyError(
                    f"文档正文材料尚未就绪，当前状态：{metadata['status']}"
                )
            self._verify_source_integrity(self._source_path(directory, metadata), metadata)
            outline = self._read_json(directory / "outline.json")
            self._validate_outline(outline, metadata)
            self._validate_mineru_structure_cache(directory, outline, metadata)
            material = self._read_json(directory / "material.json")
            self._validate_material(material, metadata)
            return deepcopy(material)

    def get_markdown(self, document_id: str) -> str:
        """Return the canonical Markdown text referenced by material.json."""

        with self._lock:
            directory = self._document_dir(document_id)
            metadata = self._read_json(directory / "metadata.json")
            self._validate_metadata(metadata, expected_id=document_id)
            if metadata["status"] != "ready":
                raise DocumentNotReadyError(
                    f"文档 Markdown 尚未就绪，当前状态：{metadata['status']}"
                )
            self._verify_source_integrity(self._source_path(directory, metadata), metadata)
            outline = self._read_json(directory / "outline.json")
            self._validate_outline(outline, metadata)
            self._validate_mineru_structure_cache(directory, outline, metadata)
            material = self._read_json(directory / "material.json")
            self._validate_material(material, metadata)
            markdown_path = self._within_root(directory / "full.md")
            if not markdown_path.is_file() or markdown_path.is_symlink():
                raise DocumentNotFoundError("文档 Markdown 不存在")
            try:
                content = markdown_path.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as exc:
                raise DocumentValidationError("文档 Markdown 无法读取") from exc
            digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
            if digest != material["markdown"]["sha256"]:
                raise DocumentValidationError("文档 Markdown 摘要与材料索引不一致")
            return content

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
            # Keep the parser identity selected for this attempt available to
            # every failure path.  ``metadata`` still contains the parser from
            # the previous lifecycle state (or no parser for a fresh upload),
            # so using it alone would incorrectly label a MinerU failure as
            # ``local-pdftotext``.
            requested_parser_name = parser_name or metadata.get("parser")
            effective_parser_name = (
                requested_parser_name.strip()
                if isinstance(requested_parser_name, str)
                and requested_parser_name.strip()
                else LOCAL_PARSER_NAME
            )
            source_path = self._source_path(directory, metadata)
            try:
                self._verify_source_integrity(source_path, metadata)
            except DocumentError as exc:
                # Never feed a replacement file to the parser under the old
                # upload identity.  Mark the document failed so retries see
                # the integrity problem instead of a stale ready state.
                self._record_failure(
                    directory,
                    metadata,
                    exc,
                    parser_name=effective_parser_name,
                )
                raise
            if metadata["status"] == "ready" and (
                parser_name is None or metadata.get("parser") == parser_name
            ):
                try:
                    outline = self._read_json(directory / "outline.json")
                    self._validate_outline(outline, metadata)
                    self._validate_mineru_structure_cache(directory, outline, metadata)
                    if str(outline.get("source", {}).get("parser", "")).startswith("mineru-"):
                        # Older MinerU parses could leave a valid outline and
                        # valid material whose point ID sets came from
                        # different parsers. Treat that as stale derived data
                        # so an explicit parse request repairs it instead of
                        # returning the inconsistent cache.
                        material_path = directory / "material.json"
                        if material_path.is_file():
                            material = self._read_json(material_path)
                            self._validate_material(material, metadata)
                            outline_point_ids = {
                                str(point["id"])
                                for chapter in outline.get("chapters", [])
                                if isinstance(chapter, dict)
                                for point in chapter.get("points", [])
                                if isinstance(point, dict) and isinstance(point.get("id"), str)
                            }
                            material_point_ids = {
                                str(item["point_id"])
                                for item in material.get("point_sources", [])
                                if isinstance(item, dict) and isinstance(item.get("point_id"), str)
                            }
                            if outline_point_ids != material_point_ids:
                                raise DocumentValidationError(
                                    "MinerU outline and material point IDs are inconsistent"
                                )
                        parser_name_value = str(outline.get("source", {}).get("parser", ""))
                        raw_directory = self._within_root(directory / parser_name_value)
                        # Hand-written parser adapters used by legacy tests do
                        # not persist a raw MinerU directory. Keep their valid
                        # cache behavior; real MinerU output always has this
                        # directory and therefore goes through the evidence
                        # freshness checks below.
                        if not raw_directory.exists():
                            return {
                                "document": deepcopy(metadata),
                                "outline": deepcopy(outline),
                            }
                        raw_content_path = self._within_root(raw_directory / "content-list.json")
                        candidate_path = self._within_root(raw_directory / "structure-candidate.json")
                        raw_markdown_path = self._within_root(raw_directory / "full.md")
                        if not raw_content_path.exists():
                            return {
                                "document": deepcopy(metadata),
                                "outline": deepcopy(outline),
                            }
                        if (
                            not raw_content_path.is_file()
                            or raw_content_path.is_symlink()
                            or not candidate_path.is_file()
                            or candidate_path.is_symlink()
                            or not raw_markdown_path.is_file()
                            or raw_markdown_path.is_symlink()
                        ):
                            raise DocumentValidationError(
                                "MinerU 缓存缺少结构候选或原始证据，需要重新解析"
                            )
                        from .structure_candidates import (
                            StructureCandidateError,
                            validate_structure_candidate,
                        )

                        try:
                            raw_content = json.loads(
                                raw_content_path.read_text(encoding="utf-8-sig")
                            )
                            candidate = self._read_json(candidate_path)
                            raw_markdown = raw_markdown_path.read_text(encoding="utf-8-sig")
                            validate_structure_candidate(
                                candidate,
                                raw_content,
                                raw_markdown,
                                page_count=int(outline["source"]["page_count"]),
                            )
                        except (OSError, UnicodeError, json.JSONDecodeError, StructureCandidateError) as exc:
                            raise DocumentValidationError(
                                "MinerU 缓存原始证据或结构候选无效，需要重新解析"
                            ) from exc
                        if candidate.get("diagnostics", {}).get("needs_review"):
                            raise DocumentValidationError(
                                "MinerU 缓存中的结构候选仍需审核，需要重新解析"
                            )
                        if [str(chapter["number"]) for chapter in outline["chapters"]] != [
                            str(chapter["number"]) for chapter in candidate["chapters"]
                        ]:
                            raise DocumentValidationError(
                                "MinerU 缓存目录与结构候选不一致，需要重新解析"
                            )
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
                "parser": effective_parser_name,
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
            parsed = parser(
                source_path,
                document_id=document_id,
                filename=str(metadata["filename"]),
                sha256=str(metadata["sha256"]),
                scan_pages=self.toc_scan_pages,
                executable=self.pdftotext_executable,
                timeout_seconds=self.parse_timeout_seconds,
            )
            material: dict[str, Any] | None = None
            markdown: str | None = None
            if (
                isinstance(parsed, dict)
                and isinstance(parsed.get("outline"), dict)
                and isinstance(parsed.get("material"), dict)
            ):
                outline = parsed["outline"]
                material = parsed["material"]
                markdown_value = parsed.get("markdown")
                if not isinstance(markdown_value, str):
                    raise DocumentValidationError("Markdown 解析器没有返回规范化正文")
                markdown = markdown_value
            else:
                outline = parsed

            # MinerU already persists full.md beside its raw result. Promote a
            # normalized evidence map into the document root so later stages
            # use the same contract as direct Markdown imports.  When the raw
            # Content List is available, the evidence-checked structure
            # candidate is authoritative; the native TOC is never silently
            # replaced by an unrelated Markdown-derived outline.
            if material is None and str(outline.get("source", {}).get("parser", "")).startswith("mineru-"):
                from .markdown_parser import build_markdown_artifacts
                from .mineru_artifacts import build_mineru_markdown_artifacts
                from .structure_candidates import (
                    StructureCandidateError,
                    build_mineru_structure_candidate,
                    merge_structure_proposal,
                    validate_structure_candidate,
                )
                from .structure_llm import (
                    StructureLLMError,
                    propose_structure,
                    structure_llm_mode,
                )

                parser_directory = directory / str(outline["source"]["parser"])
                raw_markdown_path = self._within_root(parser_directory / "full.md")
                if raw_markdown_path.is_file() and not raw_markdown_path.is_symlink():
                    try:
                        markdown = raw_markdown_path.read_text(encoding="utf-8-sig")
                    except (OSError, UnicodeError) as exc:
                        raise DocumentValidationError("MinerU Markdown 无法读取") from exc
                    markdown = markdown.replace("\r\n", "\n").replace("\r", "\n")
                    raw_content_path = self._within_root(parser_directory / "content-list.json")
                    candidate_path = self._within_root(parser_directory / "structure-candidate.json")
                    candidate: dict[str, Any] | None = None
                    if raw_content_path.is_file() and not raw_content_path.is_symlink():
                        try:
                            if raw_content_path.stat().st_size > _MAX_JSON_BYTES:
                                raise DocumentValidationError(
                                    "MinerU content-list 文件过大"
                                )
                            raw_content = json.loads(
                                raw_content_path.read_text(encoding="utf-8-sig")
                            )
                            if not isinstance(raw_content, (list, dict)):
                                raise DocumentValidationError(
                                    "MinerU content-list 格式无效"
                                )
                            if candidate_path.is_file() and not candidate_path.is_symlink():
                                candidate = self._read_json(candidate_path)
                            if not isinstance(candidate, dict) or not isinstance(
                                candidate.get("diagnostics"), dict
                            ) or not candidate["diagnostics"].get("markdown_sha256") or not candidate["diagnostics"].get("content_sha256"):
                                candidate = build_mineru_structure_candidate(
                                    raw_content,
                                    markdown,
                                    page_count=int(outline["source"]["page_count"]),
                                )
                            validate_structure_candidate(
                                candidate,
                                raw_content,
                                markdown,
                                page_count=int(outline["source"]["page_count"]),
                            )
                        except (OSError, UnicodeError, StructureCandidateError, DocumentValidationError) as exc:
                            raise DocumentValidationError(
                                "MinerU 结构候选无法通过原始证据校验"
                            ) from exc

                        mode = structure_llm_mode()
                        if mode == "required" or bool(
                            candidate.get("diagnostics", {}).get("needs_review")
                        ) and mode == "auto":
                            try:
                                proposal = propose_structure(
                                    candidate,
                                    model=None,
                                    enabled=True,
                                    required=mode == "required",
                                )
                            except StructureLLMError as exc:
                                raise DocumentValidationError(
                                    "MinerU 结构模型调用失败，未生成教材目录"
                                ) from exc
                            if proposal is None:
                                raise DocumentValidationError(
                                    "MinerU 结构存在歧义，未获得有效的结构模型提案"
                                )
                            try:
                                candidate = merge_structure_proposal(
                                    candidate,
                                    proposal,
                                    raw_content,
                                    page_count=int(outline["source"]["page_count"]),
                                )
                            except StructureCandidateError as exc:
                                raise DocumentValidationError(
                                    "MinerU 结构模型提案未通过证据校验"
                                ) from exc
                        if candidate.get("diagnostics", {}).get("needs_review"):
                            raise DocumentValidationError(
                                "MinerU 结构仍存在歧义，未生成教材目录"
                            )
                        outline, material = build_mineru_markdown_artifacts(
                            markdown,
                            candidate,
                            document_id=document_id,
                            filename=str(metadata["filename"]),
                            sha256=str(metadata["sha256"]),
                            parser_name=str(outline["source"]["parser"]),
                            page_count=int(outline["source"]["page_count"]),
                            toc_pages=int(outline["source"]["toc_pages"]),
                        )
                        self._write_json_atomic(candidate_path, candidate)
                    else:
                        # Older hand-written test adapters may not provide a
                        # Content List. They must still produce a matching
                        # Markdown material map; an ID mismatch is an error,
                        # never a reason to overwrite the native outline.
                        derived_outline, material = build_markdown_artifacts(
                            markdown,
                            document_id=document_id,
                            filename=str(metadata["filename"]),
                            sha256=str(metadata["sha256"]),
                            parser_name=str(outline["source"]["parser"]),
                        )
                        outline_point_ids = {
                            str(point["id"])
                            for chapter in outline.get("chapters", [])
                            if isinstance(chapter, dict)
                            for point in chapter.get("points", [])
                            if isinstance(point, dict) and isinstance(point.get("id"), str)
                        }
                        material_point_ids = {
                            str(item["point_id"])
                            for item in material.get("point_sources", [])
                            if isinstance(item, dict) and isinstance(item.get("point_id"), str)
                        }
                        if outline_point_ids != material_point_ids:
                            raise DocumentValidationError(
                                "MinerU 原始目录与 Markdown 教材点不一致；缺少 content-list 证据，拒绝自动覆盖"
                            )
            self._validate_outline(outline, metadata)
            if material is not None:
                self._validate_material(material, metadata)
                if markdown is None:
                    raise DocumentValidationError("教材材料缺少 Markdown 正文")
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
                if material is not None and markdown is not None:
                    self._write_bytes_atomic(directory / "full.md", markdown.encode("utf-8"))
                    self._write_json_atomic(directory / "material.json", material)
                self._write_json_atomic(directory / "metadata.json", ready_metadata)
            return {
                "document": deepcopy(ready_metadata),
                "outline": deepcopy(outline),
            }
        except (DocumentParserUnavailableError, DocumentParseError, DocumentValidationError) as exc:
            self._record_failure(
                directory,
                metadata,
                exc,
                parser_name=effective_parser_name,
            )
            raise
        except DocumentError as exc:
            self._record_failure(
                directory,
                metadata,
                exc,
                parser_name=effective_parser_name,
            )
            raise DocumentParseError("教材目录解析失败") from exc
        except Exception as exc:
            safe_error = DocumentParseError("教材目录解析失败")
            self._record_failure(
                directory,
                metadata,
                safe_error,
                parser_name=effective_parser_name,
            )
            raise safe_error from exc
        finally:
            with self._lock:
                self._active_parses.discard(document_id)

    @staticmethod
    def _verify_source_integrity(path: Path, metadata: dict[str, Any]) -> None:
        """Verify that the immutable source still matches its upload record."""

        source_label = (
            "原始 PDF"
            if metadata.get("content_type") == "application/pdf"
            else "原始 Markdown"
        )
        if path.is_symlink() or not path.is_file():
            raise DocumentValidationError(f"{source_label} 不存在或不可读取")
        expected_size = metadata.get("size_bytes")
        expected_sha256 = metadata.get("sha256")
        try:
            if path.stat().st_size != expected_size:
                raise DocumentValidationError(f"{source_label} 大小与上传记录不一致")
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
            raise DocumentValidationError(f"{source_label} 不存在或不可读取") from exc
        if digest.hexdigest() != expected_sha256:
            raise DocumentValidationError(f"{source_label} 摘要与上传记录不一致")

    def _record_failure(
        self,
        directory: Path,
        metadata: dict[str, Any],
        error: DocumentError,
        *,
        parser_name: str | None = None,
    ) -> None:
        message = " ".join(str(error).split())[:500] or "教材目录解析失败"
        selected_parser = parser_name or metadata.get("parser") or LOCAL_PARSER_NAME
        if not isinstance(selected_parser, str) or not selected_parser.strip():
            selected_parser = LOCAL_PARSER_NAME
        failed_metadata = {
            **metadata,
            "status": "failed",
            "updated_at": _now(),
            "parser": selected_parser,
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
        if value.get("content_type") not in {"application/pdf", "text/markdown"}:
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
        if metadata.get("content_type") == "text/markdown":
            if source.get("page_count") is not None or source.get("toc_pages") is not None:
                raise DocumentValidationError("Markdown 教材不应伪造 PDF 页数")
        else:
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
                required_point_fields = {
                    "id",
                    "number",
                    "title",
                    "page",
                    "order",
                    "origin",
                }
                allowed_point_fields = required_point_fields | {"source_refs"}
                if (
                    not isinstance(point, dict)
                    or not required_point_fields.issubset(point)
                    or not set(point).issubset(allowed_point_fields)
                ):
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
                source_refs = point.get("source_refs")
                if source_refs is not None and (
                    not isinstance(source_refs, list)
                    or not source_refs
                    or len(set(source_refs)) != len(source_refs)
                    or any(
                        not isinstance(item, str)
                        or not re.fullmatch(r"block-[0-9]{6}", item)
                        for item in source_refs
                    )
                ):
                    raise DocumentValidationError("教材知识点 source_refs 无效")
                self._validate_page(point.get("page"))
                point_count += 1
                if point_count > 10000:
                    raise DocumentValidationError("教材知识点数量超过限制")
        if point_count == 0:
            raise DocumentValidationError("教材纲要至少需要一个知识点")

    def _validate_material(self, value: Any, metadata: dict[str, Any]) -> None:
        from .markdown_parser import MATERIAL_SCHEMA

        required = {
            "schema_version",
            "document_id",
            "source",
            "markdown",
            "sections",
            "chunks",
            "point_sources",
        }
        if not isinstance(value, dict) or set(value) != required:
            raise DocumentValidationError("教材正文材料根结构无效")
        if value.get("schema_version") != MATERIAL_SCHEMA:
            raise DocumentValidationError("教材正文材料版本不受支持")
        if value.get("document_id") != metadata.get("id"):
            raise DocumentValidationError("教材正文材料与文档 ID 不一致")
        source = value.get("source")
        if not isinstance(source, dict) or set(source) != {
            "format", "filename", "sha256", "parser",
        }:
            raise DocumentValidationError("教材正文材料来源无效")
        if (
            source.get("format") != "markdown"
            or source.get("filename") != metadata.get("filename")
            or source.get("sha256") != metadata.get("sha256")
            or not isinstance(source.get("parser"), str)
            or not source["parser"].strip()
        ):
            raise DocumentValidationError("教材正文材料来源与文档不一致")

        markdown = value.get("markdown")
        if not isinstance(markdown, dict) or set(markdown) != {
            "path", "sha256", "line_count", "character_count",
        }:
            raise DocumentValidationError("教材 Markdown 描述无效")
        if markdown.get("path") != "full.md" or not _SHA256_RE.fullmatch(
            str(markdown.get("sha256") or "")
        ):
            raise DocumentValidationError("教材 Markdown 路径或摘要无效")
        line_count = markdown.get("line_count")
        character_count = markdown.get("character_count")
        if not _is_int(line_count) or line_count <= 0:
            raise DocumentValidationError("教材 Markdown 行数无效")
        if not _is_int(character_count) or character_count <= 0:
            raise DocumentValidationError("教材 Markdown 字符数无效")

        sections = value.get("sections")
        chunks = value.get("chunks")
        point_sources = value.get("point_sources")
        if not isinstance(sections, list) or not sections:
            raise DocumentValidationError("教材正文材料至少需要一个 section")
        if not isinstance(chunks, list) or not chunks:
            raise DocumentValidationError("教材正文材料至少需要一个 chunk")
        if not isinstance(point_sources, list) or not point_sources:
            raise DocumentValidationError("教材正文材料至少需要一个 point_sources 项")

        section_ids: set[str] = set()
        for index, section in enumerate(sections):
            if not isinstance(section, dict) or set(section) != {
                "id", "order", "type", "title", "heading_level",
                "heading_path", "line_start", "line_end", "page",
                "asset_refs", "sha256",
            }:
                raise DocumentValidationError("教材 section 结构无效")
            section_id = section.get("id")
            if (
                not isinstance(section_id, str)
                or not re.fullmatch(r"block-[0-9]{6}", section_id)
                or section_id in section_ids
                or section.get("order") != index
                or section.get("type") != "section"
            ):
                raise DocumentValidationError("教材 section 标识或顺序无效")
            section_ids.add(section_id)
            self._validate_material_locator(section, line_count, "section")

        chunk_ids: set[str] = set()
        for index, chunk in enumerate(chunks):
            if not isinstance(chunk, dict) or set(chunk) != {
                "id", "order", "section_ids", "heading_path", "line_start",
                "line_end", "page", "asset_refs", "sha256",
            }:
                raise DocumentValidationError("教材 chunk 结构无效")
            chunk_id = chunk.get("id")
            refs = chunk.get("section_ids")
            if (
                not isinstance(chunk_id, str)
                or not re.fullmatch(r"chunk-[0-9]{6}", chunk_id)
                or chunk_id in chunk_ids
                or chunk.get("order") != index
                or not isinstance(refs, list)
                or not refs
                or len(set(refs)) != len(refs)
                or any(ref not in section_ids for ref in refs)
            ):
                raise DocumentValidationError("教材 chunk 标识、顺序或 section 引用无效")
            chunk_ids.add(chunk_id)
            self._validate_material_locator(chunk, line_count, "chunk")

        seen_points: set[str] = set()
        for item in point_sources:
            if not isinstance(item, dict) or set(item) != {
                "point_id", "section_ids", "chunk_ids",
            }:
                raise DocumentValidationError("教材 point_sources 结构无效")
            point_id = item.get("point_id")
            section_refs = item.get("section_ids")
            chunk_refs = item.get("chunk_ids")
            if (
                not isinstance(point_id, str)
                or not re.fullmatch(r"point-[0-9]+(?:-[0-9]+)*", point_id)
                or point_id in seen_points
                or not isinstance(section_refs, list)
                or not section_refs
                or len(set(section_refs)) != len(section_refs)
                or any(ref not in section_ids for ref in section_refs)
                or not isinstance(chunk_refs, list)
                or not chunk_refs
                or len(set(chunk_refs)) != len(chunk_refs)
                or any(ref not in chunk_ids for ref in chunk_refs)
            ):
                raise DocumentValidationError("教材 point_sources 引用无效")
            seen_points.add(point_id)

    @staticmethod
    def _validate_material_locator(value: dict[str, Any], line_count: int, label: str) -> None:
        heading_path = value.get("heading_path")
        assets = value.get("asset_refs")
        if (
            not isinstance(heading_path, list)
            or not heading_path
            or any(not isinstance(item, str) or not item.strip() for item in heading_path)
            or not isinstance(assets, list)
            or len(set(assets)) != len(assets)
            or any(not isinstance(item, str) or not item.strip() for item in assets)
            or not _is_int(value.get("line_start"))
            or not _is_int(value.get("line_end"))
            or not 1 <= value["line_start"] <= value["line_end"] <= line_count
            or not _SHA256_RE.fullmatch(str(value.get("sha256") or ""))
        ):
            raise DocumentValidationError(f"教材 {label} 正文定位无效")
        page = value.get("page")
        if page is not None and (not _is_int(page) or page <= 0):
            raise DocumentValidationError(f"教材 {label} 页码无效")
        if label == "section":
            if not isinstance(value.get("title"), str) or not value["title"].strip():
                raise DocumentValidationError("教材 section 标题无效")
            if not _is_int(value.get("heading_level")) or not 1 <= value["heading_level"] <= 6:
                raise DocumentValidationError("教材 section 标题层级无效")

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
