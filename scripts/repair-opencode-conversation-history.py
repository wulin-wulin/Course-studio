#!/usr/bin/env python
"""Repair leaked OpenCode reasoning in one Course Studio conversation.

The OpenCode session is the authoritative source because it stores reasoning,
visible text, and native questions as distinct part types.  This utility
rebuilds only user-visible assistant segments and updates the existing SQLite
messages atomically without changing their IDs or timestamps.
"""

from __future__ import annotations

import argparse
import asyncio
import os
from pathlib import Path
import sys
from typing import Any

import httpx


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = PROJECT_ROOT / "packages" / "backend"
sys.path.insert(0, str(BACKEND_ROOT))
os.chdir(BACKEND_ROOT)

from src.api.agent import _question_history_content  # noqa: E402
from src.config import settings  # noqa: E402
from src.services.conversations import get_conversation_store  # noqa: E402


def visible_assistant_segments(messages: list[dict[str, Any]]) -> list[str]:
    segments: list[str] = []
    pending_text: list[str] = []

    def flush() -> None:
        content = "\n\n".join(part.strip() for part in pending_text if part.strip()).strip()
        pending_text.clear()
        if content:
            segments.append(content)

    for message in messages:
        info = message.get("info") if isinstance(message.get("info"), dict) else {}
        if info.get("role") != "assistant":
            continue
        parts = message.get("parts") if isinstance(message.get("parts"), list) else []
        for part in parts:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                text = str(part.get("text") or "").strip()
                if text:
                    pending_text.append(text)
                continue
            if part.get("type") != "tool" or part.get("tool") != "question":
                continue
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            tool_input = state.get("input") if isinstance(state.get("input"), dict) else {}
            questions = (
                tool_input.get("questions")
                if isinstance(tool_input.get("questions"), list)
                else []
            )
            if questions:
                pending_text.append(_question_history_content(questions))
            flush()
    flush()
    return segments


async def fetch_session_messages(session_id: str, directory: Path) -> list[dict[str, Any]]:
    auth = (
        ("opencode", settings.opencode_server_password)
        if settings.opencode_server_password
        else None
    )
    async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
        response = await client.get(
            f"{settings.opencode_base_url.rstrip('/')}/session/{session_id}/message",
            params={"directory": str(directory)},
            auth=auth,
        )
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError("OpenCode 消息接口没有返回数组")
    return payload


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("conversation_id")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="确认数量匹配后写回 SQLite；默认只做预检",
    )
    args = parser.parse_args()

    store = get_conversation_store()
    conversation = store.get_conversation(args.conversation_id)
    if conversation is None:
        raise RuntimeError(f"对话不存在：{args.conversation_id}")
    session_id = conversation.get("opencode_session_id")
    if not session_id:
        raise RuntimeError("对话没有关联 OpenCode session")

    directory = settings.course_agent_workspace_dir / args.conversation_id
    messages = await fetch_session_messages(str(session_id), directory)
    segments = visible_assistant_segments(messages)
    stored_count = sum(
        message.get("role") == "assistant"
        for message in conversation.get("messages") or []
    )
    if len(segments) != stored_count:
        raise RuntimeError(
            f"数量不匹配，拒绝写回：OpenCode 可见段 {len(segments)}，"
            f"SQLite 助手消息 {stored_count}"
        )

    if args.apply:
        store.replace_assistant_message_contents(args.conversation_id, segments)
        print(f"已修复 {args.conversation_id} 的 {len(segments)} 条助手消息。")
    else:
        print(
            f"预检通过：{args.conversation_id} 可重建 {len(segments)} 条助手消息；"
            "使用 --apply 写回。"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
