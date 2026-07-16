"""HTTP surface for canonical course packages.

The frontend only needs the read endpoints today.  The CRUD endpoints are kept
small and JSON-native so future OpenCode skills can call the same validated
operations instead of hand-editing a frontend bundle.
"""

from __future__ import annotations

import asyncio
import re
import secrets
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import HTMLResponse

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

def _animation_player_html(nonce: str, stylesheet: bytes, javascript: bytes) -> str:
    try:
        css_text = stylesheet.decode("utf-8")
        javascript_text = javascript.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CourseDataError("动画运行资产必须使用 UTF-8 编码") from exc
    # HTML parsers recognize closing raw-text tags even inside JS/CSS string
    # literals. Escape them before embedding integrity-checked assets.
    css_text = re.sub(r"</style", r"<\/style", css_text, flags=re.IGNORECASE)
    javascript_text = re.sub(r"</script", r"<\/script", javascript_text, flags=re.IGNORECASE)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>课程教学动画</title>
  <style nonce="{nonce}">{css_text}</style>
</head>
<body>
  <div id="root" role="region" aria-label="课程教学动画"></div>
  <script nonce="{nonce}">{javascript_text}</script>
</body>
</html>
"""


def _animation_csp(nonce: str) -> str:
    return (
        "default-src 'none'; "
        f"script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
        "img-src data:; font-src data:; connect-src 'none'; media-src 'none'; "
        "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    )


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


@router.get("/{course_id}/animations/manifest")
async def get_animation_manifest(course_id: str):
    return await _run(get_course_store().read_animation_manifest, course_id)


@router.get("/{course_id}/animations/player", response_class=HTMLResponse)
async def get_animation_player(
    course_id: str,
    animation_type: str = Query(alias="type", min_length=1, max_length=80),
):
    # Resolve the type before returning a document. Unknown or stale point
    # bindings fail closed instead of booting an arbitrary runtime branch.
    await _run(get_course_store().read_animation_definition, course_id, animation_type)
    stylesheet, javascript = await asyncio.gather(
        _run(get_course_store().read_animation_asset, course_id, "runtime.css"),
        _run(get_course_store().read_animation_asset, course_id, "runtime.js"),
    )
    nonce = secrets.token_urlsafe(18)
    return HTMLResponse(
        _animation_player_html(nonce, stylesheet, javascript),
        headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": _animation_csp(nonce),
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
    )


async def _animation_asset_response(course_id: str, file_name: str, media_type: str) -> Response:
    content = await _run(get_course_store().read_animation_asset, course_id, file_name)
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            # A sandbox without allow-same-origin intentionally has an opaque
            # origin. The fixed player CSP is the execution boundary; assets
            # must therefore opt in to opaque-origin subresource loading.
            "Cross-Origin-Resource-Policy": "cross-origin",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/{course_id}/animations/runtime.js")
async def get_animation_javascript(course_id: str):
    return await _animation_asset_response(course_id, "runtime.js", "text/javascript")


@router.get("/{course_id}/animations/runtime.css")
async def get_animation_stylesheet(course_id: str):
    return await _animation_asset_response(course_id, "runtime.css", "text/css")


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
