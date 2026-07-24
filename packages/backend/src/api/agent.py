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
from typing import Any, Literal
import uuid

import anthropic
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

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
from ..services.courses.generation import CourseGenerationObserver
from ..services.conversations import get_conversation_store
from ..services.opencode import client as opencode_client
from ..services.opencode import provision as opencode_provision
from ..services.reviews import (
    CourseReviewError,
    RESUME_CLAIM_HEARTBEAT_SECONDS,
    get_course_review_store,
    is_strict_g2_successor,
)
from ..services.reviews.activity import (
    CourseActivityConflictError,
    get_course_activity_coordinator,
)


router = APIRouter()

COURSE_SYSTEM_PROMPT_PATH = (
    Path(__file__).parent.parent / "services" / "ai" / "prompts" / "system_course_agent.md"
)
MAX_TOOL_ITERATIONS = 24
MAX_TOKENS = 32000
THINKING_BUDGET_TOKENS = 1024
MAX_HISTORY_MESSAGES = 40
MAX_DISPLAY_CONTENT_CHARS = 500

# Per-conversation message history powers the optional in-process tool loop.
_histories: dict[str, list[dict[str, Any]]] = {}
# OpenCode owns its own memory; this map only lets reconnecting WebSocket turns
# continue the same OpenCode session.
_opencode_sessions: dict[str, str] = {}
# Native OpenCode questions outlive the WebSocket request handler while the
# model is paused. The browser answers them over a small HTTP endpoint so the
# same OpenCode turn can resume without starting a second chat turn.
_pending_questions: dict[str, dict[str, Any]] = {}

InteractionMode = Literal["chat", "agent"]
AgentWorkflow = Literal["default", "course-create"]


def forget_opencode_conversation(
    conversation_id: str,
    session_id: str | None = None,
) -> None:
    """Drop process-local state after a durable conversation is deleted."""

    safe_id = _safe_conversation_id(conversation_id)
    for key, cached_session_id in list(_opencode_sessions.items()):
        if key.endswith(f":{safe_id}") or (
            session_id is not None and cached_session_id == session_id
        ):
            _opencode_sessions.pop(key, None)
    if session_id:
        _clear_pending_questions_for_session(session_id)


class AgentQuestionReply(BaseModel):
    conversation_id: str
    answers: list[list[str]] = Field(min_length=1, max_length=8)


class AgentQuestionReject(BaseModel):
    conversation_id: str


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


def _pending_question_for(request_id: str, conversation_id: str) -> dict[str, Any]:
    pending = _pending_questions.get(request_id)
    if not pending or pending.get("conversation_id") != _safe_conversation_id(conversation_id):
        raise HTTPException(status_code=404, detail="待确认问题不存在或已经处理")
    return pending


def pending_question_for_conversation(
    conversation_id: str,
) -> dict[str, Any] | None:
    """Return a restorable question card after a missed websocket event."""

    safe_id = _safe_conversation_id(conversation_id)
    for request_id, pending in reversed(list(_pending_questions.items())):
        if pending.get("conversation_id") != safe_id:
            continue
        questions = _normalize_opencode_questions(pending.get("questions"))
        if not questions:
            continue
        return {
            "request_id": request_id,
            "conversation_id": safe_id,
            "questions": questions,
        }
    return None


def _normalize_opencode_questions(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    questions: list[dict[str, Any]] = []
    for index, item in enumerate(value[:8]):
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("question") or "").strip()
        if not prompt:
            continue
        options: list[dict[str, str]] = []
        raw_options = item.get("options") if isinstance(item.get("options"), list) else []
        for option in raw_options[:12]:
            if not isinstance(option, dict):
                continue
            label = str(option.get("label") or "").strip()
            if not label:
                continue
            options.append({
                "label": label,
                "description": str(option.get("description") or "").strip(),
            })
        questions.append({
            "header": str(item.get("header") or f"问题 {index + 1}").strip(),
            "question": prompt,
            "options": options,
            "multiple": bool(item.get("multiple", False)),
            "custom": item.get("custom") is not False,
        })
    return questions


def _normalize_question_answers(
    pending: dict[str, Any], answers: list[list[str]]
) -> list[list[str]]:
    questions = pending.get("questions") if isinstance(pending.get("questions"), list) else []
    if len(answers) != len(questions):
        raise HTTPException(status_code=422, detail="回答数量与问题数量不一致")

    normalized: list[list[str]] = []
    for answer in answers:
        values = [str(value).strip() for value in answer if str(value).strip()]
        if not values:
            raise HTTPException(status_code=422, detail="每个问题都需要至少一个答案")
        normalized.append(values[:12])
    return normalized


def _question_answer_content(pending: dict[str, Any], answers: list[list[str]]) -> str:
    questions = pending.get("questions") if isinstance(pending.get("questions"), list) else []
    lines: list[str] = []
    for index, answer in enumerate(answers):
        question = questions[index] if index < len(questions) and isinstance(questions[index], dict) else {}
        header = str(question.get("header") or f"问题 {index + 1}").strip()
        lines.append(f"{header}：{'、'.join(answer)}")
    return "确认选择\n" + "\n".join(lines)


def _question_history_content(questions: list[dict[str, Any]]) -> str:
    """Render native question cards into durable, readable history text."""

    sections: list[str] = ["需要你的确认："]
    for question in questions:
        header = str(question.get("header") or "确认事项").strip()
        prompt = str(question.get("question") or "").strip()
        lines = [f"### {header}", prompt]
        options = question.get("options") if isinstance(question.get("options"), list) else []
        if options:
            lines.append("")
            lines.append("可选项：")
            for option in options:
                label = str(option.get("label") or "").strip()
                description = str(option.get("description") or "").strip()
                lines.append(f"- {label}" + (f"：{description}" if description else ""))
        sections.append("\n".join(lines))
    return "\n\n".join(sections)


def _clear_pending_questions_for_session(session_id: str | None) -> None:
    if not session_id:
        return
    stale = [
        request_id
        for request_id, pending in _pending_questions.items()
        if pending.get("session_id") == session_id
    ]
    for request_id in stale:
        _pending_questions.pop(request_id, None)


@router.post("/questions/{request_id}/reply")
async def reply_to_agent_question(request_id: str, body: AgentQuestionReply):
    pending = _pending_question_for(request_id, body.conversation_id)
    answers = _normalize_question_answers(pending, body.answers)
    content = _question_answer_content(pending, answers)
    await asyncio.to_thread(
        get_conversation_store().add_message,
        pending["conversation_id"],
        role="user",
        content=content,
        message_id=f"question-reply:{request_id}",
    )
    try:
        await opencode_client.reply_question(request_id, answers, pending["directory"])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"提交确认失败：{exc}") from exc
    _pending_questions.pop(request_id, None)
    return {"ok": True, "content": content}


@router.post("/questions/{request_id}/reject")
async def reject_agent_question(request_id: str, body: AgentQuestionReject):
    pending = _pending_question_for(request_id, body.conversation_id)
    content = "暂不回答当前确认问题"
    await asyncio.to_thread(
        get_conversation_store().add_message,
        pending["conversation_id"],
        role="user",
        content=content,
        message_id=f"question-reject:{request_id}",
    )
    try:
        await opencode_client.reject_question(request_id, pending["directory"])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"取消确认失败：{exc}") from exc
    _pending_questions.pop(request_id, None)
    return {"ok": True, "content": content}


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


def _chat_prompt(message: str) -> str:
    return (
        f"用户问题：\n{message}\n\n"
        "当前是只读 Chat 模式。请仅根据课程数据进行查询、解释和回答；"
        "不得创建、编辑或删除文件。若用户要求修改课程，请提示切换到 Agent 模式。"
    )


def _request_mode(payload: dict[str, Any]) -> InteractionMode:
    return "chat" if str(payload.get("mode") or "agent").lower() == "chat" else "agent"


def _request_workflow(payload: dict[str, Any]) -> AgentWorkflow:
    if _request_mode(payload) == "agent" and payload.get("workflow") == "course-create":
        return "course-create"
    return "default"


def _request_history_content(
    payload: dict[str, Any],
    message: str,
    images: list[Any],
) -> str:
    display_content = payload.get("display_content")
    if isinstance(display_content, str) and display_content.strip():
        return display_content.strip()[:MAX_DISPLAY_CONTENT_CHARS]
    return message or (f"发送了 {len(images)} 张图片" if images else "")


def _course_creation_prompt(message: str) -> str:
    return (
        "当前是 Course Studio 的课程创建工作流。必须加载并遵循 "
        "knowledge-pipeline-orchestrator Skill，通过多轮对话推进 v2 的 G0-G7 门禁和最终发布确认。\n\n"
        f"用户本轮输入：\n{message}\n\n"
        "G0 范围补充和 G7 最终发布确认必须调用 question 工具提供选项和自定义填写，"
        "不要只在普通回复末尾提问。G2 知识点清单审核和 G6 知识簇及前后依赖审核必须调用 "
        "course_pipeline 的结构化审核动作；进入 pending 后结束当前 turn，由 Course Studio "
        "审核工作区完成，不能用聊天文字或 question 替代。知识点正文与动画不进入生成期人工审核，"
        "但必须通过全部自动结构、构建、安全和完整性校验。不要在 G6 审核通过、用户明确确认发布"
        "且 G7 校验通过前生成 courses 下的正式课程。"
        "不得生成或继续使用 v1 中间产物。"
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


async def _pending_review(conversation_id: str) -> dict[str, Any] | None:
    review_store = get_course_review_store()
    resources = await asyncio.to_thread(
        review_store.pending_for_conversation,
        conversation_id,
    )
    if not resources:
        return None
    return review_store.pointer(resources[0])


async def _pending_review_resume(conversation_id: str) -> dict[str, Any] | None:
    review_store = get_course_review_store()
    resource = await asyncio.to_thread(
        review_store.resume_pending_for_conversation,
        conversation_id,
    )
    return review_store.pointer(resource) if resource else None


async def _finish_for_review(
    websocket: WebSocket,
    conversation_id: str,
    mode: InteractionMode,
    review: dict[str, Any],
) -> None:
    await _send_status(websocket, conversation_id, "waiting", "等待课程审核")
    await websocket.send_json({
        "type": "agent_review_required",
        "payload": review,
    })
    await websocket.send_json({
        "type": "agent_done",
        "payload": {
            "return_code": 0,
            "conversation_id": conversation_id,
            "mode": mode,
            "awaiting_review": True,
            "review_id": review["id"],
        },
    })


async def _resume_claim_heartbeat(
    review_store: Any,
    review_id: str,
    conversation_id: str,
    claim_id: str,
) -> None:
    while True:
        await asyncio.sleep(RESUME_CLAIM_HEARTBEAT_SECONDS)
        await asyncio.to_thread(
            review_store.renew_resume_claim,
            review_id,
            conversation_id=conversation_id,
            claim_id=claim_id,
        )


async def _await_prompt_with_resume_heartbeat(
    prompt: Any,
    *,
    heartbeat_task: asyncio.Task[None],
    session_id: str,
) -> tuple[bool, str]:
    prompt_task = asyncio.create_task(prompt)
    try:
        done, _ = await asyncio.wait(
            {prompt_task, heartbeat_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if heartbeat_task in done:
            try:
                await heartbeat_task
            finally:
                prompt_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await prompt_task
                with contextlib.suppress(Exception):
                    await opencode_client.abort(session_id)
            raise CourseReviewError("审核恢复 claim 续租意外停止")
        return await prompt_task
    except BaseException:
        if not prompt_task.done():
            prompt_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await prompt_task
            with contextlib.suppress(Exception):
                await opencode_client.abort(session_id)
        raise


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
                if _request_workflow(payload) == "course-create":
                    await websocket.send_json({
                        "type": "agent_error",
                        "payload": {
                            "message": "课程创建流程依赖 OpenCode Skill，请先启用并启动 OpenCode 服务。",
                            "conversation_id": payload.get("conversation_id") or "default",
                        },
                    })
                    continue
                if _request_mode(payload) == "chat":
                    await websocket.send_json({
                        "type": "agent_error",
                        "payload": {
                            "message": "只读 Chat 模式需要启用 OpenCode 服务。",
                            "conversation_id": payload.get("conversation_id") or "default",
                        },
                    })
                    continue
                await _run_agent_turn(websocket, payload)
    except WebSocketDisconnect:
        session_id = active_opencode_session.get("id")
        if session_id:
            _clear_pending_questions_for_session(session_id)
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
    if _request_workflow(payload) != "course-create":
        await _run_agent_turn_opencode_unlocked(websocket, payload, active_session)
        return

    conversation_id = _safe_conversation_id(
        payload.get("conversation_id") or "default"
    )
    coordinator = get_course_activity_coordinator()
    try:
        lease = coordinator.claim(conversation_id, "agent-turn")
    except CourseActivityConflictError as exc:
        active_session["id"] = None
        await websocket.send_json({
            "type": "agent_error",
            "payload": {
                "code": "course_activity_conflict",
                "message": str(exc),
                "conversation_id": conversation_id,
            },
        })
        await websocket.send_json({
            "type": "agent_done",
            "payload": {
                "return_code": 1,
                "conversation_id": conversation_id,
                "mode": _request_mode(payload),
            },
        })
        return

    turn_task: asyncio.Task[None] | None = None
    try:
        turn_task = asyncio.create_task(
            _run_agent_turn_opencode_unlocked(websocket, payload, active_session)
        )
        await asyncio.shield(turn_task)
    except asyncio.CancelledError:
        session_id = active_session.get("id")
        if session_id:
            _clear_pending_questions_for_session(session_id)
            abort_task = asyncio.create_task(opencode_client.abort(session_id))
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.shield(abort_task)
        raise
    except BaseException:
        session_id = active_session.get("id")
        if session_id:
            _clear_pending_questions_for_session(session_id)
            with contextlib.suppress(Exception):
                await opencode_client.abort(session_id)
        raise
    finally:
        if turn_task is None or turn_task.done():
            coordinator.release(lease)
        else:
            def release_when_done(completed: asyncio.Task[None]) -> None:
                coordinator.release(lease)
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    completed.result()

            turn_task.add_done_callback(release_when_done)


async def _run_agent_turn_opencode_unlocked(
    websocket: WebSocket,
    payload: dict[str, Any],
    active_session: dict[str, str | None],
) -> None:
    message = (payload.get("message") or "").strip()
    images = payload.get("images") or []
    review_resume_id = str(payload.get("review_resume_id") or "").strip()
    if not message and not images and not review_resume_id:
        return

    conversation_id = _safe_conversation_id(payload.get("conversation_id") or "default")
    mode = _request_mode(payload)
    workflow = _request_workflow(payload)
    creating_course = workflow == "course-create"
    readonly = mode == "chat"
    resume_response: dict[str, Any] | None = None
    review_store = get_course_review_store() if creating_course else None

    if review_resume_id:
        if not creating_course:
            await websocket.send_json({
                "type": "agent_error",
                "payload": {
                    "message": "审核恢复只允许用于课程创建工作流。",
                    "conversation_id": conversation_id,
                },
            })
            await websocket.send_json({
                "type": "agent_done",
                "payload": {
                    "return_code": 1,
                    "conversation_id": conversation_id,
                    "mode": mode,
                },
            })
            return
        try:
            assert review_store is not None
            resume_response = await asyncio.to_thread(
                review_store.get_resume,
                review_resume_id,
                conversation_id=conversation_id,
            )
        except CourseReviewError as exc:
            await websocket.send_json({
                "type": "agent_error",
                "payload": {
                    "message": f"审核恢复请求无效：{exc}",
                    "conversation_id": conversation_id,
                },
            })
            await websocket.send_json({
                "type": "agent_done",
                "payload": {
                    "return_code": 1,
                    "conversation_id": conversation_id,
                    "mode": mode,
                },
            })
            return
        message = str(resume_response["resume_message"])
        images = []

    if creating_course:
        try:
            assert review_store is not None
            review = await _pending_review(conversation_id)
            if not review_resume_id and not review:
                resume = await _pending_review_resume(conversation_id)
                if resume:
                    await _finish_for_review(
                        websocket,
                        conversation_id,
                        mode,
                        resume,
                    )
                    active_session["id"] = None
                    return
        except CourseReviewError as exc:
            await websocket.send_json({
                "type": "agent_error",
                "payload": {
                    "message": f"课程审核任务无法读取：{exc}",
                    "conversation_id": conversation_id,
                },
            })
            await websocket.send_json({
                "type": "agent_done",
                "payload": {
                    "return_code": 1,
                    "conversation_id": conversation_id,
                    "mode": mode,
                },
            })
            active_session["id"] = None
            return
        if review:
            # If G2 already produced a durable downstream G6 marker, a retry
            # must advance to that marker instead of replaying content work.
            if (
                resume_response is not None
                and is_strict_g2_successor(resume_response.get("review"), review)
            ):
                recovery_claim_id = f"agent:{uuid.uuid4()}"
                try:
                    claimed = await asyncio.to_thread(
                        review_store.claim_resume,
                        review_resume_id,
                        conversation_id=conversation_id,
                        claim_id=recovery_claim_id,
                    )
                    if not is_strict_g2_successor(claimed.get("review"), review):
                        raise CourseReviewError(
                            "审核恢复的下游知识图谱标记与当前课程不匹配"
                        )
                    completed = await asyncio.to_thread(
                        review_store.complete_resume,
                        review_resume_id,
                        conversation_id=conversation_id,
                        claim_id=recovery_claim_id,
                    )
                except CourseReviewError as exc:
                    with contextlib.suppress(Exception):
                        await asyncio.to_thread(
                            review_store.release_resume,
                            review_resume_id,
                            conversation_id=conversation_id,
                            claim_id=recovery_claim_id,
                        )
                    await websocket.send_json({
                        "type": "agent_error",
                        "payload": {
                            "message": f"审核恢复状态无法完成：{exc}",
                            "conversation_id": conversation_id,
                        },
                    })
                    await websocket.send_json({
                        "type": "agent_done",
                        "payload": {
                            "return_code": 1,
                            "conversation_id": conversation_id,
                            "mode": mode,
                        },
                    })
                    active_session["id"] = None
                    return
                await websocket.send_json({
                    "type": "agent_review_resolved",
                    "payload": {
                        "review": review_store.pointer(completed["review"]),
                        "conversation_id": conversation_id,
                    },
                })
            await _finish_for_review(websocket, conversation_id, mode, review)
            active_session["id"] = None
            return

    history_content = (
        str(resume_response["display_content"])
        if resume_response is not None
        else _request_history_content(payload, message, images)
    )
    model = _resolve_opencode_model(payload.get("model"))
    conversation_store = get_conversation_store()
    await asyncio.to_thread(
        conversation_store.ensure_conversation,
        conversation_id,
        mode=mode,
        workflow=workflow,
        model=model,
        title_hint=history_content,
    )
    if resume_response is None:
        await asyncio.to_thread(
            conversation_store.add_message,
            conversation_id,
            role="user",
            content=history_content,
            images=images,
            message_id=payload.get("request_id"),
        )
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

    await _send_status(
        websocket,
        conversation_id,
        "provision",
        "正在恢复课程工作区" if creating_course else "正在准备课程工作区",
    )
    try:
        if readonly:
            workspace = await asyncio.to_thread(
                opencode_provision.ensure_course_chat_session_assets,
                conversation_id,
            )
            directory = opencode_provision.host_course_workspace_dir(workspace)
        elif creating_course:
            workspace = await asyncio.to_thread(
                opencode_provision.ensure_course_creation_session_assets,
                conversation_id,
            )
            directory = opencode_provision.host_course_creation_workspace_dir(workspace)
        else:
            workspace = await asyncio.to_thread(
                opencode_provision.ensure_course_session_assets,
                conversation_id,
            )
            directory = opencode_provision.host_course_workspace_dir(workspace)
    except (CourseDataError, OSError) as exc:
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
                "message": (
                    "无法连接 OpenCode 服务，请先运行 scripts/opencode-service.sh start；"
                    "Windows 请运行 scripts/opencode.ps1。"
                ),
                "conversation_id": conversation_id,
            },
        })
        return

    try:
        session_key = f"{mode}:{workflow}:{conversation_id}"
        session_id = _opencode_sessions.get(session_key) or await asyncio.to_thread(
            conversation_store.get_opencode_session,
            conversation_id,
        )
        if not session_id:
            session_id = await opencode_client.create_session(
                directory, title=f"{mode}:{workflow}:{conversation_id}"
            )
            await asyncio.to_thread(
                conversation_store.set_opencode_session,
                conversation_id,
                session_id,
            )
        _opencode_sessions[session_key] = session_id
    except Exception as exc:
        await websocket.send_json({
            "type": "agent_error",
            "payload": {"message": f"创建 OpenCode 会话失败：{exc}", "conversation_id": conversation_id},
        })
        return

    course_agent_name: str | None = None
    if creating_course:
        assert review_store is not None
        resume_course_id = (
            str(resume_response["review"].get("course_id") or "")
            if resume_response is not None
            else ""
        )
        try:
            if resume_course_id:
                identity_reviewed = await asyncio.to_thread(
                    review_store.has_resolved_knowledge_review,
                    conversation_id,
                    resume_course_id,
                )
            else:
                identity_reviewed = (
                    await asyncio.to_thread(
                        review_store.resolved_knowledge_course_for_conversation,
                        conversation_id,
                    )
                    is not None
                )
        except CourseReviewError as exc:
            await websocket.send_json({
                "type": "agent_error",
                "payload": {
                    "message": f"无法验证课程创建权限阶段：{exc}",
                    "conversation_id": conversation_id,
                },
            })
            await websocket.send_json({
                "type": "agent_done",
                "payload": {
                    "return_code": 1,
                    "conversation_id": conversation_id,
                    "mode": mode,
                },
            })
            active_session["id"] = None
            return
        course_agent_name = (
            "course-creator" if identity_reviewed else "course-outline-creator"
        )

    resume_claim_id: str | None = None
    resume_claim_active = False
    resume_claim_heartbeat_task: asyncio.Task[None] | None = None

    async def stop_resume_claim_heartbeat() -> None:
        nonlocal resume_claim_heartbeat_task
        if resume_claim_heartbeat_task is None:
            return
        task = resume_claim_heartbeat_task
        resume_claim_heartbeat_task = None
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task

    async def ensure_resume_claim_heartbeat() -> None:
        task = resume_claim_heartbeat_task
        if not resume_claim_active or task is None or not task.done():
            return
        try:
            await task
        except asyncio.CancelledError as exc:
            raise CourseReviewError("审核恢复 claim 续租意外停止") from exc
        raise CourseReviewError("审核恢复 claim 续租意外停止")

    async def release_resume_claim() -> None:
        nonlocal resume_claim_active
        if (
            not resume_claim_active
            or resume_claim_id is None
            or review_store is None
        ):
            return
        try:
            await asyncio.to_thread(
                review_store.release_resume,
                review_resume_id,
                conversation_id=conversation_id,
                claim_id=resume_claim_id,
            )
        finally:
            resume_claim_active = False
            await stop_resume_claim_heartbeat()

    async def complete_resume_claim() -> dict[str, Any] | None:
        nonlocal resume_claim_active
        if (
            not resume_claim_active
            or resume_claim_id is None
            or review_store is None
        ):
            return None
        await ensure_resume_claim_heartbeat()
        response = await asyncio.to_thread(
            review_store.complete_resume,
            review_resume_id,
            conversation_id=conversation_id,
            claim_id=resume_claim_id,
        )
        resume_claim_active = False
        await stop_resume_claim_heartbeat()
        return response

    if resume_response is not None and review_store is not None:
        resume_claim_id = f"agent:{uuid.uuid4()}"
        try:
            resume_response = await asyncio.to_thread(
                review_store.claim_resume,
                review_resume_id,
                conversation_id=conversation_id,
                claim_id=resume_claim_id,
            )
            resume_claim_active = True
            resume_claim_heartbeat_task = asyncio.create_task(
                _resume_claim_heartbeat(
                    review_store,
                    review_resume_id,
                    conversation_id,
                    resume_claim_id,
                )
            )
            message = str(resume_response["resume_message"])
            await asyncio.to_thread(
                conversation_store.add_message,
                conversation_id,
                role="user",
                content=str(resume_response["display_content"]),
                images=[],
                message_id=f"review-resume:{review_resume_id}",
            )
        except CourseReviewError as exc:
            if resume_claim_active:
                with contextlib.suppress(Exception):
                    await release_resume_claim()
            await websocket.send_json({
                "type": "agent_error",
                "payload": {
                    "message": f"审核恢复请求无法领取：{exc}",
                    "conversation_id": conversation_id,
                },
            })
            await websocket.send_json({
                "type": "agent_done",
                "payload": {
                    "return_code": 1,
                    "conversation_id": conversation_id,
                    "mode": mode,
                },
            })
            active_session["id"] = None
            return

    active_session["id"] = session_id
    await websocket.send_json({
        "type": "agent_start",
        "payload": {
            "conversation_id": conversation_id,
            "model": model,
            "mode": mode,
            "workflow": workflow,
        },
    })
    generation_observer: CourseGenerationObserver | None = None
    generation_observer_task: asyncio.Task[None] | None = None
    workspace_path = getattr(workspace, "path", None)
    if creating_course and workspace_path is not None:
        generation_observer = CourseGenerationObserver(
            Path(workspace_path).parent / "pipeline",
            conversation_id,
        )
        generation_observer_task = asyncio.create_task(
            generation_observer.run(websocket.send_json)
        )
    if readonly:
        prompt = _chat_prompt(message) if message else "请只读分析上传内容并回答问题。"
    elif creating_course:
        prompt = _course_creation_prompt(message)
    else:
        prompt = _agent_prompt(message) if message else "请根据上传内容维护课程知识数据。"
    try:
        prompt_call = _run_opencode_prompt(
            websocket=websocket,
            conversation_id=conversation_id,
            session_id=session_id,
            directory=directory,
            text=prompt,
            images=images,
            model=model,
            agent_name=course_agent_name,
            terminal_timeout_seconds=(
                settings.course_create_terminal_timeout_seconds
                if creating_course
                else None
            ),
        )
        if resume_claim_heartbeat_task is not None:
            ok, response_text = await _await_prompt_with_resume_heartbeat(
                prompt_call,
                heartbeat_task=resume_claim_heartbeat_task,
                session_id=session_id,
            )
        else:
            ok, response_text = await prompt_call
    except BaseException:
        if resume_claim_active:
            with contextlib.suppress(Exception):
                await release_resume_claim()
        active_session["id"] = None
        raise
    finally:
        if generation_observer_task is not None:
            generation_observer_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await generation_observer_task
        if generation_observer is not None:
            # Capture a final write made immediately before OpenCode's idle
            # event without leaving a background task attached to the socket.
            with contextlib.suppress(Exception):
                await generation_observer.emit_if_changed(websocket.send_json)
    try:
        if response_text:
            await asyncio.to_thread(
                conversation_store.add_message,
                conversation_id,
                role="assistant",
                content=response_text,
            )
    except BaseException:
        if resume_claim_active:
            with contextlib.suppress(Exception):
                await release_resume_claim()
        active_session["id"] = None
        raise

    if readonly:
        try:
            opencode_provision.restore_course_chat_session(workspace)
        except CourseDataError as exc:
            await websocket.send_json({
                "type": "agent_error",
                "payload": {
                    "message": f"只读工作区恢复失败：{exc}",
                    "conversation_id": conversation_id,
                    "mode": mode,
                },
            })
            ok = False

        await _send_status(
            websocket,
            conversation_id,
            "done" if ok else "error",
            "回答完成" if ok else "Chat 执行失败",
        )
        await websocket.send_json({
            "type": "agent_done",
            "payload": {
                "return_code": 0 if ok else 1,
                "conversation_id": conversation_id,
                "mode": mode,
            },
        })
        active_session["id"] = None
        return

    if not ok:
        if resume_claim_active:
            with contextlib.suppress(Exception):
                await release_resume_claim()
        await _send_status(websocket, conversation_id, "error", "Agent 执行失败")
        await websocket.send_json({
            "type": "agent_done",
            "payload": {"return_code": 1, "conversation_id": conversation_id, "mode": mode},
        })
        active_session["id"] = None
        return

    if creating_course:
        try:
            review = await _pending_review(conversation_id)
        except CourseReviewError as exc:
            if resume_claim_active:
                with contextlib.suppress(Exception):
                    await release_resume_claim()
            await websocket.send_json({
                "type": "agent_error",
                "payload": {
                    "message": f"课程审核任务无法创建：{exc}",
                    "conversation_id": conversation_id,
                },
            })
            await websocket.send_json({
                "type": "agent_done",
                "payload": {
                    "return_code": 1,
                    "conversation_id": conversation_id,
                    "mode": mode,
                },
            })
            active_session["id"] = None
            return
        if review:
            completed_response: dict[str, Any] | None = None
            if (
                resume_claim_active
                and resume_response is not None
                and is_strict_g2_successor(
                    resume_response.get("review"),
                    review,
                )
            ):
                try:
                    completed_response = await complete_resume_claim()
                except CourseReviewError as exc:
                    with contextlib.suppress(Exception):
                        await release_resume_claim()
                    await websocket.send_json({
                        "type": "agent_error",
                        "payload": {
                            "message": f"审核恢复状态无法完成：{exc}",
                            "conversation_id": conversation_id,
                        },
                    })
                    await websocket.send_json({
                        "type": "agent_done",
                        "payload": {
                            "return_code": 1,
                            "conversation_id": conversation_id,
                            "mode": mode,
                        },
                    })
                    active_session["id"] = None
                    return
            elif resume_claim_active:
                # A different pending marker does not prove that this resume
                # turn reached the required durable successor.
                await release_resume_claim()

            if completed_response is not None and review_store is not None:
                await websocket.send_json({
                    "type": "agent_review_resolved",
                    "payload": {
                        "review": review_store.pointer(completed_response["review"]),
                        "conversation_id": conversation_id,
                    },
                })
            await _finish_for_review(websocket, conversation_id, mode, review)
            active_session["id"] = None
            return

        if (
            resume_claim_active
            and isinstance(resume_response, dict)
            and isinstance(resume_response.get("review"), dict)
            and resume_response["review"].get("kind") == "knowledge-points"
        ):
            await release_resume_claim()
            await websocket.send_json({
                "type": "agent_error",
                "payload": {
                    "message": (
                        "知识点审核恢复未生成同课程的知识图谱审核，"
                        "已保留恢复任务供重试。"
                    ),
                    "conversation_id": conversation_id,
                },
            })
            await websocket.send_json({
                "type": "agent_done",
                "payload": {
                    "return_code": 1,
                    "conversation_id": conversation_id,
                    "mode": mode,
                },
            })
            active_session["id"] = None
            return

    try:
        await ensure_resume_claim_heartbeat()
    except CourseReviewError as exc:
        if resume_claim_active:
            with contextlib.suppress(Exception):
                await release_resume_claim()
        await websocket.send_json({
            "type": "agent_error",
            "payload": {
                "message": f"审核恢复状态已失效：{exc}",
                "conversation_id": conversation_id,
            },
        })
        await websocket.send_json({
            "type": "agent_done",
            "payload": {
                "return_code": 1,
                "conversation_id": conversation_id,
                "mode": mode,
            },
        })
        active_session["id"] = None
        return

    await _send_status(websocket, conversation_id, "commit", "校验并提交课程数据")
    try:
        committed = await asyncio.to_thread(
            get_course_store().commit_workspace,
            workspace,
        )
        await ensure_resume_claim_heartbeat()
    except CourseReviewError as exc:
        if resume_claim_active:
            with contextlib.suppress(Exception):
                await release_resume_claim()
        await websocket.send_json({
            "type": "agent_error",
            "payload": {
                "message": f"课程已校验，但审核恢复租约失效：{exc}",
                "conversation_id": conversation_id,
            },
        })
        await websocket.send_json({
            "type": "agent_done",
            "payload": {
                "return_code": 1,
                "conversation_id": conversation_id,
                "mode": mode,
            },
        })
        active_session["id"] = None
        return
    except CourseValidationError as exc:
        if resume_claim_active:
            with contextlib.suppress(Exception):
                await release_resume_claim()
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
        if resume_claim_active:
            with contextlib.suppress(Exception):
                await release_resume_claim()
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
        if resume_claim_active:
            with contextlib.suppress(Exception):
                await release_resume_claim()
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

    completed_response = None
    if resume_claim_active:
        try:
            completed_response = await complete_resume_claim()
        except CourseReviewError as exc:
            with contextlib.suppress(Exception):
                await release_resume_claim()
            await websocket.send_json({
                "type": "agent_error",
                "payload": {
                    "message": (
                        "课程数据已提交，但审核恢复状态无法完成："
                        f"{exc}。可重新进入该会话安全重试。"
                    ),
                    "conversation_id": conversation_id,
                },
            })
            await websocket.send_json({
                "type": "agent_done",
                "payload": {
                    "return_code": 1,
                    "conversation_id": conversation_id,
                    "mode": mode,
                },
            })
            active_session["id"] = None
            return

    if completed_response is not None and review_store is not None:
        await websocket.send_json({
            "type": "agent_review_resolved",
            "payload": {
                "review": review_store.pointer(completed_response["review"]),
                "conversation_id": conversation_id,
            },
        })

    if committed.get("changed_paths"):
        await _emit_committed_workspace_changes(websocket, conversation_id, committed)
    if generation_observer is not None:
        with contextlib.suppress(Exception):
            final_snapshot = await generation_observer.emit_if_changed(
                websocket.send_json
            )
            generated_course = final_snapshot.get("course")
            generated_course_id = (
                generated_course.get("id")
                if isinstance(generated_course, dict)
                else ""
            )
            staged_course = Path(workspace.path) / str(generated_course_id)
            # A successful no-diff retry still deserves G7 when the generated
            # package is already present in the validated staged/canonical tree.
            # Merely reaching G6 in pipeline files is not enough.
            if (
                generated_course_id
                and staged_course.is_dir()
                and not staged_course.is_symlink()
            ):
                await generation_observer.emit_if_changed(
                    websocket.send_json,
                    published=True,
                )
    if committed.get("warnings"):
        await _send_status(websocket, conversation_id, "warning", "课程数据存在历史兼容性提示")
    await _send_status(websocket, conversation_id, "done", "完成")
    await websocket.send_json({
        "type": "agent_done",
        "payload": {"return_code": 0, "conversation_id": conversation_id, "mode": mode},
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
    agent_name: str | None = None,
    terminal_timeout_seconds: float | None = None,
) -> tuple[bool, str]:
    """Stream OpenCode SSE events into the existing agent WebSocket protocol."""

    in_flight = {"active": True}
    active_text = {"any": False}
    text_chunks: list[str] = []
    tool_started: set[str] = set()
    result: dict[str, Any] = {"ok": True, "abort": False}
    critical_tool_errors: dict[str, str] = {}
    part_types: dict[str, str] = {}
    waiting_question_ids: set[str] = set()
    terminal_wait_state_changed = asyncio.Event()

    async def fail_turn(message: str, *, abort: bool = False) -> None:
        result["ok"] = False
        result["abort"] = bool(result["abort"] or abort)
        await websocket.send_json({
            "type": "agent_error",
            "payload": {"message": message, "conversation_id": conversation_id},
        })

    def set_question_waiting(request_id: str, waiting: bool) -> None:
        if waiting:
            waiting_question_ids.add(request_id)
        else:
            waiting_question_ids.discard(request_id)
        terminal_wait_state_changed.set()

    async def finish_text_segment(*, persist: bool) -> str:
        content = "".join(text_chunks).strip()
        text_chunks.clear()
        if active_text["any"]:
            await websocket.send_json({
                "type": "agent_text_done",
                "payload": {"conversation_id": conversation_id},
            })
            active_text["any"] = False
        if persist and content:
            await asyncio.to_thread(
                get_conversation_store().add_message,
                conversation_id,
                role="assistant",
                content=content,
            )
        return content

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

    def critical_tool_key(part: dict[str, Any]) -> str | None:
        """Identify publish failures that must not be reported as a successful turn.

        Validators and exploratory shell commands may legitimately fail before
        the model repairs and reruns them.  Treating every tool error as fatal
        would reject a successfully recovered course.  Publication is the
        irreversible terminal operation, so an unsuccessful publish remains
        fatal until a later successful publish invocation clears it.
        """

        state = part.get("state") or {}
        if not isinstance(state, dict):
            return None
        tool_input = state.get("input") or {}
        if not isinstance(tool_input, dict):
            return None
        command = str(tool_input.get("command") or tool_input.get("cmd") or "")
        if "publish-course-pipeline.mjs" in command:
            return "publish-course-pipeline"
        return None

    async def consume() -> None:
        await _send_status(websocket, conversation_id, "thinking", "模型思考中")
        try:
            async for envelope in opencode_client.events():
                payload = envelope.get("payload") or {}
                event_type = payload.get("type")
                properties = payload.get("properties") or {}
                if not isinstance(properties, dict):
                    properties = {}
                if event_type in ("server.connected", "server.heartbeat", "sync"):
                    continue
                if event_type == "permission.asked":
                    # Sub-agent events carry the child session id, so the usual
                    # session filter would hide them from the parent turn.  A
                    # course-creation conversation owns a unique workspace;
                    # use that directory to fail fast instead of leaving the UI
                    # waiting on an invisible OpenCode permission dialog.
                    event_directory = envelope.get("directory")
                    event_session_id = str(properties.get("sessionID") or "").strip()
                    if event_session_id == session_id or event_directory == directory:
                        request_id = str(properties.get("id") or "").strip()
                        permission = str(properties.get("permission") or "unknown").strip()
                        reject_error = ""
                        if request_id:
                            try:
                                await opencode_client.reject_permission(
                                    request_id,
                                    directory,
                                    "该权限不在课程创建工作流的允许范围内。",
                                )
                            except Exception as exc:
                                reject_error = f"；自动拒绝失败：{exc}"
                        await fail_turn(
                            f"OpenCode 子任务请求了未授权权限 {permission}，"
                            f"本轮已终止，避免对话持续等待{reject_error}",
                            abort=True,
                        )
                        waiting_question_ids.clear()
                        terminal_wait_state_changed.set()
                        _clear_pending_questions_for_session(session_id)
                        return
                if not matches_session(properties, envelope):
                    continue
                if event_type == "question.asked":
                    request_id = str(properties.get("id") or "").strip()
                    questions = _normalize_opencode_questions(properties.get("questions"))
                    if not request_id or not questions:
                        continue
                    set_question_waiting(request_id, True)
                    await finish_text_segment(persist=True)
                    await asyncio.to_thread(
                        get_conversation_store().add_message,
                        conversation_id,
                        role="assistant",
                        content=_question_history_content(questions),
                        message_id=f"question-prompt:{request_id}",
                    )
                    _pending_questions[request_id] = {
                        "request_id": request_id,
                        "conversation_id": conversation_id,
                        "session_id": session_id,
                        "directory": directory,
                        "questions": questions,
                    }
                    await websocket.send_json({
                        "type": "agent_question",
                        "payload": {
                            "request_id": request_id,
                            "conversation_id": conversation_id,
                            "questions": questions,
                        },
                    })
                    await _send_status(websocket, conversation_id, "waiting", "等待你的确认")
                    continue
                if event_type in ("question.replied", "question.rejected"):
                    request_id = str(properties.get("requestID") or "").strip()
                    if request_id:
                        set_question_waiting(request_id, False)
                        _pending_questions.pop(request_id, None)
                        await websocket.send_json({
                            "type": "agent_question_resolved",
                            "payload": {
                                "request_id": request_id,
                                "conversation_id": conversation_id,
                                "rejected": event_type == "question.rejected",
                            },
                        })
                        await _send_status(websocket, conversation_id, "thinking", "已收到确认，继续处理")
                    continue
                if event_type == "message.part.delta":
                    field = properties.get("field")
                    delta = properties.get("delta")
                    if not delta:
                        continue
                    part = properties.get("part")
                    if isinstance(part, dict):
                        part_id = str(part.get("id") or "").strip()
                        part_type = str(part.get("type") or "").strip()
                        if part_id and part_type:
                            part_types[part_id] = part_type
                    part_id = str(
                        properties.get("partID")
                        or properties.get("partId")
                        or properties.get("part_id")
                        or ""
                    ).strip()
                    part_type = part_types.get(part_id)
                    if part_type == "reasoning" or (
                        not part_id and field == "reasoning"
                    ):
                        await websocket.send_json({
                            "type": "agent_thinking_delta",
                            "payload": {"text": delta, "conversation_id": conversation_id},
                        })
                    elif part_type == "text" or (
                        not part_id and field == "text"
                    ):
                        active_text["any"] = True
                        text_chunks.append(str(delta))
                        await websocket.send_json({
                            "type": "agent_text_delta",
                            "payload": {"text": delta, "conversation_id": conversation_id},
                        })
                    continue
                if event_type == "message.part.updated":
                    part = properties.get("part") or {}
                    if isinstance(part, dict):
                        part_id = str(part.get("id") or "").strip()
                        part_type = str(part.get("type") or "").strip()
                        if part_id and part_type:
                            part_types[part_id] = part_type
                    if isinstance(part, dict) and part.get("type") == "tool":
                        tool_error = await _handle_opencode_tool_part(
                            websocket, conversation_id, part, tool_started
                        )
                        critical_key = critical_tool_key(part)
                        state = part.get("state") or {}
                        tool_status = state.get("status") if isinstance(state, dict) else None
                        if critical_key and tool_error:
                            critical_tool_errors[critical_key] = tool_error
                        elif critical_key and tool_status == "completed":
                            critical_tool_errors.pop(critical_key, None)
                    continue
                if event_type == "session.error":
                    error = properties.get("error") or properties.get("message") or "OpenCode 会话出错"
                    await fail_turn(str(error))
                    waiting_question_ids.clear()
                    terminal_wait_state_changed.set()
                    _clear_pending_questions_for_session(session_id)
                    return
                if event_type == "session.idle":
                    if critical_tool_errors:
                        await fail_turn(next(iter(critical_tool_errors.values())))
                    waiting_question_ids.clear()
                    terminal_wait_state_changed.set()
                    _clear_pending_questions_for_session(session_id)
                    return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await fail_turn(f"OpenCode 事件流中断：{exc}", abort=True)
            waiting_question_ids.clear()
            terminal_wait_state_changed.set()
            _clear_pending_questions_for_session(session_id)
            return

        await fail_turn(
            "OpenCode 事件流已结束，但没有收到 session.idle 或 session.error 终态。",
            abort=True,
        )
        waiting_question_ids.clear()
        terminal_wait_state_changed.set()
        _clear_pending_questions_for_session(session_id)

    async def wait_for_terminal(consume_task: asyncio.Task[None], timeout: float) -> None:
        """Wait for a terminal event, pausing the budget for native questions."""

        remaining = timeout
        loop = asyncio.get_running_loop()
        while True:
            if consume_task.done():
                await consume_task
                return

            terminal_wait_state_changed.clear()
            state_change_task = asyncio.create_task(terminal_wait_state_changed.wait())
            started = loop.time()
            was_waiting_for_question = bool(waiting_question_ids)
            wait_timeout = None if was_waiting_for_question else remaining
            done, _ = await asyncio.wait(
                {consume_task, state_change_task},
                timeout=wait_timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not was_waiting_for_question:
                remaining -= loop.time() - started

            if consume_task in done:
                state_change_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await state_change_task
                await consume_task
                return
            if state_change_task in done:
                continue

            state_change_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await state_change_task
            raise TimeoutError

    heartbeat_task = asyncio.create_task(send_heartbeat())
    try:
        consume_task = asyncio.create_task(consume())
        # Let the SSE stream attach before prompting so no early tool events are
        # missed on a fast local model/server pair.
        await asyncio.sleep(0.3)
        try:
            parts = await _build_opencode_parts(text, images)
            await opencode_client.prompt(
                session_id,
                parts,
                directory,
                model_id=model,
                agent_name=agent_name,
            )
        except Exception as exc:
            consume_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consume_task
            _clear_pending_questions_for_session(session_id)
            with contextlib.suppress(Exception):
                await opencode_client.abort(session_id)
            await websocket.send_json({
                "type": "agent_error",
                "payload": {"message": f"发送 OpenCode prompt 失败：{exc}", "conversation_id": conversation_id},
            })
            return False, "".join(text_chunks).strip()
        configured_timeout = (
            settings.opencode_terminal_timeout_seconds
            if terminal_timeout_seconds is None
            else terminal_timeout_seconds
        )
        try:
            timeout = float(configured_timeout)
        except (TypeError, ValueError):
            timeout = 3600.0
        if timeout <= 0:
            timeout = 3600.0
        try:
            await wait_for_terminal(consume_task, timeout)
        except TimeoutError:
            consume_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consume_task
            await fail_turn(
                f"OpenCode 在 {timeout:g} 秒内未返回会话终态，已中止本轮操作；课程数据未提交。",
                abort=True,
            )
            waiting_question_ids.clear()
            terminal_wait_state_changed.set()
            _clear_pending_questions_for_session(session_id)
        if result["abort"]:
            with contextlib.suppress(Exception):
                await opencode_client.abort(session_id)
        response_text = await finish_text_segment(persist=False)
        return bool(result["ok"]), response_text
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
) -> str | None:
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
        return None
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
        if tool_status == "error":
            detail = str(output).strip()
            if len(detail) > 600:
                detail = f"{detail[:600]}…"
            return f"工具 {name} 执行失败{f'：{detail}' if detail else ''}"
    return None


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
    conversation_store = get_conversation_store()
    await asyncio.to_thread(
        conversation_store.ensure_conversation,
        conversation_id,
        mode="agent",
        workflow="default",
        model=model,
        title_hint=message,
    )
    await asyncio.to_thread(
        conversation_store.add_message,
        conversation_id,
        role="user",
        content=message,
        message_id=payload.get("request_id"),
    )
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
    if ok:
        for historical_message in reversed(history):
            if historical_message.get("role") != "assistant":
                continue
            content = historical_message.get("content")
            if not isinstance(content, list):
                continue
            response_text = "".join(
                str(block.get("text") or "")
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            ).strip()
            if response_text:
                await asyncio.to_thread(
                    conversation_store.add_message,
                    conversation_id,
                    role="assistant",
                    content=response_text,
                )
                break
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
