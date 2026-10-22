import unittest

from src.api import agent
from src.services.opencode import provision


class CourseAgentPromptContractTest(unittest.TestCase):
    def test_runtime_and_workspace_prompts_require_content_contract_branching(self):
        prompt = provision._SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")

        self.assertEqual(agent._system_prompt(), prompt)
        self.assertEqual(provision._agents_md(), prompt)
        for required in (
            "content.schema_version",
            "textbook-content/2.0",
            "content.blocks",
            "普通 legacy 课程继续使用原栏目格式",
            "禁止写入或回填 `coreIdea`",
            "basedOnBlockIds",
            "顶层 `sourceSpans/modelEnriched` 是兼容派生值",
        ):
            with self.subTest(required=required):
                self.assertIn(required, prompt)

    def test_prompt_preserves_legacy_and_requires_grounded_v2_new_points(self):
        prompt = provision._agents_md()

        self.assertIn("非空 `principles`", prompt)
        self.assertIn("非空 `applications`", prompt)
        self.assertIn("origin: llm-extension", prompt)
        self.assertIn("至少包含一个教材上下文块和一个模型补充块", prompt)
        self.assertIn("不要编造、扩大或挪用材料", prompt)


if __name__ == "__main__":
    unittest.main()
