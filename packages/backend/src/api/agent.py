"""Course-data Agent WebSocket endpoint.

The OpenCode path keeps the existing model/session/SSE communication. It
writes a per-conversation staged course workspace;
the course store validates and promotes that workspace after a normal idle
event.  The optional in-process model loop exposes the same controlled CRUD
operations for deployments where OpenCode is disabled.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path
from typing import Any

import anthropic
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import settings
from ..services.ai import model_config
from ..services.ai.base import split_image_data
from ..services.courses import (
    CourseConflictError,
    CourseDataError,
    CourseNotFoundError,
    CourseValidationError,
    get_course_store,
)
from ..services.opencode import client as opencode_client
from ..services.opencode import provision as opencode_provision


router = APIRouter()

COURSE_SYSTEM_PROMPT_PATH = (
    Path(__file__).parent.parent / "services" / "ai" / "prompts" / "system_course_agent.md"
)
MAX_TOOL_ITERATIONS = 24
MAX_TOKENS = 32000
THINKING_BUDGET_TOKENS = 1024
MAX_HISTORY_MESSAGES = 40

# Per-conversation message history powers the optional in-process tool loop.
_histories: dict[str, list[dict[str, Any]]] = {}
# OpenCode owns its own memory; this map only lets reconnecting WebSocket turns
# continue the same OpenCode session.
_opencode_sessions: dict[str, str] = {}


TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_courses",
        "description": "列出当前课程数据工作区中的所有课程及其知识簇/知识点数量。",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "read_course",
        "description": "读取一门课程的 course.json 元数据。",
        "input_schema": {
            "type": "object",
            "properties": {"course_id": {"type": "string"}},
            "required": ["course_id"],
        },
    },
    {
        "name": "read_index",
        "description": "读取课程 index.json；可按知识簇或关键词过滤，避免一次读取过多知识点。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course_id": {"type": "string"},
                "cluster_id": {"type": "string"},
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 80},
            },
            "required": ["course_id"],
        },
    },
    {
        "name": "read_point",
        "description": "读取某个知识点完整详情 JSON。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course_id": {"type": "string"},
                "point_id": {"type": "string"},
            },
            "required": ["course_id", "point_id"],
        },
    },
    {
        "name": "create_course",
        "description": "创建一门课程及其空 index.json，course 至少需要 id 和 title。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course": {"type": "object"},
                "index": {"type": "object"},
            },
            "required": ["course"],
        },
    },
    {
        "name": "update_course",
        "description": "更新 course.json 的元数据；课程 id 不能修改。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course_id": {"type": "string"},
                "course": {"type": "object"},
            },
            "required": ["course_id", "course"],
        },
    },
    {
        "name": "delete_course",
        "description": "删除整门课程及其所有知识簇和知识点。仅在用户明确要求时使用。",
        "input_schema": {
            "type": "object",
            "properties": {"course_id": {"type": "string"}},
            "required": ["course_id"],
        },
    },
    {
        "name": "create_cluster",
        "description": "在一门课程中创建知识簇。cluster 至少包含 id 和 title。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course_id": {"type": "string"},
                "cluster": {"type": "object"},
            },
            "required": ["course_id", "cluster"],
        },
    },
    {
        "name": "update_cluster",
        "description": "更新知识簇；cluster_id 不可修改。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course_id": {"type": "string"},
                "cluster_id": {"type": "string"},
                "cluster": {"type": "object"},
            },
            "required": ["course_id", "cluster_id", "cluster"],
        },
    },
    {
        "name": "delete_cluster",
        "description": "删除空知识簇；仍含知识点的知识簇会被安全拒绝。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course_id": {"type": "string"},
                "cluster_id": {"type": "string"},
            },
            "required": ["course_id", "cluster_id"],
        },
    },
    {
        "name": "create_point",
        "description": "创建完整知识点，并自动同步 index 元数据。必须提供有意义的课程内容。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course_id": {"type": "string"},
                "point": {"type": "object"},
            },
            "required": ["course_id", "point"],
        },
    },
    {
        "name": "update_point",
        "description": "部分更新知识点详情，并自动同步 index 元数据。point_id 不可修改。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course_id": {"type": "string"},
                "point_id": {"type": "string"},
                "point": {"type": "object"},
            },
            "required": ["course_id", "point_id", "point"],
        },
    },
    {
        "name": "delete_point",
        "description": "删除知识点，并从其余知识点的 prerequisites 中安全移除引用。",
        "input_schema": {
            "type": "object",
            "properties": {
                "course_id": {"type": "string"},
                "point_id": {"type": "string"},
            },
            "required": ["course_id", "point_id"],
        },
    },
    {
        "name": "validate_course",
        "description": "检查课程包结构、索引和知识点详情的一致性。",
        "input_schema": {
            "type": "object",
            "properties": {"course_id": {"type": "string"}},
            "required": ["course_id"],
        },
    },
]


def _safe_conversation_id(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in value)[:80] or "default"


def _system_prompt() -> str:
    return COURSE_SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")


def _trim_history(history: list[dict[str, Any]]) -> None:
    while len(history) > MAX_HISTORY_MESSAGES:
        del history[0]
    while history and not _is_clean_start(history[0]):
        del history[0]


def _is_clean_start(message: dict[str, Any]) -> bool:
    if message.get("role") != "user":
        return False
    content = message.get("content")
    if isinstance(content, list):
        return not any(
            isinstance(block, dict) and block.get("type") == "tool_result" for block in content
        )
    return True


def _agent_prompt(message: str) -> str:
    return (
        f"用户请求：\n{message}\n\n"
        "你是课程知识数据 Agent。使用课程数据工具完成读取、创建、修改或删除；"
        "不要处理界面或 Three.js。修改后简短说明实际变更的数据。"
    )


async def _send_status(websocket: WebSocket, conversation_id: str, phase: str, label: str) -> None:
    await websocket.send_json({
        "type": "agent_status",
        "payload": {"phase": phase, "label": label, "conversation_id": conversation_id},
    })


async def _emit_course_change(
    websocket: WebSocket,
    conversation_id: str,
    course_id: str,
    changed_paths: list[str],
    *,
    revision: str | None = None,
) -> None:
    """Notify the forest client that canonical data changed and should reload."""

    if revision is None:
        try:
            revision = get_course_store().revision(course_id)
        except CourseDataError:
            revision = None
    await websocket.send_json({
        "type": "course_data_changed",
        "payload": {
            "course_id": course_id,
            "revision": revision,
            "changed_paths": changed_paths,
            "conversation_id": conversation_id,
        },
    })


async def _emit_committed_workspace_changes(
    websocket: WebSocket, conversation_id: str, committed: dict[str, Any]
) -> None:
    all_paths = [str(path) for path in committed.get("changed_paths") or []]
    for course_id in committed.get("course_ids") or []:
        prefix = f"{course_id}/"
        paths = [path[len(prefix):] for path in all_paths if path.startswith(prefix)]
        await _emit_course_change(websocket, conversation_id, course_id, paths)


@router.websocket("/ws")
async def agent_websocket(websocket: WebSocket):
    await websocket.accept()
    active_opencode_session: dict[str, str | None] = {"id": None}

    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") != "agent_request":
                continue
            payload = data.get("payload", {})
            if settings.opencode_enabled:
                await _run_agent_turn_opencode(websocket, payload, active_opencode_session)
            else:
                await _run_agent_turn(websocket, payload)
    except WebSocketDisconnect:
        session_id = active_opencode_session.get("id")
        if session_id:
            await opencode_client.abort(session_id)
    except Exception as exc:
        with contextlib.suppress(Exception):
            await websocket.send_json({"type": "agent_error", "payload": {"message": str(exc)}})


# ---------------------------------------------------------------------------
# OpenCode-backed course agent
# ---------------------------------------------------------------------------


def _resolve_opencode_model(requested: str | None) -> str:
    models = model_config.load_models()
    allowed = {model.id for model in models}
    if requested and requested in allowed:
        return requested
    return model_config.default_model_id()


async def _run_agent_turn_opencode(
    websocket: WebSocket,
    payload: dict[str, Any],
    active_session: dict[str, str | None],
) -> None:
    message = (payload.get("message") or "").strip()
    images = payload.get("images") or []
    if not message and not images:
        return

    conversation_id = _safe_conversation_id(payload.get("conversation_id") or "default")
    model = _resolve_opencode_model(payload.get("model"))
    configured_model = model_config.get_model(model)
    if not (configured_model and configured_model.base_url and configured_model.api_key):
        await websocket.send_json({
            "type": "agent_error",
            "payload": {
                "message": "模型未配置完整的 base_url 或 api_key，请检查 models.json。",
                "conversation_id": conversation_id,
            },
        })
        return

    try:
        workspace = opencode_provision.ensure_course_session_assets(conversation_id)
        directory = opencode_provision.host_course_workspace_dir(workspace)
    except CourseDataError as exc:
        await websocket.send_json({
            "type": "agent_error",
            "payload": {"message": str(exc), "conversation_id": conversation_id},
        })
        return

    try:
        await opencode_client.health()
    except Exception:
        await websocket.send_json({
            "type": "agent_error",
            "payload": {
                "message": "无法连接 OpenCode 服务，请先启动 scripts/opencode.sh 或 scripts/opencode.ps1。",
                "conversation_id": conversation_id,
            },
        })
        return

    try:
        session_id = _opencode_sessions.get(conversation_id)
        if not session_id:
            session_id = await opencode_client.create_session(directory, title=conversation_id)
            _opencode_sessions[conversation_id] = session_id
    except Exception as exc:
        await websocket.send_json({
            "type": "agent_error",
            "payload": {"message": f"创建 OpenCode 会话失败：{exc}", "conversation_id": conversation_id},
        })
        return

    active_session["id"] = session_id
    await websocket.send_json({
        "type": "agent_start",
        "payload": {"conversation_id": conversation_id, "model": model},
    })
    prompt = _agent_prompt(message) if message else "请根据上传内容维护课程知识数据。"
    ok = await _run_opencode_prompt(
        websocket=websocket,
        conversation_id=conversation_id,
        session_id=session_id,
        directory=directory,
        text=prompt,
        images=images,
        model=model,
    )
    if not ok:
        await _send_status(websocket, conversation_id, "error", "Agent 执行失败")
        await websocket.send_json({
            "type": "agent_done",
            "payload": {"return_code": 1, "conversation_id": conversation_id},
        })
        active_session["id"] = None
        return

    await _send_status(websocket, conversation_id, "commit", "校验并提交课程数据")
    try:
        committed = get_course_store().commit_workspace(workspace)
    except CourseValidationError as exc:
        details = "；".join(exc.errors[:3])
        await websocket.send_json({
            "type": "agent_error",
            "payload": {
                "message": f"课程数据未提交：{details}",
                "conversation_id": conversation_id,
                "validation_errors": exc.errors,
                "validation_warnings": exc.warnings,
            },
        })
        await websocket.send_json({
            "type": "agent_done",
            "payload": {"return_code": 1, "conversation_id": conversation_id},
        })
        active_session["id"] = None
        return
    except CourseConflictError as exc:
        await websocket.send_json({
            "type": "agent_error",
            "payload": {"message": str(exc), "conversation_id": conversation_id},
        })
        await websocket.send_json({
            "type": "agent_done",
            "payload": {"return_code": 1, "conversation_id": conversation_id},
        })
        active_session["id"] = None
        return
    except CourseDataError as exc:
        await websocket.send_json({
            "type": "agent_error",
            "payload": {"message": f"课程数据提交失败：{exc}", "conversation_id": conversation_id},
        })
        await websocket.send_json({
            "type": "agent_done",
            "payload": {"return_code": 1, "conversation_id": conversation_id},
        })
        active_session["id"] = None
        return

    if committed.get("changed_paths"):
        await _emit_committed_workspace_changes(websocket, conversation_id, committed)
    if committed.get("warnings"):
        await _send_status(websocket, conversation_id, "warning", "课程数据存在历史兼容性提示")
    await _send_status(websocket, conversation_id, "done", "完成")
    await websocket.send_json({
        "type": "agent_done",
        "payload": {"return_code": 0, "conversation_id": conversation_id},
    })
    active_session["id"] = None


_OPENCODE_TOOL_LABELS = {
    "write": "write_course_data",
    "edit": "write_course_data",
    "patch": "write_course_data",
    "read": "read_course_data",
    "glob": "find_course_data",
    "list": "find_course_data",
}


def _map_tool_name(name: str) -> str:
    return _OPENCODE_TOOL_LABELS.get(name, name)


async def _run_opencode_prompt(
    *,
    websocket: WebSocket,
    conversation_id: str,
    session_id: str,
    directory: str,
    text: str,
    images: list[Any],
    model: str | None = None,
) -> bool:
    """Stream OpenCode SSE events into the existing agent WebSocket protocol."""

    in_flight = {"active": True}
    streamed_text = {"any": False}
    tool_started: set[str] = set()
    result = {"ok": True}

    async def send_heartbeat() -> None:
        while in_flight["active"]:
            await asyncio.sleep(8)
            if not in_flight["active"]:
                break
            with contextlib.suppress(Exception):
                await websocket.send_json({
                    "type": "agent_heartbeat",
                    "payload": {"conversation_id": conversation_id},
                })

    def matches_session(properties: dict[str, Any], envelope: dict[str, Any]) -> bool:
        session = properties.get("sessionID")
        if session is not None:
            return session == session_id
        event_directory = envelope.get("directory")
        return event_directory in (None, directory)

    async def consume() -> None:
        await _send_status(websocket, conversation_id, "thinking", "模型思考中")
        async for envelope in opencode_client.events():
            payload = envelope.get("payload") or {}
            event_type = payload.get("type")
            properties = payload.get("properties") or {}
            if not isinstance(properties, dict):
                properties = {}
            if event_type in ("server.connected", "server.heartbeat", "sync"):
                continue
            if not matches_session(properties, envelope):
                continue
            if event_type == "message.part.delta":
                field = properties.get("field")
                delta = properties.get("delta")
                if not delta:
                    continue
                if field == "text":
                    streamed_text["any"] = True
                    await websocket.send_json({
                        "type": "agent_text_delta",
                        "payload": {"text": delta, "conversation_id": conversation_id},
                    })
                elif field == "reasoning":
                    await websocket.send_json({
                        "type": "agent_thinking_delta",
                        "payload": {"text": delta, "conversation_id": conversation_id},
                    })
                continue
            if event_type == "message.part.updated":
                part = properties.get("part") or {}
                if isinstance(part, dict) and part.get("type") == "tool":
                    await _handle_opencode_tool_part(
                        websocket, conversation_id, part, tool_started
                    )
                continue
            if event_type == "session.error":
                error = properties.get("error") or properties.get("message") or "OpenCode 会话出错"
                await websocket.send_json({
                    "type": "agent_error",
                    "payload": {"message": str(error), "conversation_id": conversation_id},
                })
                result["ok"] = False
                return
            if event_type == "session.idle":
                return

    heartbeat_task = asyncio.create_task(send_heartbeat())
    try:
        consume_task = asyncio.create_task(consume())
        # Let the SSE stream attach before prompting so no early tool events are
        # missed on a fast local model/server pair.
        await asyncio.sleep(0.3)
        try:
            parts = await _build_opencode_parts(text, images)
            await opencode_client.prompt(session_id, parts, directory, model_id=model)
        except Exception as exc:
            consume_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consume_task
            await websocket.send_json({
                "type": "agent_error",
                "payload": {"message": f"发送 OpenCode prompt 失败：{exc}", "conversation_id": conversation_id},
            })
            return False
        await consume_task
        if streamed_text["any"]:
            await websocket.send_json({
                "type": "agent_text_done",
                "payload": {"conversation_id": conversation_id},
            })
        return bool(result["ok"])
    finally:
        in_flight["active"] = False
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task


async def _handle_opencode_tool_part(
    websocket: WebSocket,
    conversation_id: str,
    part: dict[str, Any],
    tool_started: set[str],
) -> None:
    raw_name = part.get("tool") or "tool"
    name = _map_tool_name(str(raw_name))
    part_id = str(part.get("id") or "")
    state = part.get("state") or {}
    if not isinstance(state, dict):
        state = {}
    tool_status = state.get("status")
    tool_input = state.get("input") if isinstance(state.get("input"), dict) else {}

    if part_id not in tool_started and tool_status in ("pending", "running"):
        tool_started.add(part_id)
        await _send_status(websocket, conversation_id, "tool", f"调用工具：{name}")
        await websocket.send_json({
            "type": "agent_tool_use",
            "payload": {
                "id": part_id,
                "name": name,
                "input": tool_input,
                "conversation_id": conversation_id,
            },
        })
        return
    if tool_status in ("completed", "error"):
        if part_id not in tool_started:
            tool_started.add(part_id)
            await websocket.send_json({
                "type": "agent_tool_use",
                "payload": {
                    "id": part_id,
                    "name": name,
                    "input": tool_input,
                    "conversation_id": conversation_id,
                },
            })
        output = state.get("output") or state.get("error") or ""
        await websocket.send_json({
            "type": "agent_tool_result",
            "payload": {
                "id": part_id,
                "name": name,
                "output": str(output),
                "is_error": tool_status == "error",
                "conversation_id": conversation_id,
            },
        })


async def _build_opencode_parts(text: str, images: list[Any]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    has_image = False
    for index, image in enumerate(images or []):
        if not isinstance(image, str) or not image.strip():
            continue
        mime, data = split_image_data(image.strip())
        if not data:
            continue
        has_image = True
        extension = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/webp": ".webp",
        }.get(mime, ".bin")
        parts.append({
            "type": "file",
            "mime": mime,
            "filename": f"course_prompt_{index + 1}{extension}",
            "url": image if image.startswith("data:") else f"data:{mime};base64,{data}",
        })
    if text:
        parts.append({"type": "text", "text": text})
    elif has_image:
        parts.append({"type": "text", "text": "请根据上传内容维护课程知识数据。"})
    return parts


# ---------------------------------------------------------------------------
# Optional in-process Anthropic-compatible tool loop
# ---------------------------------------------------------------------------


async def _run_agent_turn(websocket: WebSocket, payload: dict[str, Any]) -> None:
    message = (payload.get("message") or "").strip()
    if not message:
        return
    conversation_id = _safe_conversation_id(payload.get("conversation_id") or "default")
    model = _resolve_opencode_model(payload.get("model"))
    configured_model = model_config.get_model(model)
    api_key = (
        (configured_model.api_key if configured_model else "")
        or settings.anthropic_api_key
        or settings.gateway_api_key
    )
    base_url = (
        (configured_model.base_url if configured_model else "")
        or settings.agent_base_url
    )
    if not api_key:
        await websocket.send_json({
            "type": "agent_error",
            "payload": {"message": "缺少模型 API key", "conversation_id": conversation_id},
        })
        return

    client = anthropic.AsyncAnthropic(base_url=base_url, api_key=api_key)
    history = _histories.setdefault(conversation_id, [])
    history.append({"role": "user", "content": _agent_prompt(message)})
    await websocket.send_json({
        "type": "agent_start",
        "payload": {"conversation_id": conversation_id, "model": model},
    })
    ok = await _run_agent_loop(
        websocket=websocket,
        conversation_id=conversation_id,
        model=model,
        client=client,
        history=history,
    )
    await _send_status(websocket, conversation_id, "done" if ok else "error", "完成" if ok else "Agent 执行失败")
    await websocket.send_json({
        "type": "agent_done",
        "payload": {"return_code": 0 if ok else 1, "conversation_id": conversation_id},
    })


async def _run_agent_loop(
    *,
    websocket: WebSocket,
    conversation_id: str,
    model: str,
    client: anthropic.AsyncAnthropic,
    history: list[dict[str, Any]],
) -> bool:
    _trim_history(history)
    active = {"value": True}

    async def heartbeat() -> None:
        while active["value"]:
            await asyncio.sleep(8)
            if not active["value"]:
                break
            with contextlib.suppress(Exception):
                await websocket.send_json({
                    "type": "agent_heartbeat",
                    "payload": {"conversation_id": conversation_id},
                })

    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        for _ in range(MAX_TOOL_ITERATIONS):
            await _send_status(websocket, conversation_id, "thinking", "模型思考中")
            try:
                final_message = await _stream_one_response(
                    websocket=websocket,
                    conversation_id=conversation_id,
                    model=model,
                    client=client,
                    history=history,
                )
            except Exception as exc:
                await websocket.send_json({
                    "type": "agent_error",
                    "payload": {"message": f"模型请求失败：{exc}", "conversation_id": conversation_id},
                })
                return False

            assistant_content: list[dict[str, Any]] = []
            tool_calls: list[tuple[str, str, dict[str, Any]]] = []
            for block in final_message.content:
                if block.type == "thinking":
                    assistant_content.append({
                        "type": "thinking",
                        "thinking": block.thinking,
                        "signature": block.signature,
                    })
                elif block.type == "redacted_thinking":
                    assistant_content.append({"type": "redacted_thinking", "data": block.data})
                elif block.type == "text":
                    assistant_content.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    tool_input = block.input if isinstance(block.input, dict) else {}
                    assistant_content.append({
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": tool_input,
                    })
                    tool_calls.append((block.id, block.name, tool_input))
            history.append({"role": "assistant", "content": assistant_content})

            if final_message.stop_reason == "max_tokens":
                await websocket.send_json({
                    "type": "agent_error",
                    "payload": {
                        "message": "模型输出达到长度上限，未能完成本轮工具调用。",
                        "conversation_id": conversation_id,
                    },
                })
                return False
            if final_message.stop_reason != "tool_use":
                return True

            tool_results: list[dict[str, Any]] = []
            for tool_id, name, tool_input in tool_calls:
                await websocket.send_json({
                    "type": "agent_tool_use",
                    "payload": {
                        "id": tool_id,
                        "name": name,
                        "input": tool_input,
                        "conversation_id": conversation_id,
                    },
                })
                output, is_error, changed = await _execute_course_tool(
                    websocket, conversation_id, name, tool_input
                )
                await websocket.send_json({
                    "type": "agent_tool_result",
                    "payload": {
                        "id": tool_id,
                        "name": name,
                        "output": output,
                        "is_error": is_error,
                        "conversation_id": conversation_id,
                    },
                })
                if changed:
                    await _emit_course_change(
                        websocket,
                        conversation_id,
                        changed["course_id"],
                        changed["changed_paths"],
                    )
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": output,
                    "is_error": is_error,
                })
            history.append({"role": "user", "content": tool_results})
        return True
    finally:
        active["value"] = False
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task


async def _stream_one_response(
    *,
    websocket: WebSocket,
    conversation_id: str,
    model: str,
    client: anthropic.AsyncAnthropic,
    history: list[dict[str, Any]],
):
    async with client.messages.stream(
        model=model,
        max_tokens=MAX_TOKENS,
        thinking={"type": "enabled", "budget_tokens": THINKING_BUDGET_TOKENS},
        system=_system_prompt(),
        tools=TOOLS,
        messages=history,
    ) as stream:
        async for event in stream:
            if event.type == "content_block_delta" and event.delta.type == "text_delta":
                if event.delta.text:
                    await websocket.send_json({
                        "type": "agent_text_delta",
                        "payload": {"text": event.delta.text, "conversation_id": conversation_id},
                    })
            elif event.type == "content_block_delta" and event.delta.type == "thinking_delta":
                if event.delta.thinking:
                    await websocket.send_json({
                        "type": "agent_thinking_delta",
                        "payload": {"text": event.delta.thinking, "conversation_id": conversation_id},
                    })
            elif event.type == "content_block_stop":
                await websocket.send_json({
                    "type": "agent_text_done",
                    "payload": {"conversation_id": conversation_id},
                })
        return await stream.get_final_message()


def _as_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CourseDataError(f"{name} 必须是对象")
    return value


def _filter_index(index: dict[str, Any], tool_input: dict[str, Any]) -> dict[str, Any]:
    """Keep a full index available but prevent unnecessary tool-context bloat."""

    cluster_id = tool_input.get("cluster_id")
    query = str(tool_input.get("query") or "").strip().lower()
    requested_limit = tool_input.get("limit", 80)
    try:
        limit = max(1, min(int(requested_limit), 250))
    except (TypeError, ValueError):
        limit = 80
    points = list(index.get("points") or [])
    if cluster_id:
        points = [item for item in points if isinstance(item, dict) and item.get("clusterId") == cluster_id]
    if query:
        def matches(item: Any) -> bool:
            if not isinstance(item, dict):
                return False
            corpus = " ".join([
                str(item.get("id", "")),
                str(item.get("title", "")),
                str(item.get("shortSummary", "")),
                " ".join(str(term) for term in item.get("keyTerms") or []),
            ]).lower()
            return query in corpus
        points = [item for item in points if matches(item)]
    total = len(points)
    filtered = _copy_json(index)
    filtered["points"] = points[:limit]
    filtered["totalPoints"] = total
    filtered["truncated"] = total > limit
    return filtered


def _copy_json(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def _tool_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


async def _execute_course_tool(
    websocket: WebSocket,
    conversation_id: str,
    name: str,
    tool_input: dict[str, Any],
) -> tuple[str, bool, dict[str, Any] | None]:
    store = get_course_store()
    try:
        if name == "list_courses":
            await _send_status(websocket, conversation_id, "tool", "读取课程列表")
            return _tool_json({"courses": store.list_courses()}), False, None
        if name == "read_course":
            course_id = str(tool_input.get("course_id") or "")
            await _send_status(websocket, conversation_id, "tool", f"读取课程：{course_id}")
            return _tool_json(store.read_course(course_id)), False, None
        if name == "read_index":
            course_id = str(tool_input.get("course_id") or "")
            await _send_status(websocket, conversation_id, "tool", f"读取课程索引：{course_id}")
            return _tool_json(_filter_index(store.read_index(course_id), tool_input)), False, None
        if name == "read_point":
            course_id = str(tool_input.get("course_id") or "")
            point_id = str(tool_input.get("point_id") or "")
            await _send_status(websocket, conversation_id, "tool", f"读取知识点：{point_id}")
            return _tool_json(store.read_point(course_id, point_id)), False, None
        if name == "validate_course":
            course_id = str(tool_input.get("course_id") or "")
            validation = store.validate_course(course_id)
            return _tool_json({
                "ok": validation.ok,
                "errors": validation.errors,
                "warnings": validation.warnings,
            }), False, None
        if name == "create_course":
            await _send_status(websocket, conversation_id, "tool", "创建课程")
            course = store.create_course(
                _as_object(tool_input.get("course"), "course"),
                tool_input.get("index") if isinstance(tool_input.get("index"), dict) else None,
            )
            course_id = str(course["id"])
            return _tool_json(course), False, {
                "course_id": course_id,
                "changed_paths": ["course.json", "index.json"],
            }
        if name == "update_course":
            course_id = str(tool_input.get("course_id") or "")
            course = store.update_course(course_id, _as_object(tool_input.get("course"), "course"))
            return _tool_json(course), False, {
                "course_id": course_id,
                "changed_paths": ["course.json"],
            }
        if name == "delete_course":
            course_id = str(tool_input.get("course_id") or "")
            store.delete_course(course_id)
            return "课程已删除。", False, {
                "course_id": course_id,
                "changed_paths": ["course.json", "index.json", "points/"],
            }
        if name == "create_cluster":
            course_id = str(tool_input.get("course_id") or "")
            cluster = store.create_cluster(course_id, _as_object(tool_input.get("cluster"), "cluster"))
            return _tool_json(cluster), False, {
                "course_id": course_id,
                "changed_paths": ["course.json", "index.json"],
            }
        if name == "update_cluster":
            course_id = str(tool_input.get("course_id") or "")
            cluster_id = str(tool_input.get("cluster_id") or "")
            cluster = store.update_cluster(
                course_id, cluster_id, _as_object(tool_input.get("cluster"), "cluster")
            )
            return _tool_json(cluster), False, {
                "course_id": course_id,
                "changed_paths": ["course.json", "index.json"],
            }
        if name == "delete_cluster":
            course_id = str(tool_input.get("course_id") or "")
            cluster_id = str(tool_input.get("cluster_id") or "")
            store.delete_cluster(course_id, cluster_id)
            return "知识簇已删除。", False, {
                "course_id": course_id,
                "changed_paths": ["course.json", "index.json"],
            }
        if name == "create_point":
            course_id = str(tool_input.get("course_id") or "")
            point = store.create_point(course_id, _as_object(tool_input.get("point"), "point"))
            point_id = str(point["id"])
            return _tool_json(point), False, {
                "course_id": course_id,
                "changed_paths": ["course.json", "index.json", f"points/{point_id}.json"],
            }
        if name == "update_point":
            course_id = str(tool_input.get("course_id") or "")
            point_id = str(tool_input.get("point_id") or "")
            point = store.update_point(
                course_id, point_id, _as_object(tool_input.get("point"), "point")
            )
            return _tool_json(point), False, {
                "course_id": course_id,
                "changed_paths": ["course.json", "index.json", f"points/{point_id}.json"],
            }
        if name == "delete_point":
            course_id = str(tool_input.get("course_id") or "")
            point_id = str(tool_input.get("point_id") or "")
            store.delete_point(course_id, point_id)
            return "知识点已删除。", False, {
                "course_id": course_id,
                "changed_paths": ["course.json", "index.json", f"points/{point_id}.json"],
            }
        return f"未知工具：{name}", True, None
    except (CourseDataError, ValueError, TypeError) as exc:
        return f"课程数据操作失败：{exc}", True, None
