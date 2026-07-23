from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from src.api import agent


class _WebSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.messages.append(message)


def _review(
    kind: str = "knowledge-points",
    *,
    status: str = "pending",
) -> dict:
    graph = kind == "knowledge-graph"
    return {
        "id": "review-graph" if graph else "review-points",
        "kind": kind,
        "gate": "G6_GRAPH_REVIEW" if graph else "G2_IDENTITY_REVIEW",
        "status": status,
        "revision": 1,
        "artifact_hash": "a" * 64,
        "conversation_id": "conversation-review",
        "course_id": "compiler-principles",
        "course_title": "编译原理",
        "summary": {"total": 3},
        "review_url": (
            "#/reviews/review-graph/graph"
            if graph
            else "#/reviews/review-points/points"
        ),
    }


def _resume(kind: str) -> dict:
    review = {
        **_review(kind, status="resolved"),
        "resume_pending": True,
        "resume_message": f"resume {kind}",
        "display_content": f"已确认 {kind}",
    }
    return {
        "ok": True,
        "review": review,
        "resume_message": review["resume_message"],
        "display_content": review["display_content"],
    }


class AgentCourseReviewTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        agent._opencode_sessions.clear()

    async def test_pending_review_stops_before_runtime_or_history(self):
        websocket = _WebSocket()
        conversation_store = Mock()
        provision = Mock()
        stale_resume = AsyncMock(
            return_value={
                **_review("knowledge-points", status="resolved"),
                "resume_pending": True,
            }
        )

        with (
            patch.object(agent, "_pending_review_resume", new=stale_resume),
            patch.object(
                agent,
                "_pending_review",
                new=AsyncMock(return_value=_review("knowledge-graph")),
            ),
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
                    "message": "继续",
                    "conversation_id": "conversation-review",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                {"id": None},
            )

        self.assertEqual(
            [message["type"] for message in websocket.messages],
            ["agent_status", "agent_review_required", "agent_done"],
        )
        provision.assert_not_called()
        conversation_store.add_message.assert_not_called()
        stale_resume.assert_not_awaited()

    async def test_outline_turn_discovers_g2_and_never_commits(self):
        websocket = _WebSocket()
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-outline"
        review_store = Mock()
        review_store.resolved_knowledge_course_for_conversation.return_value = None
        workspace = SimpleNamespace(path=None)
        course_store = Mock()
        prompt = AsyncMock(return_value=(True, "已生成知识点清单"))

        with (
            patch.object(agent, "_pending_review_resume", new=AsyncMock(return_value=None)),
            patch.object(
                agent,
                "_pending_review",
                new=AsyncMock(side_effect=[None, _review()]),
            ),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model"),
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
            patch.object(agent, "_run_opencode_prompt", new=prompt),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "message": "创建编译原理课程",
                    "conversation_id": "conversation-review",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                {"id": None},
            )

        self.assertEqual(prompt.await_args.kwargs["agent_name"], "course-outline-creator")
        self.assertTrue(
            any(message["type"] == "agent_review_required" for message in websocket.messages)
        )
        course_store.commit_workspace.assert_not_called()

    async def test_g2_resume_completes_only_after_g6_marker_exists(self):
        websocket = _WebSocket()
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-creator"
        review_store = Mock()
        canonical = _resume("knowledge-points")
        review_store.get_resume.return_value = canonical
        review_store.claim_resume.return_value = canonical
        review_store.has_resolved_knowledge_review.return_value = True
        completed = deepcopy(canonical)
        completed["review"]["resume_pending"] = False
        review_store.complete_resume.return_value = completed
        review_store.pointer.side_effect = lambda resource: resource
        workspace = SimpleNamespace(path=None)
        course_store = Mock()
        prompt = AsyncMock(return_value=(True, "图谱已生成"))

        with (
            patch.object(
                agent,
                "_pending_review",
                new=AsyncMock(side_effect=[None, _review("knowledge-graph")]),
            ),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model"),
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
            patch.object(agent, "_run_opencode_prompt", new=prompt),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "review_resume_id": "review-points",
                    "conversation_id": "conversation-review",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                {"id": None},
            )

        self.assertEqual(prompt.await_args.kwargs["agent_name"], "course-creator")
        review_store.complete_resume.assert_called_once()
        course_store.commit_workspace.assert_not_called()
        terminal_types = [message["type"] for message in websocket.messages[-4:]]
        self.assertEqual(
            terminal_types,
            [
                "agent_review_resolved",
                "agent_status",
                "agent_review_required",
                "agent_done",
            ],
        )

    async def test_g6_resume_commits_before_consuming_resume_outbox(self):
        timeline: list[str] = []
        websocket = _WebSocket()
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-release"
        review_store = Mock()
        canonical = _resume("knowledge-graph")
        review_store.get_resume.return_value = canonical
        review_store.claim_resume.return_value = canonical
        review_store.has_resolved_knowledge_review.return_value = True
        review_store.pointer.side_effect = lambda resource: resource
        completed = deepcopy(canonical)
        completed["review"]["resume_pending"] = False

        def complete_resume(*args, **kwargs):
            timeline.append("complete")
            return completed

        review_store.complete_resume.side_effect = complete_resume
        workspace = SimpleNamespace(path=None)
        course_store = Mock()

        def commit_workspace(*args, **kwargs):
            timeline.append("commit")
            return {"changed_paths": [], "course_ids": [], "warnings": []}

        course_store.commit_workspace.side_effect = commit_workspace

        with (
            patch.object(
                agent,
                "_pending_review",
                new=AsyncMock(side_effect=[None, None]),
            ),
            patch.object(agent, "get_course_review_store", return_value=review_store),
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model"),
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
                new=AsyncMock(return_value=(True, "发布完成")),
            ),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "review_resume_id": "review-graph",
                    "conversation_id": "conversation-review",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                {"id": None},
            )

        self.assertEqual(timeline, ["commit", "complete"])
        self.assertTrue(
            any(message["type"] == "agent_review_resolved" for message in websocket.messages)
        )
        self.assertEqual(websocket.messages[-1]["type"], "agent_done")


if __name__ == "__main__":
    unittest.main()
