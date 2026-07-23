"""Single-user durable conversation history API."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException, Response, status

from ..services.conversations import get_conversation_store
from ..services.courses import CourseDataError, get_course_store
from ..services.opencode import client as opencode_client
from ..services.reviews import CourseReviewError, get_course_review_store
from ..services.reviews.activity import get_course_activity_coordinator


router = APIRouter()
T = TypeVar("T")


async def _run(operation: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    return await asyncio.to_thread(operation, *args, **kwargs)


@router.get("")
async def list_conversations(limit: int = 100):
    conversations = await _run(
        get_conversation_store().list_conversations,
        limit=limit,
    )
    return {"conversations": conversations}


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: str):
    conversation = await _run(
        get_conversation_store().get_conversation,
        conversation_id,
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="历史对话不存在")
    conversation.pop("opencode_session_id", None)
    # Import locally to avoid an API-router cycle during application startup.
    # This restores native option cards when their websocket event was missed.
    from .agent import pending_question_for_conversation

    conversation["pending_question"] = pending_question_for_conversation(
        conversation_id
    )
    review_store = get_course_review_store()
    try:
        pending_reviews = await _run(
            review_store.pending_for_conversation,
            conversation_id,
        )
        pending_review = pending_reviews[0] if pending_reviews else None
        if pending_review is not None:
            conversation["pending_review"] = review_store.pointer(pending_review)
            conversation["pending_review_resume"] = None
            return conversation
        pending_resume = await _run(
            review_store.resume_pending_for_conversation,
            conversation_id,
        )
    except CourseReviewError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    conversation["pending_review"] = None
    conversation["pending_review_resume"] = (
        review_store.pointer(pending_resume) if pending_resume else None
    )
    return conversation


async def _purge_conversation(conversation_id: str) -> Response:
    conversation_store = get_conversation_store()
    conversation = await _run(
        conversation_store.get_conversation,
        conversation_id,
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="历史对话不存在")

    active = get_course_activity_coordinator().active_for(conversation_id)
    if active is not None:
        raise HTTPException(
            status_code=409,
            detail="该课程创建流程仍在执行，请先等待其结束或中止后再删除。",
        )

    session_id = conversation.get("opencode_session_id")
    try:
        await _run(
            get_course_store().discard_conversation_workspaces,
            conversation_id,
        )
    except CourseDataError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if isinstance(session_id, str) and session_id:
        await opencode_client.delete_session(session_id)

    # Import locally to avoid an API-router import cycle during application
    # startup. The turn is known to be inactive at this point.
    from .agent import forget_opencode_conversation

    forget_opencode_conversation(
        conversation_id,
        session_id if isinstance(session_id, str) else None,
    )
    deleted = await _run(
        conversation_store.delete_conversation,
        conversation_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="历史对话不存在")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{conversation_id}/purge",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def purge_conversation(conversation_id: str):
    return await _purge_conversation(conversation_id)


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: str):
    """Backward-compatible delete now performs the same complete cleanup."""

    return await _purge_conversation(conversation_id)
