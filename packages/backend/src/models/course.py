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


class PlaceholderCourseCreateRequest(BaseModel):
    """Create a display-only course entry inside one subject group."""

    title: str = Field(min_length=1, max_length=200)
    group_id: str = Field(min_length=1, max_length=120)


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


class CourseCatalogGroupRequest(BaseModel):
    """Create or rename one user-managed course subject group."""

    name: str = Field(min_length=1, max_length=80)


class CourseCatalogAssignmentRequest(BaseModel):
    """Move one course to exactly one subject group."""

    course_id: str = Field(min_length=1, max_length=120)
    group_id: str = Field(min_length=1, max_length=120)


class CourseCatalogReorderRequest(BaseModel):
    """Replace the visible order of all subject groups."""

    group_ids: list[str] = Field(min_length=1)


class CourseCatalogEdge(BaseModel):
    fromId: str = Field(min_length=1, max_length=120)
    toId: str = Field(min_length=1, max_length=120)


class CourseCatalogEdgesRequest(BaseModel):
    edges: list[CourseCatalogEdge]


class CourseCatalogPosition(BaseModel):
    """A user-adjusted graph anchor in the catalog coordinate space."""

    x: float
    y: float
    pinned: bool = True


class CourseCatalogLayoutRequest(BaseModel):
    """Replace the manually pinned positions for one subject group."""

    positions: dict[str, CourseCatalogPosition] = Field(default_factory=dict)
