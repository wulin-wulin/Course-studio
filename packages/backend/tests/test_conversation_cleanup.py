from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

from src.api import agent, conversations
from src.services.courses.store import CourseStore
from src.services.reviews.activity import CourseActivityCoordinator


class ConversationWorkspaceCleanupTest(unittest.TestCase):
    def test_discards_agent_and_chat_workspaces_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "courses"
            workspaces = root / "sessions"
            canonical.mkdir()
            store = CourseStore(canonical, workspaces)

            agent_workspace = store.prepare_workspace("conversation-1")
            chat_workspace = store.prepare_readonly_workspace("conversation-1")
            (agent_workspace.path.parent / "pipeline").mkdir()
            (agent_workspace.path.parent / "pipeline" / "draft.json").write_text(
                "{}",
                encoding="utf-8",
            )

            removed = store.discard_conversation_workspaces("conversation-1")

            self.assertEqual(
                removed,
                ["chat-conversation-1", "conversation-1"],
            )
            self.assertFalse(agent_workspace.path.parent.exists())
            self.assertFalse(chat_workspace.path.parent.exists())
            self.assertTrue(canonical.is_dir())
            self.assertEqual(list(canonical.iterdir()), [])


class ConversationCleanupApiTest(unittest.IsolatedAsyncioTestCase):
    def tearDown(self) -> None:
        agent._opencode_sessions.clear()
        agent._pending_questions.clear()

    async def test_forget_removes_cached_session_and_pending_questions(self):
        agent._opencode_sessions[
            "agent:course-create:conversation-1"
        ] = "session-1"
        agent._pending_questions["question-1"] = {
            "session_id": "session-1",
        }

        agent.forget_opencode_conversation("conversation-1", "session-1")

        self.assertEqual(agent._opencode_sessions, {})
        self.assertEqual(agent._pending_questions, {})

    async def test_delete_cleans_workspace_session_cache_and_history(self):
        conversation_store = Mock()
        conversation_store.get_conversation.return_value = {
            "id": "conversation-1",
            "opencode_session_id": "session-1",
        }
        conversation_store.delete_conversation.return_value = True
        course_store = Mock()
        course_store.discard_conversation_workspaces.return_value = [
            "conversation-1"
        ]
        coordinator = Mock()
        coordinator.active_for.return_value = None

        with (
            patch.object(
                conversations,
                "get_conversation_store",
                return_value=conversation_store,
            ),
            patch.object(
                conversations,
                "get_course_store",
                return_value=course_store,
            ),
            patch.object(
                conversations,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                conversations.opencode_client,
                "delete_session",
                new=AsyncMock(return_value=True),
            ) as delete_session,
            patch.object(agent, "forget_opencode_conversation") as forget,
        ):
            response = await conversations.delete_conversation("conversation-1")

        self.assertEqual(response.status_code, 204)
        coordinator.active_for.assert_called_once_with("conversation-1")
        course_store.discard_conversation_workspaces.assert_called_once_with(
            "conversation-1"
        )
        delete_session.assert_awaited_once_with("session-1")
        forget.assert_called_once_with("conversation-1", "session-1")
        conversation_store.delete_conversation.assert_called_once_with(
            "conversation-1"
        )

    async def test_delete_refuses_an_active_course_creation_turn(self):
        conversation_store = Mock()
        conversation_store.get_conversation.return_value = {
            "id": "conversation-1",
            "opencode_session_id": "session-1",
        }
        coordinator = CourseActivityCoordinator()
        coordinator.claim("conversation-1", "agent-turn")

        with (
            patch.object(
                conversations,
                "get_conversation_store",
                return_value=conversation_store,
            ),
            patch.object(
                conversations,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                await conversations.delete_conversation("conversation-1")

        self.assertEqual(raised.exception.status_code, 409)
        conversation_store.delete_conversation.assert_not_called()


if __name__ == "__main__":
    unittest.main()
