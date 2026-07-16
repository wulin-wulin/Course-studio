#!/usr/bin/env python3
"""Create one real chat turn and verify that the history API persisted it."""

from __future__ import annotations

import argparse
import asyncio
import json
import uuid

import httpx
import websockets


async def main_async(args: argparse.Namespace) -> int:
    conversation_id = f"history-smoke-{uuid.uuid4()}"
    request_id = f"request-{uuid.uuid4()}"
    chunks: list[str] = []
    async with websockets.connect(
        args.ws_url,
        proxy=None,
        max_size=16 * 1024 * 1024,
    ) as websocket:
        await websocket.send(
            json.dumps(
                {
                    "type": "agent_request",
                    "payload": {
                        "conversation_id": conversation_id,
                        "request_id": request_id,
                        "message": "请只回复：历史记录测试成功",
                        "images": [],
                        "mode": "chat",
                        "workflow": "default",
                    },
                },
                ensure_ascii=False,
            )
        )
        while True:
            raw = await asyncio.wait_for(websocket.recv(), timeout=args.timeout)
            event = json.loads(raw)
            event_type = event.get("type")
            payload = event.get("payload") or {}
            if event_type == "agent_text_delta":
                chunks.append(str(payload.get("text") or ""))
            elif event_type == "agent_error":
                raise RuntimeError(str(payload.get("message") or "Agent error"))
            elif event_type == "agent_done":
                if int(payload.get("return_code") or 0) != 0:
                    raise RuntimeError("Agent turn failed")
                break

    async with httpx.AsyncClient(
        base_url=args.api_url,
        timeout=15.0,
        trust_env=False,
    ) as client:
        detail_response = await client.get(f"/conversations/{conversation_id}")
        detail_response.raise_for_status()
        detail = detail_response.json()
        messages = detail.get("messages") or []
        if len(messages) != 2:
            raise RuntimeError(f"expected 2 messages, got {len(messages)}")
        if messages[0].get("id") != request_id or messages[0].get("role") != "user":
            raise RuntimeError("user message was not persisted with its request id")
        if messages[1].get("role") != "assistant":
            raise RuntimeError("assistant message was not persisted")
        listing = (await client.get("/conversations")).json().get("conversations") or []
        if not any(
            item.get("id") == conversation_id and item.get("message_count") == 2
            for item in listing
        ):
            raise RuntimeError("conversation is missing from history list")

    print(
        json.dumps(
            {
                "conversation_id": conversation_id,
                "messages": 2,
                "reply": "".join(chunks).strip(),
            },
            ensure_ascii=False,
        )
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ws-url", default="ws://127.0.0.1:8000/api/agent/ws")
    parser.add_argument("--api-url", default="http://127.0.0.1:8000/api")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()
    try:
        return asyncio.run(main_async(args))
    except Exception as error:
        print(f"HISTORY SMOKE TEST FAILED: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
