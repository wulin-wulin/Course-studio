import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from src.api import agent


class _WebSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.messages.append(message)


def _event(event_type: str, properties: dict | None = None) -> dict:
    return {
        "directory": "workspace",
        "payload": {
            "type": event_type,
            "properties": {"sessionID": "session-1", **(properties or {})},
        },
    }


class AgentOpenCodeTerminalTest(unittest.IsolatedAsyncioTestCase):
    async def _run_prompt(self, events, *, timeout: float = 1.0):
        websocket = _WebSocket()
        prompted = asyncio.Event()

        async def send_prompt(*args, **kwargs) -> None:
            prompted.set()

        async def event_stream():
            await prompted.wait()
            async for item in events():
                yield item

        abort = AsyncMock()
        reject_permission = AsyncMock()
        self.reject_permission = reject_permission
        with (
            patch.object(agent.opencode_client, "prompt", new=send_prompt),
            patch.object(agent.opencode_client, "events", new=event_stream),
            patch.object(agent.opencode_client, "abort", new=abort),
            patch.object(
                agent.opencode_client,
                "reject_permission",
                new=reject_permission,
            ),
            patch.object(agent.settings, "opencode_terminal_timeout_seconds", timeout),
        ):
            result = await agent._run_opencode_prompt(
                websocket=websocket,
                conversation_id="conversation-1",
                session_id="session-1",
                directory="workspace",
                text="test",
                images=[],
            )
        return result, websocket.messages, abort

    async def test_publish_tool_error_marks_turn_failed_but_consumes_until_idle(self):
        async def events():
            yield _event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "tool-1",
                        "tool": "bash",
                        "state": {
                            "status": "error",
                            "input": {"command": "node .opencode/tools/publish-course-pipeline.mjs demo"},
                            "error": "exit code 1",
                        },
                    }
                },
            )
            yield _event("message.part.delta", {"field": "text", "delta": "发布失败说明"})
            yield _event("session.idle")

        (ok, response), messages, abort = await self._run_prompt(events)

        self.assertFalse(ok)
        self.assertEqual(response, "发布失败说明")
        self.assertTrue(any(
            message["type"] == "agent_tool_result"
            and message["payload"]["is_error"]
            for message in messages
        ))
        self.assertTrue(any(
            message["type"] == "agent_error"
            and "工具 bash 执行失败" in message["payload"]["message"]
            for message in messages
        ))
        abort.assert_not_awaited()

    async def test_non_terminal_validator_error_can_be_repaired_by_the_agent(self):
        async def events():
            yield _event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "tool-validator",
                        "tool": "bash",
                        "state": {
                            "status": "error",
                            "input": {"command": "node check-graph.mjs graph.json"},
                            "error": "validation failed",
                        },
                    }
                },
            )
            yield _event("session.idle")

        (ok, _), messages, abort = await self._run_prompt(events)

        self.assertTrue(ok)
        self.assertTrue(any(
            message["type"] == "agent_tool_result"
            and message["payload"]["is_error"]
            for message in messages
        ))
        self.assertFalse(any(message["type"] == "agent_error" for message in messages))
        abort.assert_not_awaited()

    async def test_recovered_publish_error_does_not_fail_turn(self):
        command = "node .opencode/tools/publish-course-pipeline.mjs demo"

        async def events():
            yield _event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "tool-failed",
                        "tool": "bash",
                        "state": {
                            "status": "error",
                            "input": {"command": command},
                            "error": "first attempt failed",
                        },
                    }
                },
            )
            yield _event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "tool-retried",
                        "tool": "bash",
                        "state": {
                            "status": "completed",
                            "input": {"command": command},
                            "output": '{"courseId":"demo"}',
                        },
                    }
                },
            )
            yield _event("session.idle")

        (ok, _), messages, abort = await self._run_prompt(events)

        self.assertTrue(ok)
        self.assertFalse(any(message["type"] == "agent_error" for message in messages))
        abort.assert_not_awaited()

    async def test_event_stream_eof_without_terminal_event_fails_and_aborts(self):
        async def events():
            if False:
                yield _event("session.idle")

        (ok, _), messages, abort = await self._run_prompt(events)

        self.assertFalse(ok)
        self.assertTrue(any(
            message["type"] == "agent_error"
            and "没有收到 session.idle 或 session.error" in message["payload"]["message"]
            for message in messages
        ))
        abort.assert_awaited_once_with("session-1")

    async def test_terminal_timeout_fails_and_aborts(self):
        async def events():
            await asyncio.Event().wait()
            if False:
                yield _event("session.idle")

        (ok, _), messages, abort = await self._run_prompt(events, timeout=0.02)

        self.assertFalse(ok)
        self.assertTrue(any(
            message["type"] == "agent_error"
            and "未返回会话终态" in message["payload"]["message"]
            for message in messages
        ))
        abort.assert_awaited_once_with("session-1")

    async def test_question_wait_time_does_not_consume_terminal_timeout(self):
        async def events():
            yield _event(
                "question.asked",
                {
                    "id": "question-1",
                    "questions": [
                        {
                            "header": "发布课程",
                            "question": "是否发布？",
                            "options": [{"label": "确认", "description": "继续发布"}],
                        }
                    ],
                },
            )
            await asyncio.sleep(0.05)
            yield _event("question.replied", {"requestID": "question-1"})
            yield _event("session.idle")

        (ok, _), _, abort = await self._run_prompt(events, timeout=0.02)

        self.assertTrue(ok)
        abort.assert_not_awaited()

    async def test_child_permission_request_is_rejected_and_aborts_parent(self):
        async def events():
            yield {
                "directory": "workspace",
                "payload": {
                    "type": "permission.asked",
                    "properties": {
                        "id": "permission-1",
                        "sessionID": "child-session-1",
                        "permission": "doom_loop",
                        "patterns": ["invalid"],
                        "metadata": {},
                        "always": ["invalid"],
                    },
                },
            }

        (ok, _), messages, abort = await self._run_prompt(events)

        self.assertFalse(ok)
        self.reject_permission.assert_awaited_once_with(
            "permission-1",
            "workspace",
            "该权限不在课程创建工作流的允许范围内。",
        )
        self.assertTrue(any(
            message["type"] == "agent_error"
            and "doom_loop" in message["payload"]["message"]
            for message in messages
        ))
        abort.assert_awaited_once_with("session-1")

    async def test_failed_prompt_never_commits_workspace(self):
        websocket = _WebSocket()
        conversation_store = Mock()
        conversation_store.get_opencode_session.return_value = "session-1"
        course_store = Mock()
        active_session = {"id": None}
        agent._opencode_sessions.pop("agent:course-create:no-commit-test", None)

        with (
            patch.object(agent, "get_conversation_store", return_value=conversation_store),
            patch.object(agent, "get_course_store", return_value=course_store),
            patch.object(agent, "_resolve_opencode_model", return_value="model-1"),
            patch.object(
                agent.model_config,
                "get_model",
                return_value=SimpleNamespace(base_url="http://model", api_key="key"),
            ),
            patch.object(agent.opencode_provision, "ensure_course_creation_session_assets", return_value="workspace"),
            patch.object(agent.opencode_provision, "host_course_creation_workspace_dir", return_value="workspace"),
            patch.object(agent.opencode_client, "health", new=AsyncMock(return_value={})),
            patch.object(agent, "_run_opencode_prompt", new=AsyncMock(return_value=(False, ""))),
        ):
            await agent._run_agent_turn_opencode(
                websocket,
                {
                    "message": "创建课程",
                    "conversation_id": "no-commit-test",
                    "mode": "agent",
                    "workflow": "course-create",
                },
                active_session,
            )

        course_store.commit_workspace.assert_not_called()
        self.assertTrue(any(
            message["type"] == "agent_done"
            and message["payload"]["return_code"] == 1
            for message in websocket.messages
        ))
        self.assertIsNone(active_session["id"])


if __name__ == "__main__":
    unittest.main()
