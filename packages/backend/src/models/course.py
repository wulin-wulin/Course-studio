"""Models shared by the course-data HTTP API.

The course package intentionally stays JSON-first.  These models therefore do
not try to freeze every pedagogical field; skills can add fields over time
without requiring a backend deployment.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class CourseCreateRequest(BaseModel):
    """Create one empty or pre-populated CKDS course package."""

    course: dict[str, Any] = Field(default_factory=dict)
    index: dict[str, Any] | None = None


class CourseUpdateRequest(BaseModel):
    """Partial metadata update for ``course.json``."""

    course: dict[str, Any] = Field(default_factory=dict)


class ClusterWriteRequest(BaseModel):
    """A complete cluster object, stored inside ``index.json``."""

    cluster: dict[str, Any] = Field(default_factory=dict)


class PointWriteRequest(BaseModel):
    """A complete point detail object, stored in ``points/<id>.json``."""

    point: dict[str, Any] = Field(default_factory=dict)


class CourseValidationResponse(BaseModel):
    ok: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    revision: str | None = None
