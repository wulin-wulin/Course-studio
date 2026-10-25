from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from src.main import app
from src.api import settings as settings_api
from src.config import settings


class MinerUSettingsApiTest(unittest.TestCase):
    """Contract tests for the user-facing MinerU configuration endpoint.

    The tests patch the process settings and the .env destination so they never
    read or modify a developer's real credentials.
    """

    _FIELDS = (
        "document_parser",
        "mineru_api_base",
        "mineru_api_token",
        "mineru_timeout_seconds",
        "mineru_model_version",
    )

    def setUp(self) -> None:
        self.client = TestClient(app)
        self.temporary = tempfile.TemporaryDirectory()
        self.env_path = Path(self.temporary.name) / ".env"
        self.env_path.write_text("# test environment\n", encoding="utf-8")
        self.original = {field: getattr(settings, field) for field in self._FIELDS}
        self._set_defaults()
        self.env_patch = patch.object(settings_api, "ENV_PATH", self.env_path)
        self.env_patch.start()

    def tearDown(self) -> None:
        self.env_patch.stop()
        for field, value in self.original.items():
            setattr(settings, field, value)
        self.temporary.cleanup()

    def _set_defaults(self) -> None:
        settings.document_parser = "local"
        settings.mineru_api_base = "https://mineru.net/api/v4"
        settings.mineru_api_token = "test-mineru-token-123456"
        settings.mineru_timeout_seconds = 300.0
        settings.mineru_model_version = "vlm"

    def test_get_masks_token_and_reports_configuration_without_leaking_secret(self) -> None:
        response = self.client.get("/api/settings/mineru")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["document_parser"], "local")
        self.assertEqual(payload["mineru_api_base"], "https://mineru.net/api/v4")
        self.assertTrue(payload["mineru_token_configured"])
        self.assertNotEqual(payload["mineru_api_token"], settings.mineru_api_token)
        self.assertNotIn(settings.mineru_api_token, response.text)

    def test_put_updates_memory_and_env_while_returning_only_masked_token(self) -> None:
        response = self.client.put(
            "/api/settings/mineru",
            json={
                "document_parser": "mineru",
                "mineru_api_base": "https://api.example.test/api/v4",
                "mineru_api_token": "replacement-token-abcdef",
                "mineru_timeout_seconds": 480,
                "mineru_model_version": "pipeline",
            },
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["document_parser"], "mineru")
        self.assertEqual(payload["mineru_api_base"], "https://api.example.test/api/v4")
        self.assertEqual(payload["mineru_timeout_seconds"], 480)
        self.assertEqual(payload["mineru_model_version"], "pipeline")
        self.assertTrue(payload["mineru_token_configured"])
        self.assertNotIn("replacement-token-abcdef", response.text)

        # The parser reads the same settings object, so a new upload can use
        # the selected cloud parser without restarting the backend process.
        self.assertEqual(settings.document_parser, "mineru")
        self.assertEqual(settings.mineru_api_base, "https://api.example.test/api/v4")
        self.assertEqual(settings.mineru_api_token, "replacement-token-abcdef")
        persisted = self.env_path.read_text(encoding="utf-8")
        self.assertIn("DOCUMENT_PARSER=mineru", persisted)
        self.assertIn("MINERU_API_BASE=https://api.example.test/api/v4", persisted)
        self.assertIn("MINERU_API_TOKEN=replacement-token-abcdef", persisted)
        self.assertIn("MINERU_TIMEOUT_SECONDS=480", persisted)
        self.assertIn("MINERU_MODEL_VERSION=pipeline", persisted)

    def test_masked_or_omitted_token_preserves_existing_secret(self) -> None:
        original_token = settings.mineru_api_token

        for value in ("***", "***hidden***"):
            response = self.client.put(
                "/api/settings/mineru",
                json={"mineru_api_token": value, "document_parser": "auto"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(settings.mineru_api_token, original_token)

        response = self.client.put(
            "/api/settings/mineru",
            json={"document_parser": "local"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(settings.mineru_api_token, original_token)

    def test_read_only_env_returns_service_unavailable_without_partial_update(self) -> None:
        original_base = settings.mineru_api_base
        original_parser = settings.document_parser
        with patch.object(settings_api, "_persist_env", side_effect=OSError("read-only")):
            response = self.client.put(
                "/api/settings/mineru",
                json={
                    "document_parser": "mineru",
                    "mineru_api_base": "https://api.example.test/api/v4",
                },
            )

        self.assertEqual(response.status_code, 503)
        self.assertNotIn("read-only", response.text)
        self.assertEqual(settings.mineru_api_base, original_base)
        self.assertEqual(settings.document_parser, original_parser)

    def test_invalid_parser_model_timeout_and_base_are_rejected(self) -> None:
        invalid_requests = (
            {"document_parser": "remote"},
            {"mineru_model_version": "unknown"},
            {"mineru_timeout_seconds": 0},
            {"mineru_timeout_seconds": 3601},
            {"mineru_api_base": "file:///tmp/mineru"},
            {"mineru_api_base": "https://user:password@example.test/api/v4"},
            {"mineru_api_base": "https://example.test/api/v4?token=secret"},
            {"mineru_api_base": "https://example.test/api/v4#secret"},
            {"mineru_api_token": "token\nINJECTED=1"},
        )

        for body in invalid_requests:
            with self.subTest(body=body):
                response = self.client.put("/api/settings/mineru", json=body)
                self.assertIn(response.status_code, {400, 422})

        secret = "x" * 4097
        response = self.client.put(
            "/api/settings/mineru",
            json={"mineru_api_token": secret, "mineru_model_version": "invalid"},
        )
        self.assertIn(response.status_code, {400, 422})
        self.assertNotIn(secret, response.text)


if __name__ == "__main__":
    unittest.main()
