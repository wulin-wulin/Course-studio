import asyncio
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import agent, courses as courses_api
from src.services.courses.store import CourseStore, CourseValidationError


def _source_span() -> dict:
    return {
        "materialId": "doc-example",
        "blockIds": ["section-1"],
        "headingPath": ["第一章", "基础概念"],
        "lineStart": 10,
        "lineEnd": 18,
        "assetRefs": [],
        "excerptSha256": "a" * 64,
    }


def _textbook_point() -> dict:
    return {
        "id": "point-a",
        "title": "教材知识点",
        "clusterId": "cluster-a",
        "shortSummary": "这个摘要用于验证教材内容块在课程存储层能够保持完整且不被旧字段污染。",
        "difficulty": "基础",
        "importance": 0.8,
        "keyTerms": ["教材", "内容块"],
        "pos": [100, 100],
        "scale": 1,
        "animationType": "none",
        "prerequisites": [],
        "origin": "textbook",
        "content": {
            "schema_version": "textbook-content/2.0",
            "blocks": [
                {
                    "id": "textbook-definition",
                    "kind": "definition",
                    "title": "教材定义",
                    "markdown": "教材给出的定义和适用范围。",
                    "provenance": {
                        "origin": "textbook",
                        "representation": "paraphrase",
                        "sourceSpans": [_source_span()],
                    },
                },
                {
                    "id": "model-example",
                    "kind": "example",
                    "title": "补充示例",
                    "markdown": "根据教材定义补充一个新的应用示例。",
                    "provenance": {
                        "origin": "model",
                        "basedOnBlockIds": ["textbook-definition"],
                    },
                },
            ],
        },
    }


def _with_learning_design(point: dict) -> dict:
    designed = deepcopy(point)
    content = designed["content"]
    for block in content["blocks"]:
        block["moduleId"] = "concept-and-practice"
        block["depth"] = "core"
    content["learningDesign"] = {
        "primaryPattern": "concept-example-check",
        "adaptationLevel": "balanced",
        "editorialPolicy": (
            "保持教材事实、定义与边界，允许围绕学习目标重排并补充例题。"
        ),
        "estimatedMinutes": 12,
        "outcomes": [
            {"id": "explain-concept", "text": "解释核心概念及其适用范围。"},
            {"id": "apply-concept", "text": "在新情境中正确应用该概念。"},
        ],
        "misconceptions": ["把适用范围之外的情形也视为该概念。"],
        "modules": [
            {
                "id": "concept-and-practice",
                "title": "概念与练习",
                "role": "worked-example",
                "outcomeRefs": ["explain-concept", "apply-concept"],
                "order": 0,
            }
        ],
        "completion": {
            "outcomeRefs": ["explain-concept", "apply-concept"],
            "method": "完成迁移练习并说明判断依据。",
            "successCriteria": ["结论正确", "能指出教材依据"],
            "exerciseBlockId": "model-example",
        },
    }
    content["learningAssets"] = [
        {
            "id": "concept-check",
            "type": "formative-check",
            "anchorBlockId": "model-example",
            "moduleId": "concept-and-practice",
            "depth": "core",
            "outcomeRefs": ["apply-concept"],
            "learningPurpose": "检查学习者能否把教材定义迁移到新情境。",
            "grounding": {"basedOnBlockIds": ["textbook-definition"]},
            "config": {"attempts": 2, "showHint": True},
            "fallback": {
                "type": "markdown",
                "markdown": "请说明示例是否满足教材定义，并写出依据。",
            },
        }
    ]
    return designed


def _index_meta(point: dict) -> dict:
    return {
        key: deepcopy(point[key])
        for key in (
            "id",
            "title",
            "clusterId",
            "shortSummary",
            "difficulty",
            "importance",
            "keyTerms",
            "pos",
            "scale",
        )
    }


class CourseTextbookContentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.store = CourseStore(root / "courses", root / "workspaces")
        self.course = {"id": "demo-course", "title": "演示课程"}
        self.point = _textbook_point()
        self.index = {
            "courseId": "demo-course",
            "clusters": [{"id": "cluster-a", "title": "第一章"}],
            "points": [
                {
                    key: deepcopy(self.point[key])
                    for key in (
                        "id",
                        "title",
                        "clusterId",
                        "shortSummary",
                        "difficulty",
                        "importance",
                        "keyTerms",
                        "pos",
                        "scale",
                    )
                }
            ],
        }

    def validate(self, point: dict | None = None):
        detail = point or self.point
        return self.store._validate_course_objects(
            "demo-course",
            self.course,
            self.index,
            {"point-a": detail},
            strict_details=True,
        )

    def sequence_course(self):
        points: dict[str, dict] = {}
        for suffix, title in (("a", "第一点"), ("b", "第二点"), ("c", "第三点")):
            point = _with_learning_design(self.point)
            point["id"] = f"point-{suffix}"
            point["title"] = title
            points[point["id"]] = point
        index = {
            "courseId": "demo-course",
            "clusters": [{"id": "cluster-a", "title": "第一章"}],
            "points": [_index_meta(point) for point in points.values()],
            "sequences": {
                "cluster": [],
                "point": [
                    {"fromId": "point-a", "toId": "point-b"},
                    {"fromId": "point-b", "toId": "point-c"},
                ],
            },
        }
        return index, points

    def persist_point(self, point: dict | None = None) -> None:
        self.store.create_course(
            self.course,
            {
                "clusters": [{"id": "cluster-a", "title": "第一簇"}],
                "points": [],
            },
        )
        self.store.create_point("demo-course", point or self.point)

    def overwrite_persisted_point(self, point: dict) -> None:
        path = self.store.root / "demo-course" / "points" / "point-a.json"
        path.write_text(
            json.dumps(point, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def test_normalise_v2_does_not_inject_legacy_content_fields(self):
        normalised = self.store._normalise_point(self.point)
        self.assertNotIn("coreIdea", normalised)
        self.assertNotIn("principles", normalised)
        self.assertNotIn("applications", normalised)
        self.assertEqual(normalised["content"], self.point["content"])

    def test_complete_v2_point_passes_strict_storage_validation(self):
        result = self.validate()
        self.assertTrue(result.ok, result.errors)

    def test_v2_learning_design_and_assets_pass_and_survive_normalisation(self):
        designed = _with_learning_design(self.point)

        result = self.validate(designed)
        normalised = self.store._normalise_point(designed)

        self.assertTrue(result.ok, result.errors)
        self.assertEqual(normalised["content"], designed["content"])
        self.assertEqual(
            normalised["content"]["learningDesign"]["adaptationLevel"],
            "balanced",
        )
        self.assertEqual(
            normalised["content"]["learningAssets"][0]["anchorBlockId"],
            "model-example",
        )

    def test_v2_learning_design_defaults_adaptation_to_balanced(self):
        designed = _with_learning_design(self.point)
        del designed["content"]["learningDesign"]["adaptationLevel"]

        result = self.validate(designed)

        self.assertTrue(result.ok, result.errors)

    def test_v2_completion_next_point_matches_canonical_course_sequence(self):
        index, points = self.sequence_course()
        points["point-a"]["content"]["learningDesign"]["completion"][
            "nextPointId"
        ] = "point-b"
        points["point-b"]["content"]["learningDesign"]["completion"][
            "nextPointId"
        ] = "point-c"

        result = self.store._validate_course_objects(
            "demo-course",
            self.course,
            index,
            points,
            strict_details=True,
        )

        self.assertTrue(result.ok, result.errors)

    def test_v2_completion_uses_linearized_cluster_and_point_sequences(self):
        index, points = self.sequence_course()
        points["point-c"]["clusterId"] = "cluster-b"
        index["clusters"] = [
            {"id": "cluster-a", "title": "第一章"},
            {"id": "cluster-b", "title": "第二章"},
        ]
        # Source order is intentionally different. The canonical order is
        # cluster-a then cluster-b, with point-a then point-b inside cluster-a.
        index["points"] = [
            _index_meta(points["point-c"]),
            _index_meta(points["point-b"]),
            _index_meta(points["point-a"]),
        ]
        index["sequences"] = {
            "cluster": [{"fromId": "cluster-a", "toId": "cluster-b"}],
            "point": [{"fromId": "point-a", "toId": "point-b"}],
        }
        points["point-b"]["content"]["learningDesign"]["completion"][
            "nextPointId"
        ] = "point-c"

        result = self.store._validate_course_objects(
            "demo-course",
            self.course,
            index,
            points,
            strict_details=True,
        )

        self.assertTrue(result.ok, result.errors)

    def test_v2_completion_next_point_must_exist_in_current_course(self):
        index, points = self.sequence_course()
        points["point-a"]["content"]["learningDesign"]["completion"][
            "nextPointId"
        ] = "missing-point"

        result = self.store._validate_course_objects(
            "demo-course",
            self.course,
            index,
            points,
            strict_details=True,
        )

        self.assertFalse(result.ok)
        self.assertIn(
            "nextPointId 引用了本课程不存在的知识点：missing-point",
            "\n".join(result.errors),
        )

    def test_v2_completion_next_point_must_be_direct_canonical_successor(self):
        index, points = self.sequence_course()
        points["point-a"]["content"]["learningDesign"]["completion"][
            "nextPointId"
        ] = "point-c"

        result = self.store._validate_course_objects(
            "demo-course",
            self.course,
            index,
            points,
            strict_details=True,
        )

        self.assertFalse(result.ok)
        self.assertIn(
            "nextPointId 必须指向规范学习顺序中的直接下一点 point-b，实际为 point-c",
            "\n".join(result.errors),
        )

    def test_v2_completion_last_point_may_omit_next_point(self):
        index, points = self.sequence_course()

        result = self.store._validate_course_objects(
            "demo-course",
            self.course,
            index,
            points,
            strict_details=True,
        )

        self.assertTrue(result.ok, result.errors)

        points["point-c"]["content"]["learningDesign"]["completion"][
            "nextPointId"
        ] = "point-a"
        invalid = self.store._validate_course_objects(
            "demo-course",
            self.course,
            index,
            points,
            strict_details=True,
        )
        self.assertIn(
            "位于规范学习顺序末尾",
            "\n".join(invalid.errors),
        )

    def test_v2_completion_next_point_keeps_legacy_course_without_sequences_compatible(self):
        index, points = self.sequence_course()
        index.pop("sequences")
        points["point-a"]["content"]["learningDesign"]["completion"][
            "nextPointId"
        ] = "point-c"

        result = self.store._validate_course_objects(
            "demo-course",
            self.course,
            index,
            points,
            strict_details=True,
        )

        self.assertTrue(result.ok, result.errors)

    def test_v2_learning_design_rejects_dangling_references_and_invalid_depth(self):
        invalid = _with_learning_design(self.point)
        invalid["content"]["blocks"][0]["moduleId"] = "missing-module"
        invalid["content"]["blocks"][1]["depth"] = "deep"
        invalid["content"]["learningDesign"]["modules"][0]["outcomeRefs"] = [
            "missing-outcome"
        ]
        invalid["content"]["learningAssets"][0]["anchorBlockId"] = "missing-block"

        result = self.validate(invalid)

        self.assertFalse(result.ok)
        joined = "\n".join(result.errors)
        self.assertIn("引用了不存在的教学模块：missing-module", joined)
        self.assertIn("depth 必须是 core/support/advanced", joined)
        self.assertIn("引用了不存在的学习目标：missing-outcome", joined)
        self.assertIn("引用了不存在的内容块：missing-block", joined)

    def test_v2_learning_assets_require_grounding_purpose_and_usable_fallback(self):
        invalid = _with_learning_design(self.point)
        asset = invalid["content"]["learningAssets"][0]
        asset["learningPurpose"] = ""
        asset["grounding"]["basedOnBlockIds"] = ["missing-block"]
        asset["fallback"] = {"type": "markdown"}

        result = self.validate(invalid)

        self.assertFalse(result.ok)
        joined = "\n".join(result.errors)
        self.assertIn("learningPurpose 必须是非空字符串", joined)
        self.assertIn("grounding 引用了不存在的内容块：missing-block", joined)
        self.assertIn("fallback 必须提供可用的降级内容", joined)

    def test_v2_learning_design_rejects_duplicate_ids_and_unknown_fields(self):
        invalid = _with_learning_design(self.point)
        duplicate = deepcopy(invalid["content"]["learningDesign"]["outcomes"][0])
        invalid["content"]["learningDesign"]["outcomes"].append(duplicate)
        invalid["content"]["learningAssets"][0]["unreviewedPayload"] = True

        result = self.validate(invalid)

        self.assertFalse(result.ok)
        joined = "\n".join(result.errors)
        self.assertIn("outcomes[2].id 重复：explain-concept", joined)
        self.assertIn("包含未知字段：unreviewedPayload", joined)

    def test_default_course_validation_enforces_versioned_content_contract(self):
        self.persist_point()
        invalid = deepcopy(self.point)
        invalid["content"]["blocks"][0]["markdown"] = r"错误的裸命令 \Sigma"
        self.overwrite_persisted_point(invalid)

        result = self.store.validate_course("demo-course")

        self.assertFalse(result.ok)
        self.assertIn("LaTeX 命令必须放在数学分隔符内", "\n".join(result.errors))

    def test_default_course_validation_rejects_damaged_content_envelope(self):
        self.persist_point()
        invalid = deepcopy(self.point)
        invalid["content"]["schema_version"] = "textbook-content/1.0"
        self.overwrite_persisted_point(invalid)

        result = self.store.validate_course("demo-course")

        self.assertFalse(result.ok)
        self.assertIn(
            "content.schema_version 必须是 textbook-content/2.0",
            "\n".join(result.errors),
        )

    def test_rest_and_agent_validation_report_v2_content_errors(self):
        self.persist_point()
        invalid = deepcopy(self.point)
        invalid["content"]["blocks"][0]["markdown"] = r"错误的裸命令 \Sigma"
        self.overwrite_persisted_point(invalid)

        app = FastAPI()
        app.include_router(courses_api.router, prefix="/courses")
        with patch.object(courses_api, "get_course_store", return_value=self.store):
            response = TestClient(app).get("/courses/demo-course/validate")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["ok"])
        self.assertIn("LaTeX 命令必须放在数学分隔符内", "\n".join(response.json()["errors"]))

        with patch.object(agent, "get_course_store", return_value=self.store):
            output, is_error, changed = asyncio.run(
                agent._execute_course_tool(
                    object(),
                    "validation-test",
                    "validate_course",
                    {"course_id": "demo-course"},
                )
            )
        payload = json.loads(output)
        self.assertFalse(is_error)
        self.assertIsNone(changed)
        self.assertFalse(payload["ok"])
        self.assertIn("LaTeX 命令必须放在数学分隔符内", "\n".join(payload["errors"]))

    def test_default_validation_keeps_incomplete_legacy_details_compatible(self):
        legacy = deepcopy(self.point)
        legacy.pop("content")
        legacy.pop("origin")
        legacy.update(
            {
                "coreIdea": "旧版核心内容",
                "principles": ["旧版原理"],
                "applications": ["旧版应用"],
            }
        )
        self.persist_point(legacy)
        legacy.pop("prerequisites")
        self.overwrite_persisted_point(legacy)

        compatible = self.store.validate_course("demo-course")
        strict = self.store.validate_course("demo-course", strict_details=True)

        self.assertTrue(compatible.ok, compatible.errors)
        self.assertIn("缺少 prerequisites", "\n".join(compatible.warnings))
        self.assertFalse(strict.ok)
        self.assertIn("缺少 prerequisites", "\n".join(strict.errors))

    def test_v2_rejects_visible_paragraph_escapes_and_bare_latex(self):
        invalid = deepcopy(self.point)
        invalid["content"]["blocks"][0]["markdown"] = (
            r"第一段\n\n第二段使用 \Sigma-\Delta 转换器。"
        )

        result = self.validate(invalid)

        self.assertFalse(result.ok)
        joined = "\n".join(result.errors)
        self.assertIn(r"字面量 \n\n", joined)
        self.assertIn("LaTeX 命令必须放在数学分隔符内", joined)

    def test_v2_allows_real_paragraphs_delimited_math_and_code(self):
        valid = deepcopy(self.point)
        valid["content"]["blocks"][0]["markdown"] = (
            "第一段。\n\n"
            r"第二段使用 $\Sigma-\Delta$，并兼容旧公式 \(x + y\)。"
            "\n\n"
            r"代码示例：`\Sigma 与 \n\n`。"
        )

        result = self.validate(valid)

        self.assertTrue(result.ok, result.errors)

    def test_v2_markdown_uses_commonmark_fence_code_and_math_boundaries(self):
        valid = deepcopy(self.point)
        valid["content"]["blocks"][0]["markdown"] = (
            "```text\r"
            r"\Sigma 与 \n\n 均为代码"
            "\r```still-code\r"
            r"\Gamma 仍在代码围栏内"
            "\r```\n\n"
            r"双反引号代码：``\Sigma ` 与 \n\n``。"
            "\n\n"
            r"反斜杠不转义代码内的关闭符：`\Sigma\`。"
            "\n\n"
            r"偶数个反斜杠后的公式：\\$\Sigma$。"
            "\n\n"
            r"不同长度的中间美元符仍可属于公式：$$\Sigma$$$ x $$。"
        )

        result = self.validate(valid)

        self.assertTrue(result.ok, result.errors)

    def test_v2_markdown_rejects_non_code_and_non_math_delimiter_lookalikes(self):
        cases = {
            "escaped inline opener": r"\`\Sigma 与 \n\n`",
            "mismatched inline closer": r"`\Sigma``",
            "mismatched dollar run": r"$$\Sigma$$$",
            "escaped legacy delimiters": r"\\(\Sigma\\)",
            "backtick in fence info": (
                "```bad`info\n" + r"\Sigma 与 \n\n" + "\n```"
            ),
            "doubled bare command": r"\\Sigma",
            "one-letter bare command": r"\R",
        }

        for name, markdown in cases.items():
            with self.subTest(name=name):
                invalid = deepcopy(self.point)
                invalid["content"]["blocks"][0]["markdown"] = markdown
                result = self.validate(invalid)
                self.assertFalse(result.ok)
                self.assertTrue(
                    any(
                        "LaTeX 命令必须放在数学分隔符内" in error
                        for error in result.errors
                    ),
                    result.errors,
                )

        escaped_code = deepcopy(self.point)
        escaped_code["content"]["blocks"][0]["markdown"] = (
            r"\`普通文本中的 \n\n 不是代码`"
        )
        result = self.validate(escaped_code)
        self.assertTrue(
            any(r"字面量 \n\n" in error for error in result.errors),
            result.errors,
        )

    def test_v2_model_block_cannot_cross_a_later_textbook_block(self):
        invalid = deepcopy(self.point)
        invalid["content"]["blocks"].insert(
            1,
            {
                "id": "textbook-followup",
                "kind": "explanation",
                "markdown": "教材随后进入另一个主题。",
                "provenance": {
                    "origin": "textbook",
                    "representation": "paraphrase",
                    "sourceSpans": [_source_span()],
                },
            },
        )

        result = self.validate(invalid)

        self.assertFalse(result.ok)
        self.assertIn("不能跨过后续教材块", "\n".join(result.errors))

    def test_published_v2_may_expose_matching_derived_provenance(self):
        published = deepcopy(self.point)
        published["sourceSpans"] = [_source_span()]
        published["modelEnriched"] = True
        result = self.validate(published)
        self.assertTrue(result.ok, result.errors)

        published["modelEnriched"] = False
        result = self.validate(published)
        self.assertFalse(result.ok)
        self.assertTrue(any("modelEnriched 必须与 content.blocks 派生值一致" in error for error in result.errors))

    def test_v2_rejects_legacy_double_write_and_forward_model_reference(self):
        invalid = deepcopy(self.point)
        invalid["coreIdea"] = "不应与内容块同时保存"
        invalid["content"]["blocks"][1]["provenance"]["basedOnBlockIds"] = [
            "future-block"
        ]
        result = self.validate(invalid)
        self.assertFalse(result.ok)
        self.assertTrue(any("不允许同时保存旧字段" in error for error in result.errors))
        self.assertTrue(any("只能引用排在当前块之前" in error for error in result.errors))

    def test_v2_source_span_uses_the_complete_contract(self):
        invalid = deepcopy(self.point)
        span = invalid["content"]["blocks"][0]["provenance"]["sourceSpans"][0]
        span["unexpected"] = True
        span["blockIds"] = ["section-1", "section-1"]
        span["headingPath"] = [""]
        span["lineStart"] = True
        span["lineEnd"] = 0
        span["page"] = 0
        span["assetRefs"] = ["figure-1", "figure-1"]
        span["excerptSha256"] = "A" * 64

        result = self.validate(invalid)

        self.assertFalse(result.ok)
        joined = "\n".join(result.errors)
        self.assertIn("包含未知字段：unexpected", joined)
        self.assertIn("blockIds 不允许重复项", joined)
        self.assertIn("headingPath 必须是至少包含 1 项非空字符串的数组", joined)
        self.assertIn("lineStart 必须是正整数", joined)
        self.assertIn("lineEnd 必须是不小于 lineStart 的正整数", joined)
        self.assertIn("page 必须是正整数", joined)
        self.assertIn("assetRefs 不允许重复项", joined)
        self.assertIn("excerptSha256 必须是小写 SHA-256", joined)

    def test_update_revalidates_existing_v2_and_rejects_downgrade(self):
        self.persist_point()

        with self.assertRaises(CourseValidationError):
            self.store.update_point(
                "demo-course",
                "point-a",
                {"modelEnriched": False},
            )

        with self.assertRaises(CourseValidationError) as downgrade:
            self.store.update_point(
                "demo-course",
                "point-a",
                {"content": {"schema_version": "textbook-content/1.0", "blocks": []}},
            )
        self.assertIn("不允许降级或移除 v2 content", "\n".join(downgrade.exception.errors))

        invalid_content = deepcopy(self.point["content"])
        invalid_content["blocks"][0]["provenance"]["sourceSpans"][0]["lineEnd"] = 0
        with self.assertRaises(CourseValidationError):
            self.store.update_point(
                "demo-course",
                "point-a",
                {"content": invalid_content},
            )

        updated = self.store.update_point(
            "demo-course",
            "point-a",
            {"title": "更新后的教材知识点"},
        )
        self.assertEqual(updated["title"], "更新后的教材知识点")
        self.assertEqual(updated["content"], self.point["content"])

    def test_update_revalidates_learning_design_and_asset_references(self):
        designed = _with_learning_design(self.point)
        self.persist_point(designed)
        invalid_content = deepcopy(designed["content"])
        invalid_content["learningAssets"][0]["outcomeRefs"] = ["missing-outcome"]

        with self.assertRaises(CourseValidationError) as rejected:
            self.store.update_point(
                "demo-course",
                "point-a",
                {"content": invalid_content},
            )

        self.assertIn(
            "引用了不存在的学习目标：missing-outcome",
            "\n".join(rejected.exception.errors),
        )

    def test_workspace_change_revalidates_existing_v2_derived_fields(self):
        self.persist_point()
        workspace = self.store.prepare_workspace("textbook-v2-edit")
        point_path = workspace.path / "demo-course" / "points" / "point-a.json"
        staged = json.loads(point_path.read_text(encoding="utf-8"))
        staged["sourceSpans"] = []
        point_path.write_text(
            json.dumps(staged, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        with self.assertRaises(CourseValidationError) as rejected:
            self.store.commit_workspace(workspace)
        self.assertIn(
            "顶层 sourceSpans 必须与 content.blocks 派生值一致",
            "\n".join(rejected.exception.errors),
        )

    def test_legacy_point_updates_remain_supported(self):
        legacy = deepcopy(self.point)
        legacy.pop("content")
        legacy.pop("origin")
        legacy.update(
            {
                "coreIdea": "旧版核心内容",
                "principles": ["旧版原理一", "旧版原理二"],
                "applications": ["旧版应用"],
            }
        )
        self.persist_point(legacy)

        updated = self.store.update_point(
            "demo-course",
            "point-a",
            {"coreIdea": "更新后的旧版核心内容"},
        )
        self.assertEqual(updated["coreIdea"], "更新后的旧版核心内容")
        self.assertNotIn("content", updated)


if __name__ == "__main__":
    unittest.main()
