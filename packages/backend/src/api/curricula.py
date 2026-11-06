"""HTTP API for curriculum and syllabus guidance documents."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import PlainTextResponse

from ..services.curricula import (
    CurriculumConflictError,
    CurriculumError,
    CurriculumNotFoundError,
    CurriculumParseError,
    CurriculumParserUnavailableError,
    CurriculumStorageError,
    CurriculumTooLargeError,
    CurriculumUnsupportedMediaTypeError,
    CurriculumValidationError,
    get_curriculum_store,
)


router = APIRouter()
T = TypeVar("T")


async def _run(operation: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    try:
        return await asyncio.to_thread(operation, *args, **kwargs)
    except CurriculumNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except CurriculumUnsupportedMediaTypeError as exc:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=str(exc),
        ) from exc
    except CurriculumTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(exc),
        ) from exc
    except CurriculumConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except CurriculumParserUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except (CurriculumParseError, CurriculumValidationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    except CurriculumStorageError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc
    except CurriculumError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


@router.post("", status_code=status.HTTP_201_CREATED)
async def upload_curriculum(file: UploadFile):
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="缺少培养方案或教学大纲文件名",
        )
    try:
        return await _run(
            get_curriculum_store().create_upload,
            file.file,
            filename=file.filename,
            content_type=file.content_type,
        )
    finally:
        await file.close()


@router.get("/{document_id}")
async def get_curriculum(document_id: str):
    return await _run(get_curriculum_store().get, document_id)


@router.post("/{document_id}/parse")
async def parse_curriculum(document_id: str):
    return await _run(get_curriculum_store().parse, document_id)


@router.get("/{document_id}/requirements")
async def get_curriculum_requirements(document_id: str):
    return await _run(get_curriculum_store().get_requirements, document_id)


@router.get("/{document_id}/markdown")
async def get_curriculum_markdown(document_id: str):
    content = await _run(get_curriculum_store().get_markdown, document_id)
    return PlainTextResponse(content, media_type="text/markdown")
