from __future__ import annotations

import asyncio
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import WebSocketDisconnect

from src.api import agent
from src.services.courses import CourseDataError
from src.services.conversations.store import ConversationStore
from src.services.reviews import CourseReviewConflictError, CourseReviewError


class _WebSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.messages.append(message)


def _review_pointer() -> dict:
    return {
        "id": "review-1",
        "kind": "knowledge-points",
        "gate": "G2_IDENTITY_REVIEW",
        "status": "pending",
        "revision": 1,
        "artifact_hash": "a" * 64,
        "conversation_id": "conversation-1",
        "course_id": "demo-course",
        "course_title": "Demo Course",
        "summary": {"total": 3},
        "review_url": "#/reviews/review-1/points",
    }


def _resume_response() -> dict:
    review = {
        **_review_pointer(),
        "status": "resolved",
        "course_id": "demo-course",
        "resume_pending": True,
        "resume_message": "canonical internal resume instruction",
        "display_content": "已确认 Demo Course 的知识点清单",
    }
    return {
        "ok": True,
        "review": review,
        "resume_message": review["resume_message"],
        "display_content": review["display_content"],
    }


def _prerequisite_review_pointer(
    *,
    course_id: str = "demo-course",
    status: str = "pending",
) -> dict:
    return {
        **_review_pointer(),
        "id": "review-2",
        "kind": "prerequisites",
        "gate": "G6_PREREQUISITE_REVIEW",
        "status": status,
        "course_id": course_id,
        "review_url": "#/reviews/review-2/prerequisites",
    }


def _prerequisite_resume_response() -> dict:
    review = {
        **_prerequisite_review_pointer(status="resolved"),
        "resume_pending": True,
        "resume_message": "canonical prerequisite resume instruction",
        "display_content": "已确认 Demo Course 的 prerequisites",
    }
    return {
        "ok": True,
        "review": review,
        "resume_message": review["resume_message"],
        "display_content": review["display_content"],
    }


class AgentCourseReviewTest(unittest.IsolatedAsyncioTestCase):
    async def test_resume_pending_blocks_plain_course_turn_before_any_runtime_work(self):
        websocket = _WebSocket()
        active_session = {"id": "stale-session"}
        review_store = Mock()
        resume = _resume_response()["review"]
        review_store.resume_pending_for_conversation.return_value = resume
        review_store.pointer.side_effect = lambda resource: resource
        pending_review = AsyncMock()
        provision = Mock()
        health = AsyncMock()
        prompt = AsyncMock()

        with (
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "_pending_review", new=pending_review),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                new=provision,
            ),
            patch.object(agent.opencode_client, "health", new=health),
            patch.object(agent, "_run_opencode_prompt", new=prompt),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "message": "continue without explicit resume",
                    "conversation_id": "conversation-1",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        self.assertEqual(websocket.messages[1]["payload"]["id"], "review-1")
        self.assertTrue(websocket.messages[1]["payload"]["resume_pending"])
        review_store.claim_resume.assert_not_called()
        pending_review.assert_not_awaited()
        provision.assert_not_called()
        health.assert_not_awaited()
        prompt.assert_not_awaited()
        self.assertIsNone(active_session["id"])

    async def test_existing_review_blocks_new_course_turn_and_emits_terminal_events(self):
        websocket = _WebSocket()
        active_session = {"id": "stale-session"}
        provision = Mock()
        conversation_store = Mock()

        with (
            patch.object(agent, "_pending_review_resume", new=AsyncMock(return_value=None)),
            patch.object(agent, "_pending_review", new=AsyncMock(return_value=_review_pointer())),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                new=provision,
            ),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "message": "try to continue",
                    "conversation_id": "conversation-1",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        self.assertEqual(
            [message["type"] for message in websocket.messages],
            ["agent_status", "agent_review_required", "agent_done"],
        )
        self.assertEqual(websocket.messages[1]["payload"]["id"], "review-1")
        self.assertTrue(websocket.messages[2]["payload"]["awaiting_review"])
        self.assertEqual(websocket.messages[2]["payload"]["return_code"], 0)
        self.assertIsNone(active_session["id"])
        provision.assert_not_called()
        conversation_store.add_message.assert_not_called()

    async def test_resume_health_failure_does_not_claim_or_persist_history(self):
        websocket = _WebSocket()
        active_session = {"id": None}
        conversation_store = Mock()
        review_store = Mock()
        review_store.get_resume.return_value = _resume_response()
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))

        with (
            patch.object(agent, "_pending_review", new=AsyncMock(return_value=None)),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                return_value=workspace,
            ),
            patch.object(
                agent.opencode_provision,
                "host_course_creation_workspace_dir",
                return_value="workspace",
            ),
            patch.object(
                agent.opencode_client,
                "health",
                new=AsyncMock(side_effect=RuntimeError("offline")),
            ),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "message": "forged message",
                    "display_content": "forged display",
                    "review_resume_id": "review-1",
                    "conversation_id": "conversation-1",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        review_store.get_resume.assert_called_once()
        review_store.claim_resume.assert_not_called()
        review_store.complete_resume.assert_not_called()
        conversation_store.add_message.assert_not_called()
        self.assertFalse(
            any(message["type"] == "agent_review_resolved" for message in websocket.messages)
        )

    async def test_g2_crash_recovery_completes_only_for_same_course_g6_marker(self):
        timeline: list[str] = []

        class _TrackingWebSocket(_WebSocket):
            async def send_json(self, message: dict) -> None:
                if message["type"] == "agent_review_resolved":
                    timeline.append("resolved-send")
                await super().send_json(message)

        websocket = _TrackingWebSocket()
        active_session = {"id": None}
        review_store = Mock()
        canonical = _resume_response()
        review_store.get_resume.return_value = canonical
        review_store.claim_resume.return_value = canonical
        review_store.pointer.side_effect = lambda resource: resource

        def complete_resume(*args, **kwargs):
            timeline.append("complete")
            response = deepcopy(canonical)
            response["review"]["resume_pending"] = False
            return response

        review_store.complete_resume.side_effect = complete_resume
        successor = _prerequisite_review_pointer()
        provision = Mock()
        health = AsyncMock()
        prompt = AsyncMock()

        with (
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "_pending_review", new=AsyncMock(return_value=successor)),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                new=provision,
            ),
            patch.object(agent.opencode_client, "health", new=health),
            patch.object(agent, "_run_opencode_prompt", new=prompt),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "review_resume_id": "review-1",
                    "conversation_id": "conversation-1",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        self.assertEqual(timeline, ["complete", "resolved-send"])
        review_store.claim_resume.assert_called_once()
        review_store.complete_resume.assert_called_once()
        review_store.release_resume.assert_not_called()
        provision.assert_not_called()
        health.assert_not_awaited()
        prompt.assert_not_awaited()
        self.assertTrue(
            any(message["type"] == "agent_review_required" for message in websocket.messages)
        )

    async def test_g2_resume_without_valid_g6_marker_releases_without_completing(self):
        websocket = _WebSocket()
        active_session = {"id": None}
        review_store = Mock()
        canonical = _resume_response()
        review_store.get_resume.return_value = canonical
        review_store.claim_resume.return_value = canonical
        review_store.release_resume.return_value = canonical
        review_store.has_resolved_knowledge_review.return_value = True
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-1"
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))
        pending = AsyncMock(side_effect=[None, None])
        course_store = Mock()

        with (
            patch.object(agent, "_pending_review", new=pending),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                return_value=workspace,
            ),
            patch.object(
                agent.opencode_provision,
                "host_course_creation_workspace_dir",
                return_value="workspace",
            ),
            patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
            patch.object(
                agent,
                "_run_opencode_prompt",
                new=AsyncMock(return_value=(True, "")),
            ),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "review_resume_id": "review-1",
                    "conversation_id": "conversation-1",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        review_store.release_resume.assert_called_once()
        review_store.complete_resume.assert_not_called()
        course_store.commit_workspace.assert_not_called()
        self.assertFalse(
            any(message["type"] == "agent_review_resolved" for message in websocket.messages)
        )

    async def test_g6_commit_failure_releases_without_resolved_event(self):
        websocket = _WebSocket()
        active_session = {"id": None}
        review_store = Mock()
        canonical = _prerequisite_resume_response()
        review_store.get_resume.return_value = canonical
        review_store.claim_resume.return_value = canonical
        review_store.release_resume.return_value = canonical
        review_store.has_resolved_knowledge_review.return_value = True
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-1"
        course_store = Mock()
        course_store.review_commit_receipt.return_value = None
        course_store.commit_workspace.side_effect = CourseDataError("commit failed")
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))

        with (
            patch.object(
                agent,
                "_pending_review",
                new=AsyncMock(side_effect=[None, None]),
            ),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                return_value=workspace,
            ),
            patch.object(
                agent.opencode_provision,
                "host_course_creation_workspace_dir",
                return_value="workspace",
            ),
            patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
            patch.object(
                agent,
                "_run_opencode_prompt",
                new=AsyncMock(return_value=(True, "")),
            ),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "review_resume_id": "review-2",
                    "conversation_id": "conversation-1",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        review_store.release_resume.assert_called_once()
        review_store.complete_resume.assert_not_called()
        self.assertFalse(
            any(message["type"] == "agent_review_resolved" for message in websocket.messages)
        )

    async def test_g6_resolved_send_disconnect_happens_after_commit_and_complete(self):
        timeline: list[str] = []

        class _DisconnectingWebSocket(_WebSocket):
            async def send_json(self, message: dict) -> None:
                if message["type"] == "agent_review_resolved":
                    timeline.append("resolved-send")
                    raise WebSocketDisconnect()
                await super().send_json(message)

        websocket = _DisconnectingWebSocket()
        active_session = {"id": None}
        review_store = Mock()
        canonical = _prerequisite_resume_response()
        review_store.get_resume.return_value = canonical
        review_store.claim_resume.return_value = canonical
        review_store.has_resolved_knowledge_review.return_value = True
        review_store.pointer.side_effect = lambda resource: resource

        def complete_resume(*args, **kwargs):
            timeline.append("complete")
            response = deepcopy(canonical)
            response["review"]["resume_pending"] = False
            return response

        review_store.complete_resume.side_effect = complete_resume
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-1"
        course_store = Mock()
        course_store.review_commit_receipt.return_value = None

        def commit_workspace(*args, **kwargs):
            timeline.append("commit")
            return {"changed_paths": [], "course_ids": [], "warnings": []}

        course_store.commit_workspace.side_effect = commit_workspace
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))

        with (
            patch.object(
                agent,
                "_pending_review",
                new=AsyncMock(side_effect=[None, None]),
            ),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                return_value=workspace,
            ),
            patch.object(
                agent.opencode_provision,
                "host_course_creation_workspace_dir",
                return_value="workspace",
            ),
            patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
            patch.object(
                agent,
                "_run_opencode_prompt",
                new=AsyncMock(return_value=(True, "")),
            ),
        ):
            with self.assertRaises(WebSocketDisconnect):
                await agent._run_agent_turn_opencode(
                    websocket,
                    {
                        "review_resume_id": "review-2",
                        "conversation_id": "conversation-1",
                        "mode": "agent",
                        "workflow": "course-create",
                    },
                    active_session,
                )

        self.assertEqual(timeline, ["commit", "complete", "resolved-send"])
        review_store.release_resume.assert_not_called()

    async def test_resume_claim_renews_during_commit_until_complete(self):
        websocket = _WebSocket()
        active_session = {"id": None}
        review_store = Mock()
        canonical = _prerequisite_resume_response()
        completed = deepcopy(canonical)
        completed["review"]["resume_pending"] = False
        review_store.get_resume.return_value = canonical
        review_store.claim_resume.return_value = canonical
        review_store.complete_resume.return_value = completed
        review_store.has_resolved_knowledge_review.return_value = True
        review_store.pointer.side_effect = lambda resource: resource
        commit_started = threading.Event()
        renewed_during_commit = threading.Event()

        def renew_resume_claim(*args, **kwargs):
            if commit_started.is_set():
                renewed_during_commit.set()

        review_store.renew_resume_claim.side_effect = renew_resume_claim
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-1"
        course_store = Mock()
        course_store.review_commit_receipt.return_value = None

        def commit_workspace(*args, **kwargs):
            commit_started.set()
            if not renewed_during_commit.wait(1):
                raise AssertionError("resume claim was not renewed during commit")
            return {"changed_paths": [], "course_ids": [], "warnings": []}

        course_store.commit_workspace.side_effect = commit_workspace
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))

        with (
            patch.object(
                agent,
                "_pending_review",
                new=AsyncMock(side_effect=[None, None]),
            ),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                return_value=workspace,
            ),
            patch.object(
                agent.opencode_provision,
                "host_course_creation_workspace_dir",
                return_value="workspace",
            ),
            patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
            patch.object(
                agent,
                "_run_opencode_prompt",
                new=AsyncMock(return_value=(True, "")),
            ),
            patch.object(agent, "_resume_claim_heartbeat_interval", return_value=0.001),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "review_resume_id": "review-2",
                    "conversation_id": "conversation-1",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        self.assertTrue(renewed_during_commit.is_set())
        review_store.complete_resume.assert_called_once()
        review_store.release_resume.assert_not_called()

    async def test_post_prompt_heartbeat_failure_prevents_commit(self):
        websocket = _WebSocket()
        active_session = {"id": None}
        review_store = Mock()
        canonical = _prerequisite_resume_response()
        review_store.get_resume.return_value = canonical
        review_store.claim_resume.return_value = canonical
        review_store.has_resolved_knowledge_review.return_value = True
        post_prompt = threading.Event()
        renewal_failed = threading.Event()

        def renew_resume_claim(*args, **kwargs):
            if post_prompt.is_set():
                renewal_failed.set()
                raise CourseReviewError("claim renewal failed")

        review_store.renew_resume_claim.side_effect = renew_resume_claim
        pending_calls = 0

        async def pending_review(_conversation_id: str):
            nonlocal pending_calls
            pending_calls += 1
            if pending_calls == 1:
                return None
            post_prompt.set()
            for _ in range(1000):
                if renewal_failed.is_set():
                    return None
                await asyncio.sleep(0.001)
            raise AssertionError("resume heartbeat did not run after the prompt")

        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-1"
        course_store = Mock()
        course_store.review_commit_receipt.return_value = None
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))

        with (
            patch.object(agent, "_pending_review", new=pending_review),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                return_value=workspace,
            ),
            patch.object(
                agent.opencode_provision,
                "host_course_creation_workspace_dir",
                return_value="workspace",
            ),
            patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
            patch.object(
                agent,
                "_run_opencode_prompt",
                new=AsyncMock(return_value=(True, "")),
            ),
            patch.object(agent, "_resume_claim_heartbeat_interval", return_value=0.001),
        ):
            with self.assertRaisesRegex(CourseReviewError, "claim renewal failed"):
                await agent._run_agent_turn_opencode(
                    websocket,
                    {
                        "review_resume_id": "review-2",
                        "conversation_id": "conversation-1",
                        "mode": "agent",
                        "workflow": "course-create",
                    },
                    active_session,
                )

        course_store.commit_workspace.assert_not_called()
        review_store.release_resume.assert_called_once()
        self.assertIsNone(active_session["id"])

    async def test_g6_commit_receipt_recovers_without_replaying_prompt(self):
        websocket = _WebSocket()
        active_session = {"id": None}
        review_store = Mock()
        canonical = _prerequisite_resume_response()
        review_store.get_resume.return_value = canonical
        review_store.claim_resume.return_value = canonical
        completed = deepcopy(canonical)
        completed["review"]["resume_pending"] = False
        review_store.complete_resume.return_value = completed
        review_store.pointer.side_effect = lambda resource: resource
        course_store = Mock()
        course_store.review_commit_receipt.return_value = {
            "changed_paths": [],
            "changed_course_ids": ["demo-course"],
            "canonical_fingerprint": "b" * 64,
            "warnings": [],
        }
        provision = Mock()
        health = AsyncMock()
        prompt = AsyncMock()

        with (
            patch.object(agent, "_pending_review", new=AsyncMock(return_value=None)),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                new=provision,
            ),
            patch.object(agent.opencode_client, "health", new=health),
            patch.object(agent, "_run_opencode_prompt", new=prompt),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "review_resume_id": "review-2",
                    "conversation_id": "conversation-1",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        review_store.claim_resume.assert_called_once()
        review_store.complete_resume.assert_called_once()
        review_store.release_resume.assert_not_called()
        provision.assert_not_called()
        health.assert_not_awaited()
        prompt.assert_not_awaited()
        self.assertTrue(
            any(message["type"] == "agent_review_resolved" for message in websocket.messages)
        )

    async def test_question_disconnect_releases_resume_for_immediate_takeover(self):
        class _DisconnectingWebSocket(_WebSocket):
            def __init__(self) -> None:
                super().__init__()
                self.question_seen = False

            async def send_json(self, message: dict) -> None:
                if message["type"] == "agent_question":
                    self.question_seen = True
                elif message["type"] == "agent_heartbeat" and self.question_seen:
                    raise WebSocketDisconnect()
                await super().send_json(message)

        websocket = _DisconnectingWebSocket()
        active_session = {"id": None}
        review_store = Mock()
        canonical = _resume_response()
        review_store.get_resume.return_value = canonical
        review_store.has_resolved_knowledge_review.return_value = True
        active_claim: dict[str, str | None] = {"id": None}

        def claim_resume(*args, **kwargs):
            if active_claim["id"] is not None:
                raise CourseReviewConflictError("claim already active")
            active_claim["id"] = kwargs["claim_id"]
            response = deepcopy(canonical)
            response["review"]["resume_claim_id"] = kwargs["claim_id"]
            return response

        def release_resume(*args, **kwargs):
            self.assertEqual(active_claim["id"], kwargs["claim_id"])
            active_claim["id"] = None
            return deepcopy(canonical)

        review_store.claim_resume.side_effect = claim_resume
        review_store.release_resume.side_effect = release_resume
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-1"
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))
        prompted = asyncio.Event()

        async def send_prompt(*args, **kwargs) -> None:
            prompted.set()

        async def event_stream():
            await prompted.wait()
            yield {
                "directory": "workspace",
                "payload": {
                    "type": "question.asked",
                    "properties": {
                        "sessionID": "session-1",
                        "id": "question-resume-disconnect",
                        "questions": [
                            {
                                "header": "继续",
                                "question": "是否继续？",
                                "options": [
                                    {"label": "继续", "description": "继续生成"}
                                ],
                            }
                        ],
                    },
                },
            }
            await asyncio.Event().wait()

        abort = AsyncMock()
        with (
            patch.object(agent, "_pending_review", new=AsyncMock(return_value=None)),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                return_value=workspace,
            ),
            patch.object(
                agent.opencode_provision,
                "host_course_creation_workspace_dir",
                return_value="workspace",
            ),
            patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
            patch.object(agent.opencode_client, "prompt", new=send_prompt),
            patch.object(agent.opencode_client, "events", new=event_stream),
            patch.object(agent.opencode_client, "abort", new=abort),
            patch.object(agent, "_websocket_heartbeat_interval", return_value=0.001),
        ):
            with self.assertRaises(WebSocketDisconnect):
                await agent._run_agent_turn_opencode(
                    websocket,
                    {
                        "review_resume_id": "review-1",
                        "conversation_id": "conversation-1",
                        "mode": "agent",
                        "workflow": "course-create",
                    },
                    active_session,
                )

        abort.assert_awaited_once_with("session-1")
        review_store.release_resume.assert_called_once()
        self.assertIsNone(active_claim["id"])
        review_store.claim_resume(
            "review-1",
            conversation_id="conversation-1",
            claim_id="second-claim",
        )
        self.assertEqual(active_claim["id"], "second-claim")


    async def test_successful_turn_discovers_review_and_skips_canonical_commit(self):
        websocket = _WebSocket()
        active_session = {"id": None}
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-1"
        review_store = Mock()
        review_store.resolved_knowledge_course_for_conversation.return_value = "demo-course"
        course_store = Mock()
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))
        pending = AsyncMock(side_effect=[None, _review_pointer()])
        run_prompt = AsyncMock(return_value=(True, ""))
        agent._opencode_sessions.pop("agent:course-create:conversation-1", None)

        with (
            patch.object(agent, "_pending_review_resume", new=AsyncMock(return_value=None)),
            patch.object(agent, "_pending_review", new=pending),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                return_value=workspace,
            ),
            patch.object(
                agent.opencode_provision,
                "host_course_creation_workspace_dir",
                return_value="workspace",
            ),
            patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
            patch.object(agent, "_run_opencode_prompt", new=run_prompt),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "message": "internal structured-review resume instruction",
                    "display_content": "已确认 Demo Course 的知识点清单",
                    "conversation_id": "conversation-1",
                    "request_id": "request-1",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        self.assertEqual(pending.await_count, 2)
        self.assertTrue(any(message["type"] == "agent_review_required" for message in websocket.messages))
        done = next(message for message in websocket.messages if message["type"] == "agent_done")
        self.assertTrue(done["payload"]["awaiting_review"])
        course_store.commit_workspace.assert_not_called()
        user_call = next(
            call
            for call in conversation_store.add_message.call_args_list
            if call.kwargs.get("role") == "user"
        )
        self.assertEqual(user_call.kwargs["content"], "已确认 Demo Course 的知识点清单")
        prompt_text = run_prompt.await_args.kwargs["text"]
        self.assertEqual(
            run_prompt.await_args.kwargs["agent_name"],
            "course-creator",
        )
        self.assertIn("internal structured-review resume instruction", prompt_text)
        self.assertNotIn("已确认 Demo Course 的知识点清单", prompt_text)
        self.assertIsNone(active_session["id"])

    async def test_unapproved_or_ambiguous_course_turn_uses_outline_creator(self):
        websocket = _WebSocket()
        active_session = {"id": None}
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-outline"
        review_store = Mock()
        review_store.resolved_knowledge_course_for_conversation.return_value = None
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))
        run_prompt = AsyncMock(return_value=(True, ""))
        pending = AsyncMock(side_effect=[None, _review_pointer()])
        session_key = "agent:course-create:conversation-outline"
        agent._opencode_sessions.pop(session_key, None)
        self.addCleanup(agent._opencode_sessions.pop, session_key, None)

        with (
            patch.object(agent, "_pending_review_resume", new=AsyncMock(return_value=None)),
            patch.object(agent, "_pending_review", new=pending),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(
                agent.opencode_provision,
                "ensure_course_creation_session_assets",
                return_value=workspace,
            ),
            patch.object(
                agent.opencode_provision,
                "host_course_creation_workspace_dir",
                return_value="workspace",
            ),
            patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
            patch.object(agent, "_run_opencode_prompt", new=run_prompt),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "message": "create another course",
                    "conversation_id": "conversation-outline",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        self.assertEqual(
            run_prompt.await_args.kwargs["agent_name"],
            "course-outline-creator",
        )

    async def test_failed_resume_releases_and_retry_completes_without_duplicate_history(self):
        timeline: list[str] = []

        class _TrackingWebSocket(_WebSocket):
            async def send_json(self, message: dict) -> None:
                if message["type"] == "agent_review_resolved":
                    timeline.append("resolved-event")
                await super().send_json(message)

        first_socket = _TrackingWebSocket()
        second_socket = _TrackingWebSocket()
        active_session = {"id": None}
        review_store = Mock()
        canonical = _resume_response()
        review_store.get_resume.return_value = canonical
        review_store.has_resolved_knowledge_review.return_value = True
        review_store.pointer.side_effect = lambda resource: resource

        def claim_resume(*args, **kwargs):
            response = deepcopy(canonical)
            response["review"]["resume_claim_id"] = kwargs["claim_id"]
            return response

        def release_resume(*args, **kwargs):
            return deepcopy(canonical)

        def complete_resume(*args, **kwargs):
            timeline.append("complete")
            response = deepcopy(canonical)
            response["review"]["resume_pending"] = False
            return response

        review_store.claim_resume.side_effect = claim_resume
        review_store.release_resume.side_effect = release_resume
        review_store.complete_resume.side_effect = complete_resume
        workspace = SimpleNamespace(path=SimpleNamespace(parent="session-root"))
        pending = AsyncMock(
            side_effect=[None, None, _prerequisite_review_pointer()]
        )
        run_prompt = AsyncMock(
            side_effect=[
                (False, ""),
                (True, ""),
            ]
        )
        session_key = "agent:course-create:conversation-1"
        agent._opencode_sessions.pop(session_key, None)
        self.addCleanup(agent._opencode_sessions.pop, session_key, None)

        with tempfile.TemporaryDirectory() as directory:
            conversation_store = ConversationStore(Path(directory) / "conversations.sqlite3")
            with (
                patch.object(agent, "_pending_review", new=pending),
                patch.object(agent, "get_course_review_store", return_value=review_store),
                patch.object(agent, "get_conversation_store", return_value=conversation_store),
                patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
                patch.object(
                    agent.model_config,
                    "get_model",
                    return_value=SimpleNamespace(base_url="http://model", api_key="key"),
                ),
                patch.object(
                    agent.opencode_provision,
                    "ensure_course_creation_session_assets",
                    return_value=workspace,
                ),
                patch.object(
                    agent.opencode_provision,
                    "host_course_creation_workspace_dir",
                    return_value="workspace",
                ),
                patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
                patch.object(
                    agent.opencode_client,
                    "create_session",
                    new=AsyncMock(return_value="session-1"),
                ),
                patch.object(agent, "_run_opencode_prompt", new=run_prompt),
            ):
                payload = {
                    "message": "forged internal message",
                    "display_content": "forged display content",
                    "review_resume_id": "review-1",
                    "conversation_id": "conversation-1",
                    "request_id": "untrusted-request-id",
                    "mode": "agent",
                    "workflow": "course-create",
                }
                await agent._run_agent_turn_opencode(
                    first_socket,
                    payload,
                    active_session,
                )
                await agent._run_agent_turn_opencode(
                    second_socket,
                    payload,
                    active_session,
                )

            conversation = conversation_store.get_conversation("conversation-1")

        self.assertEqual(review_store.claim_resume.call_count, 2)
        review_store.release_resume.assert_called_once()
        review_store.complete_resume.assert_called_once()
        self.assertFalse(
            any(
                message["type"] == "agent_review_resolved"
                for message in first_socket.messages
            )
        )
        self.assertTrue(
            any(
                message["type"] == "agent_review_resolved"
                for message in second_socket.messages
            )
        )
        self.assertLess(timeline.index("complete"), timeline.index("resolved-event"))
        user_messages = [
            message
            for message in conversation["messages"]
            if message["role"] == "user"
        ]
        self.assertEqual(len(user_messages), 1)
        self.assertEqual(user_messages[0]["id"], "review-resume:review-1")
        self.assertEqual(
            user_messages[0]["content"],
            "已确认 Demo Course 的知识点清单",
        )
        for call in run_prompt.await_args_list:
            self.assertIn("canonical internal resume instruction", call.kwargs["text"])
            self.assertNotIn("forged internal message", call.kwargs["text"])

    def test_display_content_is_bounded_and_does_not_change_normal_requests(self):
        self.assertEqual(
            agent._request_history_content({}, "normal message", []),
            "normal message",
        )
        bounded = agent._request_history_content(
            {"display_content": "x" * (agent.MAX_DISPLAY_CONTENT_CHARS + 20)},
            "internal",
            [],
        )
        self.assertEqual(len(bounded), agent.MAX_DISPLAY_CONTENT_CHARS)
        self.assertNotIn("internal", bounded)

    async def test_long_running_resume_prompt_renews_claim(self):
        renewed = threading.Event()
        review_store = Mock()
        review_store.renew_resume_claim.side_effect = lambda *args, **kwargs: renewed.set()

        async def waiting_prompt():
            while not renewed.is_set():
                await asyncio.sleep(0.001)
            return True, "done"

        with (
            patch.object(agent, "_resume_claim_heartbeat_interval", return_value=0.001),
            patch.object(agent.opencode_client, "abort", new=AsyncMock()),
        ):
            result = await agent._await_prompt_with_resume_heartbeat(
                waiting_prompt(),
                review_store=review_store,
                review_id="review-1",
                conversation_id="conversation-1",
                claim_id="claim-1",
                session_id="session-1",
            )

        self.assertEqual(result, (True, "done"))
        review_store.renew_resume_claim.assert_called()

    async def test_cancelled_resume_prompt_cancels_prompt_and_aborts(self):
        prompt_started = asyncio.Event()
        prompt_cancelled = asyncio.Event()
        review_store = Mock()
        abort = AsyncMock()

        async def waiting_prompt():
            prompt_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                prompt_cancelled.set()

        with (
            patch.object(agent, "_resume_claim_heartbeat_interval", return_value=60),
            patch.object(agent.opencode_client, "abort", new=abort),
        ):
            wait_task = asyncio.create_task(
                agent._await_prompt_with_resume_heartbeat(
                    waiting_prompt(),
                    review_store=review_store,
                    review_id="review-1",
                    conversation_id="conversation-1",
                    claim_id="claim-1",
                    session_id="session-1",
                )
            )
            await prompt_started.wait()
            wait_task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await wait_task

        self.assertTrue(prompt_cancelled.is_set())
        abort.assert_awaited_once_with("session-1")


if __name__ == "__main__":
    unittest.main()
