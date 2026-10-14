from __future__ import annotations

import unittest

from src.services.ai.base import AIRequest
from src.services.ai.gateway_provider import GatewayProvider


class GatewayProviderCompatibilityTest(unittest.TestCase):
    def test_moonshot_requests_omit_unsupported_temperature(self) -> None:
        provider = GatewayProvider(
            "https://api.moonshot.cn/v1",
            "test-key",
            ["kimi-k2.6"],
        )
        request = AIRequest(
            system_prompt="system",
            messages=[{"role": "user", "content": "outline"}],
            model="kimi-k2.6",
            temperature=0.0,
        )

        payload = provider._completion_kwargs(request, [{"role": "user", "content": "outline"}])

        self.assertNotIn("temperature", payload)

    def test_non_moonshot_positive_temperature_is_preserved(self) -> None:
        provider = GatewayProvider(
            "https://api.example.test/v1",
            "test-key",
            ["example-model"],
        )
        request = AIRequest(
            system_prompt="system",
            messages=[],
            model="example-model",
            temperature=0.4,
        )

        payload = provider._completion_kwargs(request, [])

        self.assertEqual(payload["temperature"], 0.4)


if __name__ == "__main__":
    unittest.main()
