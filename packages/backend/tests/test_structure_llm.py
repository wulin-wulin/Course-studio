"""Unit tests for the opt-in, proposal-only structure LLM helper."""

from __future__ import annotations

import copy
import unittest
from unittest.mock import AsyncMock, patch

from src.services.documents.structure_llm import (
    StructureLLMError,
    propose_structure,
)


class StructureLLMTest(unittest.TestCase):
    def setUp(self) -> None:
        self.candidate = {
            "schema_version": "structure-candidate/1.0",
            "chapters": [
                {
                    "number": "1",
                    "title": "数字逻辑概述",
                    "source_refs": [{"page_idx": 12, "text": "第 1 章 数字逻辑概述"}],
                }
            ],
            "auxiliary_sections": [],
            "diagnostics": {"chapter_numbers": ["1"]},
        }

    def test_disabled_is_fail_soft_and_does_not_call_provider(self) -> None:
        with patch("src.services.documents.structure_llm.ai_router.get_provider") as get_provider:
            self.assertIsNone(propose_structure(self.candidate, enabled=False))
            get_provider.assert_not_called()

    def test_required_disabled_raises(self) -> None:
        with self.assertRaises(StructureLLMError):
            propose_structure(self.candidate, enabled=False, required=True)

    def test_valid_json_is_parsed_and_input_is_not_mutated(self) -> None:
        original = copy.deepcopy(self.candidate)
        provider = type("Provider", (), {})()
        provider.generate = AsyncMock(
            return_value=(
                '{"schema_version":"structure-proposal/1.0",'
                '"chapters":[],"auxiliary_sections":[],"warnings":[]}'
            )
        )
        with patch(
            "src.services.documents.structure_llm.ai_router.get_provider",
            return_value=provider,
        ):
            result = propose_structure(self.candidate, enabled=True, model="test-model", required=True)
        self.assertEqual(result["schema_version"], "structure-proposal/1.0")
        self.assertEqual(self.candidate, original)
        provider.generate.assert_awaited_once()

    def test_json_code_fence_is_accepted(self) -> None:
        provider = type("Provider", (), {})()
        provider.generate = AsyncMock(
            return_value='```json\n{"schema_version":"structure-proposal/1.0","chapters":[],"auxiliary_sections":[],"warnings":[]}\n```'
        )
        with patch(
            "src.services.documents.structure_llm.ai_router.get_provider",
            return_value=provider,
        ):
            result = propose_structure(self.candidate, enabled=True, model="test-model", required=True)
        self.assertEqual(result["warnings"], [])

    def test_invalid_json_is_rejected(self) -> None:
        provider = type("Provider", (), {})()
        provider.generate = AsyncMock(return_value="not-json")
        with patch(
            "src.services.documents.structure_llm.ai_router.get_provider",
            return_value=provider,
        ):
            with self.assertRaises(StructureLLMError):
                propose_structure(self.candidate, enabled=True, model="test-model", required=True)

    def test_provider_failure_is_fail_soft_by_default(self) -> None:
        provider = type("Provider", (), {})()
        provider.generate = AsyncMock(side_effect=RuntimeError("offline"))
        with patch(
            "src.services.documents.structure_llm.ai_router.get_provider",
            return_value=provider,
        ):
            self.assertIsNone(propose_structure(self.candidate, enabled=True, model="test-model"))


if __name__ == "__main__":
    unittest.main()
