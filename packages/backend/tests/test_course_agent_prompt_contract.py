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

    def test_prompts_plan_outcomes_before_blocks_and_bound_editorial_adaptation(self):
        prompts = [
            provision._agents_md(),
            provision._COURSE_CREATOR_PROMPT_PATH.read_text(encoding="utf-8"),
        ]

        for prompt in prompts:
            with self.subTest(prompt=prompt[:40]):
                self.assertIn("learningDesign", prompt)
                self.assertIn("outcomes", prompt)
                self.assertIn("modules", prompt)
                self.assertIn("completion", prompt)
                self.assertIn("faithful|balanced|teaching-first", prompt)
                self.assertIn("保留教材术语和主要", prompt)
                self.assertIn("重建叙事", prompt)
                self.assertIn("重排教学顺序", prompt)
                self.assertIn("压缩重复", prompt)
                self.assertIn("事实、定义、公式", prompt)
                self.assertIn("固定 token", prompt)
                self.assertIn("4–7", prompt)
                self.assertIn("正文不要", prompt)
                self.assertIn("estimatedMinutes", prompt)
                self.assertIn("公式/表格", prompt)
                self.assertIn("learningAssets", prompt)
                self.assertIn("grounding.basedOnBlockIds", prompt)
                self.assertIn("fallback", prompt)
                self.assertIn("正反例", prompt)
                self.assertIn("错误恢复", prompt)
                self.assertIn("症状", prompt)
                self.assertIn("反思", prompt)


if __name__ == "__main__":
    unittest.main()
