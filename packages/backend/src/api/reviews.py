"""Structured review API for course-generation checkpoints."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from ..services.reviews import (
    CourseReviewConflictError,
    CourseReviewNotFoundError,
    CourseReviewValidationError,
    get_course_review_store,
)
from ..services.reviews.activity import (
    CourseActivityConflictError,
    get_course_activity_coordinator,
)


router = APIRouter()
T = TypeVar("T")


class ReviewSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: str = Field(min_length=1, max_length=200)
    revision: int = Field(ge=1)
    artifact_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    operations: list[dict[str, Any]] = Field(default_factory=list, max_length=500)


async def _run(operation: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    try:
        return await asyncio.to_thread(operation, *args, **kwargs)
    except CourseReviewNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except CourseReviewConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except CourseReviewValidationError as exc:
        detail: str | dict[str, Any] = str(exc)
        if exc.details:
            detail = {"message": str(exc), "details": exc.details}
        raise HTTPException(status_code=422, detail=detail) from exc


@router.get("")
async def list_reviews(
    conversation_id: str = Query(min_length=1, max_length=200),
):
    review_store = get_course_review_store()
    resume = await _run(
        review_store.resume_pending_for_conversation,
        conversation_id,
    )
    if resume is not None:
        return {
            "reviews": [],
            "pending_review": None,
            "pending_review_resume": review_store.pointer(resume),
        }
    resources = await _run(
        review_store.pending_for_conversation,
        conversation_id,
    )
    reviews = [review_store.pointer(resource) for resource in resources]
    return {
        "reviews": reviews,
        "pending_review": reviews[0] if reviews else None,
        "pending_review_resume": None,
    }


@router.get("/{review_id}")
async def get_review(review_id: str):
    return await _run(get_course_review_store().get, review_id)


@router.post("/{review_id}/submit")
async def submit_review(review_id: str, body: ReviewSubmitRequest):
    coordinator = get_course_activity_coordinator()
    try:
        lease = coordinator.claim(body.conversation_id, "review-submit")
    except CourseActivityConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    def submit_with_lease():
        try:
            return get_course_review_store().submit(
                review_id,
                conversation_id=body.conversation_id,
                revision=body.revision,
                artifact_hash=body.artifact_hash,
                operations=body.operations,
            )
        finally:
            # asyncio cancellation does not stop a to_thread worker. The worker
            # therefore owns release so the lease covers the complete CAS.
            coordinator.release(lease)

    return await _run(submit_with_lease)
