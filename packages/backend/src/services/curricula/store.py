"""Durable storage for uploaded curriculum and syllabus guidance files."""

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
from typing import Any, BinaryIO

from ...config import settings
from ..documents.store import DocumentError
from .parser import (
    CurriculumParseError,
    CurriculumParserUnavailableError,
    PARSER_NAME,
    REQUIREMENTS_SCHEMA,
    parse_curriculum_document,
    validate_docx_archive,
)


CURRICULUM_SCHEMA = "curriculum-import/1.0"
_ID_RE = re.compile(r"^curr-[0-9a-f]{24}$")
_STATUSES = frozenset({"uploaded", "parsing", "ready", "failed"})
_READ_CHUNK_BYTES = 1024 * 1024
_MAX_JSON_BYTES = 16 * 1024 * 1024
_PDF_MEDIA_TYPES = frozenset(
    {"", "application/pdf", "application/x-pdf", "application/octet-stream", "binary/octet-stream"}
)
_DOCX_MEDIA_TYPES = frozenset(
    {
        "",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/octet-stream",
        "binary/octet-stream",
    }
)
_PDF_CONTENT_TYPE = "application/pdf"
_DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class CurriculumError(DocumentError):
    """Base class for safe, user-facing curriculum service errors."""


class CurriculumNotFoundError(CurriculumError):
    pass


class CurriculumConflictError(CurriculumError):
    pass


class CurriculumUnsupportedMediaTypeError(CurriculumError):
    pass


class CurriculumTooLargeError(CurriculumError):
    pass


class CurriculumStorageError(CurriculumError):
    pass


class CurriculumValidationError(CurriculumError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe_filename(value: str | None) -> str:
    raw = str(value or "curriculum.pdf").replace("\\", "/").split("/")[-1]
    cleaned = "".join(ch for ch in raw if ch >= " " and ch != "\x7f").strip()
    if not cleaned:
        cleaned = "curriculum.pdf"
    if len(cleaned) > 240:
        suffix = Path(cleaned).suffix[-16:]
        cleaned = cleaned[: 240 - len(suffix)].rstrip() + suffix
    return cleaned


def _json_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


class CurriculumStore:
    def __init__(
        self,
        root: Path | None = None,
        *,
        max_upload_bytes: int | None = None,
        parse_timeout_seconds: float | None = None,
        pdftotext_executable: str | None = None,
    ):
        default_root = settings.document_library_dir.parent / "curriculum_library"
        self.root = Path(root or default_root).absolute()
        self.max_upload_bytes = int(
            max_upload_bytes
            if max_upload_bytes is not None
            else settings.document_max_upload_bytes
        )
        self.parse_timeout_seconds = float(
            parse_timeout_seconds
            if parse_timeout_seconds is not None
            else settings.document_parse_timeout_seconds
        )
        self.pdftotext_executable = str(
            pdftotext_executable
            if pdftotext_executable is not None
            else settings.document_pdftotext_executable
        )
        if self.max_upload_bytes <= 0 or self.parse_timeout_seconds <= 0:
            raise ValueError("curriculum store limits must be positive")
        try:
            self.root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise CurriculumStorageError("培养方案存储目录不可用") from exc
        if not self.root.is_dir() or self.root.is_symlink():
            raise CurriculumStorageError("培养方案存储目录不可用")
        self._lock = threading.RLock()
        self._active_parses: set[str] = set()

    def _directory(self, document_id: str, *, required: bool = True) -> Path:
        if not isinstance(document_id, str) or not _ID_RE.fullmatch(document_id):
            raise CurriculumNotFoundError("培养方案不存在")
        directory = self.root / document_id
        try:
            absolute = directory.absolute()
            absolute.relative_to(self.root)
        except (OSError, ValueError) as exc:
            raise CurriculumNotFoundError("培养方案不存在") from exc
        if required and (not absolute.is_dir() or absolute.is_symlink()):
            raise CurriculumNotFoundError(f"培养方案不存在：{document_id}")
        return absolute

    def _read_json(self, path: Path) -> dict[str, Any]:
        if not path.is_file() or path.is_symlink():
            raise CurriculumNotFoundError("培养方案数据不存在")
        try:
            if path.stat().st_size > _MAX_JSON_BYTES:
                raise CurriculumValidationError("培养方案数据文件过大")
            value = json.loads(path.read_text(encoding="utf-8"))
        except CurriculumError:
            raise
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise CurriculumValidationError("培养方案数据损坏") from exc
        if not isinstance(value, dict):
            raise CurriculumValidationError("培养方案数据格式无效")
        return value

    @staticmethod
    def _write_bytes_atomic(path: Path, value: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write(value)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except OSError as exc:
            raise CurriculumStorageError("无法保存培养方案数据") from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def _write_json_atomic(self, path: Path, value: dict[str, Any]) -> None:
        self._write_bytes_atomic(path, _json_bytes(value))

    @staticmethod
    def _normalized_media(filename: str, content_type: str | None) -> tuple[str, str]:
        suffix = Path(filename).suffix.lower()
        media_type = str(content_type or "").split(";", 1)[0].strip().lower()
        if suffix == ".doc":
            raise CurriculumUnsupportedMediaTypeError(
                "暂不支持旧版 .doc；请另存为 DOCX 或 PDF 后上传"
            )
        if suffix == ".pdf":
            if media_type not in _PDF_MEDIA_TYPES:
                raise CurriculumUnsupportedMediaTypeError("上传文件不是受支持的 PDF")
            return _PDF_CONTENT_TYPE, "source.pdf"
        if suffix == ".docx":
            if media_type not in _DOCX_MEDIA_TYPES:
                raise CurriculumUnsupportedMediaTypeError("上传文件不是受支持的 DOCX")
            return _DOCX_CONTENT_TYPE, "source.docx"
        raise CurriculumUnsupportedMediaTypeError("培养方案仅支持 PDF 或 DOCX 文件")

    def create_upload(
        self,
        stream: BinaryIO,
        *,
        filename: str | None,
        content_type: str | None,
    ) -> dict[str, Any]:
        safe_filename = _safe_filename(filename)
        normalized_type, source_name = self._normalized_media(safe_filename, content_type)
        temporary = self.root / f".upload-{uuid.uuid4().hex}"
        source_path = temporary / source_name
        digest = hashlib.sha256()
        size = 0
        signature = bytearray()
        try:
            temporary.mkdir(parents=False, exist_ok=False)
            with source_path.open("xb") as destination:
                while True:
                    chunk = stream.read(_READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    if not isinstance(chunk, (bytes, bytearray)):
                        raise CurriculumValidationError("上传流返回了无效数据")
                    size += len(chunk)
                    if size > self.max_upload_bytes:
                        raise CurriculumTooLargeError(
                            f"培养方案超过 {self.max_upload_bytes} 字节限制"
                        )
                    if len(signature) < 8:
                        signature.extend(chunk[: 8 - len(signature)])
                    digest.update(chunk)
                    destination.write(chunk)
                destination.flush()
                os.fsync(destination.fileno())
            if size <= 0:
                raise CurriculumValidationError("培养方案文件为空")
            if normalized_type == _PDF_CONTENT_TYPE and not bytes(signature).startswith(b"%PDF-"):
                raise CurriculumUnsupportedMediaTypeError("文件扩展名为 PDF，但内容不是有效 PDF")
            if normalized_type == _DOCX_CONTENT_TYPE:
                if not bytes(signature).startswith(b"PK"):
                    raise CurriculumUnsupportedMediaTypeError("文件扩展名为 DOCX，但内容不是 ZIP/OOXML")
                try:
                    validate_docx_archive(source_path)
                except CurriculumParseError as exc:
                    raise CurriculumUnsupportedMediaTypeError(str(exc)) from exc

            document_id = f"curr-{uuid.uuid4().hex[:24]}"
            destination = self._directory(document_id, required=False)
            timestamp = _now()
            metadata = {
                "schema_version": CURRICULUM_SCHEMA,
                "id": document_id,
                "filename": safe_filename,
                "content_type": normalized_type,
                "size_bytes": size,
                "sha256": digest.hexdigest(),
                "status": "uploaded",
                "parser": None,
                "requirements_summary": None,
                "error": None,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
            self._write_json_atomic(temporary / "metadata.json", metadata)
            os.replace(temporary, destination)
            return deepcopy(metadata)
        except CurriculumError:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        except OSError as exc:
            shutil.rmtree(temporary, ignore_errors=True)
            raise CurriculumStorageError("无法保存培养方案上传") from exc

    def get(self, document_id: str) -> dict[str, Any]:
        directory = self._directory(document_id)
        metadata = self._read_json(directory / "metadata.json")
        if metadata.get("schema_version") != CURRICULUM_SCHEMA:
            raise CurriculumValidationError("培养方案元数据版本无效")
        if metadata.get("status") not in _STATUSES:
            raise CurriculumValidationError("培养方案状态无效")
        return deepcopy(metadata)

    def parse(self, document_id: str) -> dict[str, Any]:
        with self._lock:
            metadata = self.get(document_id)
            if metadata.get("status") == "ready":
                return metadata
            # ``parsing`` can be left behind by a terminated backend. The
            # in-process set is the authoritative concurrency guard; a fresh
            # process may safely retry the durable record.
            if document_id in self._active_parses:
                raise CurriculumConflictError("培养方案正在解析")
            self._active_parses.add(document_id)
            directory = self._directory(document_id)
            metadata["status"] = "parsing"
            metadata["error"] = None
            metadata["updated_at"] = _now()
            self._write_json_atomic(directory / "metadata.json", metadata)

        try:
            source_name = "source.pdf" if metadata["content_type"] == _PDF_CONTENT_TYPE else "source.docx"
            requirements, markdown = parse_curriculum_document(
                directory / source_name,
                document_id=document_id,
                filename=str(metadata["filename"]),
                content_type=str(metadata["content_type"]),
                sha256=str(metadata["sha256"]),
                pdftotext_executable=self.pdftotext_executable,
                timeout_seconds=self.parse_timeout_seconds,
            )
            if requirements.get("schema_version") != REQUIREMENTS_SCHEMA:
                raise CurriculumValidationError("培养方案要求契约版本无效")
            self._write_json_atomic(directory / "requirements.json", requirements)
            self._write_bytes_atomic(directory / "full.md", markdown.encode("utf-8"))
            metadata["status"] = "ready"
            metadata["parser"] = PARSER_NAME
            metadata["requirements_summary"] = deepcopy(requirements.get("summary"))
            metadata["error"] = None
            metadata["updated_at"] = _now()
            self._write_json_atomic(directory / "metadata.json", metadata)
            return deepcopy(metadata)
        except (CurriculumParseError, CurriculumValidationError) as exc:
            metadata["status"] = "failed"
            metadata["error"] = str(exc)
            metadata["updated_at"] = _now()
            self._write_json_atomic(directory / "metadata.json", metadata)
            raise
        except OSError as exc:
            metadata["status"] = "failed"
            metadata["error"] = "培养方案解析产物无法保存"
            metadata["updated_at"] = _now()
            self._write_json_atomic(directory / "metadata.json", metadata)
            raise CurriculumStorageError("培养方案解析产物无法保存") from exc
        finally:
            with self._lock:
                self._active_parses.discard(document_id)

    def get_requirements(self, document_id: str) -> dict[str, Any]:
        metadata = self.get(document_id)
        if metadata.get("status") != "ready":
            raise CurriculumConflictError("培养方案尚未解析完成")
        requirements = self._read_json(self._directory(document_id) / "requirements.json")
        if requirements.get("schema_version") != REQUIREMENTS_SCHEMA:
            raise CurriculumValidationError("培养方案要求数据版本无效")
        return deepcopy(requirements)

    def get_markdown(self, document_id: str) -> str:
        metadata = self.get(document_id)
        if metadata.get("status") != "ready":
            raise CurriculumConflictError("培养方案尚未解析完成")
        path = self._directory(document_id) / "full.md"
        if not path.is_file() or path.is_symlink():
            raise CurriculumNotFoundError("培养方案规范化正文不存在")
        try:
            return path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise CurriculumValidationError("培养方案规范化正文损坏") from exc


_store: CurriculumStore | None = None
_store_lock = threading.Lock()


def get_curriculum_store() -> CurriculumStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = CurriculumStore()
    return _store


__all__ = [
    "CURRICULUM_SCHEMA",
    "CurriculumConflictError",
    "CurriculumError",
    "CurriculumNotFoundError",
    "CurriculumStorageError",
    "CurriculumStore",
    "CurriculumTooLargeError",
    "CurriculumUnsupportedMediaTypeError",
    "CurriculumValidationError",
    "get_curriculum_store",
]
