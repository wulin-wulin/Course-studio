"""Single-user durable conversation history API."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException, Response, status

from ..services.conversations import get_conversation_store
from ..services.reviews import (
    CourseReviewError,
    get_course_review_store,
)


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
    review_store = get_course_review_store()
    try:
        pending_resume = await _run(
            review_store.resume_pending_for_conversation,
            conversation_id,
        )
        if pending_resume is not None:
            conversation["pending_review"] = None
            conversation["pending_review_resume"] = review_store.pointer(
                pending_resume
            )
            return conversation
        pending_reviews = await _run(
            review_store.pending_for_conversation,
            conversation_id,
        )
    except CourseReviewError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    pending_review = pending_reviews[0] if pending_reviews else None
    conversation["pending_review"] = (
        review_store.pointer(pending_review) if pending_review else None
    )
    conversation["pending_review_resume"] = None
    return conversation


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: str):
    deleted = await _run(
        get_conversation_store().delete_conversation,
        conversation_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="历史对话不存在")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
