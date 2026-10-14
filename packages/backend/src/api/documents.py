"""HTTP API for textbook PDF uploads and deterministic outline extraction.

The upload is intentionally separate from the course creation WebSocket.  A
PDF is persisted and parsed first, then the resulting immutable outline can be
bound to one course-creation conversation by document id.  This keeps retries
safe and prevents a partially parsed document from entering the course store.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException, UploadFile, status

from ..services.documents import (
    DocumentConflictError,
    DocumentError,
    DocumentNotFoundError,
    DocumentParseError,
    DocumentParserUnavailableError,
    DocumentStorageError,
    DocumentTooLargeError,
    DocumentUnsupportedMediaTypeError,
    DocumentValidationError,
    get_document_store,
)
from ..services.documents.local_parser import parse_pdf_outline


router = APIRouter()
T = TypeVar("T")


async def _run(operation: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    try:
        return await asyncio.to_thread(operation, *args, **kwargs)
    except DocumentNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except DocumentUnsupportedMediaTypeError as exc:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=str(exc),
        ) from exc
    except DocumentTooLargeError as exc:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(exc)) from exc
    except DocumentConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except DocumentParserUnavailableError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except (DocumentParseError, DocumentValidationError) as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except DocumentStorageError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc
    except DocumentError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.post("", status_code=status.HTTP_201_CREATED)
async def upload_document(file: UploadFile):
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="缺少 PDF 文件名")
    try:
        return await _run(
            get_document_store().create_upload,
            file.file,
            filename=file.filename,
            content_type=file.content_type,
        )
    finally:
        await file.close()


@router.get("/{document_id}")
async def get_document(document_id: str):
    return await _run(get_document_store().get, document_id)


@router.post("/{document_id}/parse")
async def parse_document(document_id: str):
    # The parser function is injected at the API boundary so the store stays
    # independent of Poppler and can later select a MinerU adapter without
    # changing its lifecycle or validation contract.
    return await _run(
        get_document_store().parse,
        document_id,
        parser=parse_pdf_outline,
    )


@router.get("/{document_id}/outline")
async def get_document_outline(document_id: str):
    return await _run(get_document_store().get_outline, document_id)
