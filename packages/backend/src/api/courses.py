"""HTTP surface for canonical course packages.

The frontend only needs the read endpoints today.  The CRUD endpoints are kept
small and JSON-native so future OpenCode skills can call the same validated
operations instead of hand-editing a frontend bundle.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException, Response, status

from ..models.course import (
    ClusterWriteRequest,
    CourseCreateRequest,
    CourseUpdateRequest,
    CourseValidationResponse,
    PointWriteRequest,
)
from ..services.courses import (
    CourseDataError,
    CourseNotFoundError,
    get_course_store,
)


router = APIRouter()
T = TypeVar("T")


async def _run(operation: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    try:
        return await asyncio.to_thread(operation, *args, **kwargs)
    except CourseNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except CourseDataError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("")
async def list_courses():
    return {"courses": await _run(get_course_store().list_courses)}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_course(body: CourseCreateRequest):
    course = await _run(get_course_store().create_course, body.course, body.index)
    return {"course": course}


@router.get("/{course_id}")
async def get_course(course_id: str):
    return await _run(get_course_store().read_course, course_id)


@router.patch("/{course_id}")
async def update_course(course_id: str, body: CourseUpdateRequest):
    course = await _run(get_course_store().update_course, course_id, body.course)
    return {"course": course}


@router.delete("/{course_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_course(course_id: str):
    await _run(get_course_store().delete_course, course_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{course_id}/index")
async def get_index(course_id: str):
    return await _run(get_course_store().read_index, course_id)


@router.get("/{course_id}/validate", response_model=CourseValidationResponse)
async def validate_course(course_id: str):
    result = await _run(get_course_store().validate_course, course_id)
    revision = await _run(get_course_store().revision, course_id)
    return CourseValidationResponse(
        ok=result.ok,
        errors=result.errors,
        warnings=result.warnings,
        revision=revision,
    )


@router.post("/{course_id}/clusters", status_code=status.HTTP_201_CREATED)
async def create_cluster(course_id: str, body: ClusterWriteRequest):
    cluster = await _run(get_course_store().create_cluster, course_id, body.cluster)
    return {"cluster": cluster, "revision": await _run(get_course_store().revision, course_id)}


@router.patch("/{course_id}/clusters/{cluster_id}")
async def update_cluster(course_id: str, cluster_id: str, body: ClusterWriteRequest):
    cluster = await _run(
        get_course_store().update_cluster, course_id, cluster_id, body.cluster
    )
    return {"cluster": cluster, "revision": await _run(get_course_store().revision, course_id)}


@router.delete("/{course_id}/clusters/{cluster_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cluster(course_id: str, cluster_id: str):
    await _run(get_course_store().delete_cluster, course_id, cluster_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{course_id}/points/{point_id}")
async def get_point(course_id: str, point_id: str):
    return await _run(get_course_store().read_point, course_id, point_id)


@router.post("/{course_id}/points", status_code=status.HTTP_201_CREATED)
async def create_point(course_id: str, body: PointWriteRequest):
    point = await _run(get_course_store().create_point, course_id, body.point)
    return {"point": point, "revision": await _run(get_course_store().revision, course_id)}


@router.patch("/{course_id}/points/{point_id}")
async def update_point(course_id: str, point_id: str, body: PointWriteRequest):
    point = await _run(get_course_store().update_point, course_id, point_id, body.point)
    return {"point": point, "revision": await _run(get_course_store().revision, course_id)}


@router.delete("/{course_id}/points/{point_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_point(course_id: str, point_id: str):
    await _run(get_course_store().delete_point, course_id, point_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
