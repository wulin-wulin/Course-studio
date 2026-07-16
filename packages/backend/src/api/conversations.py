"""Single-user durable conversation history API."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException, Response, status

from ..services.conversations import get_conversation_store


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
