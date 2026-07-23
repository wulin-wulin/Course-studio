from __future__ import annotations

import asyncio
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

from src.api import agent
from src.api import reviews as reviews_api
from src.services.reviews import CourseReviewConflictError
from src.services.reviews.activity import CourseActivityCoordinator


class _WebSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.messages.append(message)


def _course_request(conversation_id: str) -> dict:
    return {
        "message": "创建课程",
        "conversation_id": conversation_id,
        "mode": "agent",
        "workflow": "course-create",
    }


def _review_request(conversation_id: str) -> reviews_api.ReviewSubmitRequest:
    return reviews_api.ReviewSubmitRequest(
        conversation_id=conversation_id,
        revision=1,
        artifact_hash="a" * 64,
        operations=[],
    )


class CourseActivityConcurrencyTest(unittest.IsolatedAsyncioTestCase):
    async def test_active_agent_rejects_second_websocket_and_review_submit(self):
        coordinator = CourseActivityCoordinator()
        first_started = asyncio.Event()
        finish_first = asyncio.Event()

        async def hold_first_turn(*args, **kwargs) -> None:
            first_started.set()
            await finish_first.wait()

        unlocked_turn = AsyncMock(side_effect=hold_first_turn)
        review_store = Mock()
        review_store.submit.return_value = {"ok": True}
        review_store_getter = Mock(return_value=review_store)
        first_socket = _WebSocket()
        second_socket = _WebSocket()
        conversation_id = "shared/conversation"

        with (
            patch.object(
                agent,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                reviews_api,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                agent,
                "_run_agent_turn_opencode_unlocked",
                new=unlocked_turn,
            ),
            patch.object(
                reviews_api,
                "get_course_review_store",
                new=review_store_getter,
            ),
        ):
            first_task = asyncio.create_task(
                agent._run_agent_turn_opencode(
                    first_socket,
                    _course_request(conversation_id),
                    {"id": None},
                )
            )
            await asyncio.wait_for(first_started.wait(), timeout=1)

            await agent._run_agent_turn_opencode(
                second_socket,
                _course_request(conversation_id),
                {"id": None},
            )
            with self.assertRaises(HTTPException) as raised:
                await reviews_api.submit_review(
                    "review-1",
                    _review_request(conversation_id),
                )

            self.assertEqual(raised.exception.status_code, 409)
            self.assertEqual(unlocked_turn.await_count, 1)
            review_store_getter.assert_not_called()
            review_store.submit.assert_not_called()
            self.assertEqual(
                [message["type"] for message in second_socket.messages],
                ["agent_error", "agent_done"],
            )
            self.assertEqual(
                second_socket.messages[0]["payload"]["code"],
                "course_activity_conflict",
            )

            finish_first.set()
            await first_task
            result = await reviews_api.submit_review(
                "review-1",
                _review_request(conversation_id),
            )

        self.assertEqual(result, {"ok": True})
        review_store_getter.assert_called_once()
        review_store.submit.assert_called_once()

    async def test_failed_review_submit_releases_lease_for_agent(self):
        coordinator = CourseActivityCoordinator()
        submit_started = threading.Event()
        finish_submit = threading.Event()

        def fail_after_release(*args, **kwargs):
            submit_started.set()
            if not finish_submit.wait(timeout=2):
                raise AssertionError("timed out waiting to finish review submit")
            raise CourseReviewConflictError("forced submit failure")

        review_store = Mock()
        review_store.submit.side_effect = fail_after_release
        unlocked_turn = AsyncMock(return_value=None)
        blocked_socket = _WebSocket()
        recovered_socket = _WebSocket()
        conversation_id = "review-race"

        with (
            patch.object(
                agent,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                reviews_api,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                agent,
                "_run_agent_turn_opencode_unlocked",
                new=unlocked_turn,
            ),
            patch.object(
                reviews_api,
                "get_course_review_store",
                return_value=review_store,
            ),
        ):
            submit_task = asyncio.create_task(
                reviews_api.submit_review(
                    "review-1",
                    _review_request(conversation_id),
                )
            )
            started = await asyncio.to_thread(submit_started.wait, 1)
            self.assertTrue(started)

            await agent._run_agent_turn_opencode(
                blocked_socket,
                _course_request(conversation_id),
                {"id": None},
            )
            unlocked_turn.assert_not_awaited()
            self.assertEqual(
                blocked_socket.messages[0]["payload"]["code"],
                "course_activity_conflict",
            )

            finish_submit.set()
            with self.assertRaises(HTTPException) as raised:
                await submit_task
            self.assertEqual(raised.exception.status_code, 409)

            await agent._run_agent_turn_opencode(
                recovered_socket,
                _course_request(conversation_id),
                {"id": None},
            )

        unlocked_turn.assert_awaited_once()

    async def test_failed_agent_turn_releases_lease_for_retry(self):
        coordinator = CourseActivityCoordinator()
        unlocked_turn = AsyncMock(
            side_effect=[RuntimeError("forced turn failure"), None]
        )
        conversation_id = "agent-failure"

        with (
            patch.object(
                agent,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                agent,
                "_run_agent_turn_opencode_unlocked",
                new=unlocked_turn,
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "forced turn failure"):
                await agent._run_agent_turn_opencode(
                    _WebSocket(),
                    _course_request(conversation_id),
                    {"id": None},
                )

            await agent._run_agent_turn_opencode(
                _WebSocket(),
                _course_request(conversation_id),
                {"id": None},
            )

        self.assertEqual(unlocked_turn.await_count, 2)

    async def test_cancelled_submit_keeps_lease_until_worker_finishes(self):
        coordinator = CourseActivityCoordinator()
        submit_started = threading.Event()
        finish_submit = threading.Event()
        submit_lease_released = threading.Event()

        def hold_submit(*args, **kwargs):
            submit_started.set()
            if not finish_submit.wait(timeout=2):
                raise AssertionError("timed out waiting to finish cancelled submit")
            return {"ok": True}

        original_release = coordinator.release

        def track_release(lease):
            released = original_release(lease)
            if lease.kind == "review-submit" and released:
                submit_lease_released.set()
            return released

        review_store = Mock()
        review_store.submit.side_effect = hold_submit
        unlocked_turn = AsyncMock(return_value=None)
        conversation_id = "cancelled-submit"

        with (
            patch.object(coordinator, "release", side_effect=track_release),
            patch.object(
                agent,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                reviews_api,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                agent,
                "_run_agent_turn_opencode_unlocked",
                new=unlocked_turn,
            ),
            patch.object(
                reviews_api,
                "get_course_review_store",
                return_value=review_store,
            ),
        ):
            submit_task = asyncio.create_task(
                reviews_api.submit_review(
                    "review-1",
                    _review_request(conversation_id),
                )
            )
            started = await asyncio.to_thread(submit_started.wait, 1)
            self.assertTrue(started)
            submit_task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await submit_task

            blocked_socket = _WebSocket()
            await agent._run_agent_turn_opencode(
                blocked_socket,
                _course_request(conversation_id),
                {"id": None},
            )
            unlocked_turn.assert_not_awaited()
            self.assertEqual(
                blocked_socket.messages[0]["payload"]["code"],
                "course_activity_conflict",
            )

            finish_submit.set()
            released = await asyncio.to_thread(submit_lease_released.wait, 1)
            self.assertTrue(released)
            await agent._run_agent_turn_opencode(
                _WebSocket(),
                _course_request(conversation_id),
                {"id": None},
            )

        unlocked_turn.assert_awaited_once()

    async def test_cancelled_agent_keeps_lease_until_inner_turn_finishes(self):
        coordinator = CourseActivityCoordinator()
        turn_started = asyncio.Event()
        finish_turn = asyncio.Event()
        agent_lease_released = threading.Event()

        async def hold_turn(*args, **kwargs) -> None:
            turn_started.set()
            await finish_turn.wait()

        original_release = coordinator.release

        def track_release(lease):
            released = original_release(lease)
            if lease.kind == "agent-turn" and released:
                agent_lease_released.set()
            return released

        unlocked_turn = AsyncMock(side_effect=hold_turn)
        review_store = Mock()
        review_store.submit.return_value = {"ok": True}
        conversation_id = "cancelled-agent"

        with (
            patch.object(coordinator, "release", side_effect=track_release),
            patch.object(
                agent,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                reviews_api,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                agent,
                "_run_agent_turn_opencode_unlocked",
                new=unlocked_turn,
            ),
            patch.object(
                reviews_api,
                "get_course_review_store",
                return_value=review_store,
            ),
        ):
            turn_task = asyncio.create_task(
                agent._run_agent_turn_opencode(
                    _WebSocket(),
                    _course_request(conversation_id),
                    {"id": None},
                )
            )
            await asyncio.wait_for(turn_started.wait(), timeout=1)
            turn_task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await turn_task

            with self.assertRaises(HTTPException) as raised:
                await reviews_api.submit_review(
                    "review-1",
                    _review_request(conversation_id),
                )
            self.assertEqual(raised.exception.status_code, 409)
            review_store.submit.assert_not_called()

            finish_turn.set()
            released = await asyncio.to_thread(agent_lease_released.wait, 1)
            self.assertTrue(released)
            result = await reviews_api.submit_review(
                "review-1",
                _review_request(conversation_id),
            )

        self.assertEqual(result, {"ok": True})
        review_store.submit.assert_called_once()

    async def test_agent_exception_aborts_session_before_releasing_lease(self):
        coordinator = CourseActivityCoordinator()
        timeline: list[str] = []
        original_release = coordinator.release

        async def fail_with_active_session(websocket, payload, active_session) -> None:
            active_session["id"] = "session-1"
            raise RuntimeError("forced active-session failure")

        async def abort(session_id: str) -> None:
            self.assertEqual(session_id, "session-1")
            timeline.append("abort")

        def track_release(lease):
            timeline.append("release")
            return original_release(lease)

        with (
            patch.object(coordinator, "release", side_effect=track_release),
            patch.object(
                agent,
                "get_course_activity_coordinator",
                return_value=coordinator,
            ),
            patch.object(
                agent,
                "_run_agent_turn_opencode_unlocked",
                new=AsyncMock(side_effect=fail_with_active_session),
            ),
            patch.object(agent.opencode_client, "abort", new=AsyncMock(side_effect=abort)),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "forced active-session failure",
            ):
                await agent._run_agent_turn_opencode(
                    _WebSocket(),
                    _course_request("active-session-failure"),
                    {"id": None},
                )

        self.assertEqual(timeline, ["abort", "release"])


if __name__ == "__main__":
    unittest.main()
