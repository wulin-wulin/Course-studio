from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from scripts import smoke_test_course_creation as smoke


class _WebSocket:
    def __init__(self, events: list[dict]) -> None:
        self.events = list(events)
        self.sent: list[dict] = []

    async def send(self, value: str) -> None:
        self.sent.append(json.loads(value))

    async def recv(self) -> str:
        return json.dumps(self.events.pop(0))


class _Response:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self.payload


class _ReviewClient:
    def __init__(self) -> None:
        self.submitted: dict | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url: str) -> _Response:
        return _Response(
            {
                "id": "review-points",
                "conversation_id": "conversation",
                "kind": "knowledge-points",
                "gate": "G2_IDENTITY_REVIEW",
                "revision": 2,
                "artifact_hash": "a" * 64,
            }
        )

    async def post(self, url: str, *, json: dict) -> _Response:
        self.submitted = json
        return _Response(
            {
                "ok": True,
                "review": {
                    "id": "review-points",
                    "status": "resolved",
                    "resume_pending": True,
                },
            }
        )


class SmokeCourseCreationContractTest(unittest.IsolatedAsyncioTestCase):
    async def test_turn_captures_structured_review_and_sends_resume_id(self):
        review = {
            "id": "review-points",
            "kind": "knowledge-points",
            "gate": "G2_IDENTITY_REVIEW",
        }
        websocket = _WebSocket(
            [
                {"type": "agent_text_delta", "payload": {"text": "outline ready"}},
                {"type": "agent_review_required", "payload": review},
                {
                    "type": "agent_done",
                    "payload": {"return_code": 0, "awaiting_review": True},
                },
            ]
        )

        text, question_count, captured = await smoke.run_turn(
            websocket,
            conversation_id="conversation",
            review_resume_id="review-previous",
            model=None,
            api_url="http://unused/api",
            timeout=1,
        )

        self.assertEqual(text, "outline ready")
        self.assertEqual(question_count, 0)
        self.assertEqual(captured, review)
        request = websocket.sent[0]["payload"]
        self.assertEqual(request["conversation_id"], "conversation")
        self.assertEqual(request["review_resume_id"], "review-previous")
        self.assertEqual(request["message"], "")

    async def test_review_submission_uses_current_revision_and_empty_operations(self):
        client = _ReviewClient()
        with patch.object(smoke.httpx, "AsyncClient", return_value=client):
            approved = await smoke.approve_review(
                api_url="http://localhost/api",
                conversation_id="conversation",
                review={
                    "id": "review-points",
                    "conversation_id": "conversation",
                    "kind": "knowledge-points",
                    "gate": "G2_IDENTITY_REVIEW",
                },
            )

        self.assertEqual(approved["id"], "review-points")
        self.assertEqual(
            client.submitted,
            {
                "conversation_id": "conversation",
                "revision": 2,
                "artifact_hash": "a" * 64,
                "operations": [],
            },
        )


if __name__ == "__main__":
    unittest.main()
