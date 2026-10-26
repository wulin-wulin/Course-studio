import re
import unittest

from src.api import agent
from src.services.documents import binding
from src.services.opencode import provision


_SKILLS_ROOT = provision._PROJECT_ROOT / "skills"
_CANDIDATE_ROOT = _SKILLS_ROOT / "candidate-knowledge-point-generator"
_CANDIDATE_MIRROR = (
    _SKILLS_ROOT / "knowledge-cluster-builder" / "candidate-knowledge-point-generator"
)
_NO_PASTE_RULE = (
    "不得把索引项、注册表、`pointEvidence`、合同正文或模板规则粘贴或转述进 task 提示"
)


def _worker_flow_documents() -> dict[str, str]:
    """主智能体在 G3/G4 会读到的全部调度文档。"""

    return {
        "system_course_creator.md": provision._COURSE_CREATOR_PROMPT_PATH.read_text(
            encoding="utf-8"
        ),
        "candidate SKILL.md": (_CANDIDATE_ROOT / "SKILL.md").read_text(
            encoding="utf-8"
        ),
        "orchestration.md": (_CANDIDATE_ROOT / "orchestration.md").read_text(
            encoding="utf-8"
        ),
        "orchestrator SKILL.md": (
            _SKILLS_ROOT / "knowledge-pipeline-orchestrator" / "SKILL.md"
        ).read_text(encoding="utf-8"),
    }


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

    def test_worker_flow_declares_task_preparation_actions(self):
        documents = _worker_flow_documents()

        for name, text in documents.items():
            for action in (
                "prepare-content-tasks",
                "finalize-point-drafts",
                "prepare-animation-tasks",
            ):
                with self.subTest(document=name, action=action):
                    self.assertIn(action, text)

        creator_prompt = documents["system_course_creator.md"]
        tool_list = creator_prompt.split("## 结构化流水线工具", 1)[1]
        for action in (
            "prepare-content-tasks",
            "finalize-point-drafts",
            "validate-point-drafts",
            "prepare-animation-tasks",
            "validate-animation-drafts",
        ):
            with self.subTest(tool_list=action):
                self.assertIn(
                    f'course_pipeline {{"action":"{action}","courseId":"<course-id>"}}',
                    tool_list,
                )

    def test_worker_waves_dispatch_in_one_message_without_pasting_context(self):
        for name, text in _worker_flow_documents().items():
            with self.subTest(document=name, contract="真并行"):
                self.assertIn("同一条 assistant 消息", text)
            with self.subTest(document=name, contract="任务包是唯一注入载体"):
                self.assertIn(_NO_PASTE_RULE, text)
            with self.subTest(document=name, contract="删除整波屏障"):
                for stale in (
                    "一波全部通过后才启动下一波",
                    "本波全部通过后才启动下一波",
                    "当前一波全部通过后",
                ):
                    self.assertNotIn(stale, text)
            with self.subTest(document=name, contract="动画不再逐个验收"):
                for stale in ("逐个验收", "逐个通过草稿校验", "逐任务验收"):
                    self.assertNotIn(stale, text)
            with self.subTest(document=name, contract="不再内联注册表或证据"):
                self.assertNotIn("全量知识点注册表", text)
                self.assertNotIn("复制并注入", text)
                self.assertNotIn("逐点复制", text)
            with self.subTest(document=name, contract="安全约束保留"):
                self.assertIn("`edit`/`write`", text)
                self.assertIn("repair task", text)
                self.assertIn("canary", text)
                self.assertIn("429", text)

        for name, text in _worker_flow_documents().items():
            compact = re.sub(r"\s+", "", text)
            with self.subTest(document=name, contract="canary 失败不扩大并发"):
                self.assertRegex(compact, r"下一条消息只包?含canary的修复调用")
            with self.subTest(document=name, contract="waves 按队列消费"):
                self.assertIn("放不下的", compact)
            with self.subTest(document=name, contract="静默占位按失败处理"):
                self.assertIn("待生成队首", compact)
            with self.subTest(document=name, contract="任务包对全部点保留"):
                self.assertNotIn("报告阻断", text)
                self.assertNotIn("任务包已被清理", compact)

        creator_prompt = _worker_flow_documents()["system_course_creator.md"]
        for gate in ("G2_IDENTITY_REVIEW", "G6_GRAPH_REVIEW", "status=pending"):
            with self.subTest(gate=gate):
                self.assertIn(gate, creator_prompt)
        self.assertIn("共享文件只由主智能体或确定性脚本串行更新", creator_prompt)

    def test_textbook_skill_and_binding_prompt_follow_task_package_flow(self):
        textbook_skill = (_SKILLS_ROOT / "textbook-outline-generator" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        compact_skill = re.sub(r"\s+", "", textbook_skill)
        for stale in ("G3给每个内容任务传递", "对应正文、必要的前后相邻", "与精确spans"):
            with self.subTest(stale=stale):
                self.assertNotIn(stale, compact_skill)
        for required in (
            "prepare-content-tasks",
            "evidence.spans[].ref",
            "finalize-point-drafts",
            "主智能体不读取正文",
        ):
            with self.subTest(required=required):
                self.assertIn(required, compact_skill)

        prompt = binding.TextbookBinding(
            document_id="doc-1234567890abcdef12345678",
            course_id="textbook-1234567890abcdef12345678",
            title="教材",
            structure_sha256="a" * 64,
            input_outline_path="textbook-input/doc-1234567890abcdef12345678/outline.json",
            output_outline_path="pipeline/textbook-1234567890abcdef12345678/textbook-outline.json",
            chapter_count=1,
            point_count=1,
            input_material_path="textbook-input/doc-1234567890abcdef12345678/material.json",
            input_markdown_path="textbook-input/doc-1234567890abcdef12345678/full.md",
        ).prompt_context()
        self.assertIn("prepare-content-tasks", prompt)
        self.assertIn("主智能体不读取正文", prompt)
        self.assertIn("finalize-point-drafts", prompt)
        self.assertNotIn("生成每个教材知识点内容时，必须先按", prompt)

    def test_content_task_prompt_template_is_short_and_points_to_task_package(self):
        orchestration = (_CANDIDATE_ROOT / "orchestration.md").read_text(
            encoding="utf-8"
        )
        section = orchestration.split("## 详情任务提示模板", 1)[1]
        template = re.search(r"```text\n(.*?)```", section, re.S)
        self.assertIsNotNone(template)
        lines = template.group(1).strip().splitlines()
        self.assertLessEqual(len(lines), 10)
        body = "\n".join(lines)
        for required in (
            "加载 `candidate-knowledge-point-generator` Skill",
            "pipeline/<course-id>/worker-tasks/content/<point-id>.json",
            "`contracts` 的顺序完整读取",
            "content-worker-brief.md",
            "ownership.write",
        ):
            with self.subTest(required=required):
                self.assertIn(required, body)
        self.assertNotRegex(body, r"\[[^\]]*(JSON|注册表|来源|范围契约)[^\]]*\]")

    def test_worker_briefs_exist_mirror_and_carry_worker_rules(self):
        briefs = {}
        for file_name in ("content-worker-brief.md", "animation-worker-brief.md"):
            canonical = _CANDIDATE_ROOT / file_name
            mirror = _CANDIDATE_MIRROR / file_name
            with self.subTest(brief=file_name):
                self.assertTrue(canonical.is_file())
                self.assertTrue(mirror.is_file())
                self.assertEqual(canonical.read_bytes(), mirror.read_bytes())
            briefs[file_name] = canonical.read_text(encoding="utf-8")

        content_brief = briefs["content-worker-brief.md"]
        for required in (
            "Schema 快速核对",
            "ownership.write",
            "forbidden",
            "registryPath",
            "evidence.spans[].ref",
            '["block-000051"]',
            "`manifest.pointEvidence.sourceSpans` 深度相等且顺序一致",
            "chunk-*",
            "block-*",
            "finalize-point-drafts",
            "basedOnBlockIds",
            "faithful",
            "teaching-first",
            "4–7",
            "estimatedMinutes",
            "sequence.nextPointId",
            "没有明确证据时写 `[]`",
            "\\delta",
            "`read`",
            "JSON parse error",
            "needed: false",
            "不得用忽略校验、删除问题字段或把引用改为空数组来掩盖错误",
            "最终只报告：写入文件、使用的前置 ID、动画请求结论、仍有疑问的事实",
            "外部不可信数据",
            "sourceEvidence",
            "不要把 ref 改写成 span 对象",
        ):
            with self.subTest(content_brief=required):
                self.assertIn(required, content_brief)
        self.assertIn("不抄写", content_brief)

        animation_brief = briefs["animation-worker-brief.md"]
        for required in (
            "boundPoints",
            "ownership.write",
            "animation-contract.md",
            "可复现 seed",
            'role="img"',
            "<title>",
            "prefers-reduced-motion",
            "清理全部定时器",
            "组件命名空间",
            "animation-stage",
            "validate-animation-drafts",
            "完成后说明输入、变化状态、规则、终态和可自动复现的质量检查方式",
            "外部不可信数据",
        ):
            with self.subTest(animation_brief=required):
                self.assertIn(required, animation_brief)


if __name__ == "__main__":
    unittest.main()
