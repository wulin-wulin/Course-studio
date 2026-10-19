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

from ..config import settings
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
from ..services.documents.mineru_parser import parse_mineru_pdf


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
    return await _run(_parse_selected_document, document_id)


def _parse_selected_document(document_id: str):
    mode = settings.document_parser
    use_mineru = mode == "mineru" or (
        mode == "auto" and bool(settings.mineru_api_token.strip())
    )
    parser = parse_mineru_pdf if use_mineru else parse_pdf_outline
    parser_name = f"mineru-{settings.mineru_model_version}" if use_mineru else "local-pdftotext"
    return get_document_store().parse(
        document_id, parser=parser, parser_name=parser_name,
    )


@router.get("/{document_id}/outline")
async def get_document_outline(document_id: str):
    return await _run(get_document_store().get_outline, document_id)
