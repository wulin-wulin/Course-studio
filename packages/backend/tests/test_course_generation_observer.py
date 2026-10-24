import asyncio
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from src.services.courses.generation import (
    CourseGenerationObserver,
    _valid_textbook_point,
    build_course_generation_snapshot,
)
from src.services.courses.store import _validate_textbook_content_point


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _index_point(point_id: str, title: str, importance: float) -> dict:
    return {
        "id": point_id,
        "title": title,
        "shortSummary": f"{title}用于测试课程生成进度观察器，并提供足够长度的稳定索引摘要内容。",
        "difficulty": "基础",
        "importance": importance,
        "keyTerms": [title, "测试"],
    }


def _complete_point(point_id: str, title: str, importance: float) -> dict:
    return {
        **_index_point(point_id, title, importance),
        "coreIdea": f"{title}的核心思想",
        "principles": ["第一条原理", "第二条原理"],
        "applications": ["课程生成状态测试"],
        "aliases": [],
        "intuition": "用一个直观示例解释这个知识点。",
        "misconceptions": ["常见误解与对应纠正。"],
        "qa": [{"q": "测试问题是什么？", "a": "这是测试问题的答案。"}],
        "animationType": "none",
        "prerequisites": [],
    }


def _complete_textbook_point(point_id: str, title: str, importance: float) -> dict:
    return {
        **_index_point(point_id, title, importance),
        "origin": "textbook",
        "animationType": "none",
        "prerequisites": [],
        "content": {
            "schema_version": "textbook-content/2.0",
            "blocks": [
                {
                    "id": "textbook-explanation",
                    "kind": "explanation",
                    "markdown": f"教材对{title}的完整讲解。",
                    "provenance": {
                        "origin": "textbook",
                        "representation": "paraphrase",
                        "sourceSpans": [{
                            "materialId": "material-1",
                            "blockIds": [f"{point_id}-section"],
                            "headingPath": ["第一章", title],
                            "lineStart": 10,
                            "lineEnd": 20,
                            "assetRefs": [],
                            "excerptSha256": "a" * 64,
                        }],
                    },
                },
                {
                    "id": "model-example",
                    "kind": "worked-example",
                    "markdown": f"模型为{title}补充的例题。",
                    "provenance": {
                        "origin": "model",
                        "basedOnBlockIds": ["textbook-explanation"],
                    },
                },
            ],
        },
    }


def _complete_designed_textbook_point(
    point_id: str, title: str, importance: float
) -> dict:
    point = deepcopy(_complete_textbook_point(point_id, title, importance))
    content = point["content"]
    for block in content["blocks"]:
        block["moduleId"] = "learn-and-check"
        block["depth"] = "core"
    content["learningDesign"] = {
        "primaryPattern": "explain-practice",
        "adaptationLevel": "balanced",
        "editorialPolicy": "保持教材事实与边界，围绕应用目标补充示例。",
        "estimatedMinutes": 10,
        "outcomes": [{"id": "explain-topic", "text": "解释并应用主题。"}],
        "misconceptions": [],
        "modules": [
            {
                "id": "learn-and-check",
                "title": "学习与检查",
                "outcomeRefs": ["explain-topic"],
                "order": 0,
            }
        ],
        "completion": {"exerciseBlockId": "model-example"},
    }
    content["learningAssets"] = [
        {
            "id": "topic-check",
            "type": "formative-check",
            "anchorBlockId": "model-example",
            "outcomeRefs": ["explain-topic"],
            "learningPurpose": "检查能否应用教材内容。",
            "grounding": {"basedOnBlockIds": ["textbook-explanation"]},
            "fallback": {"type": "markdown", "markdown": "回答检查题。"},
        }
    ]
    return point


class CourseGenerationSnapshotTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.pipeline_root = Path(self.temporary.name) / "pipeline"
        self.pipeline = self.pipeline_root / "demo-course"
        self.content = self.pipeline / "course-content"
        self.data = self.content / "src/data"
        self.index_points = [
            _index_point("first-point", "第一知识点", 0.9),
            _index_point("second-point", "第二知识点", 0.7),
        ]

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def snapshot(self, **kwargs) -> dict:
        return build_course_generation_snapshot(
            self.pipeline_root,
            "conversation-1",
            **kwargs,
        )

    def write_course_and_index(self) -> None:
        _write(self.data / "course.json", {
            "schema_version": "1.0",
            "id": "demo-course",
            "title": "演示课程",
            "description": "观察课程创建进度",
        })
        _write(self.data / "index.json", {
            "schema_version": "course-content-index/1.0",
            "courseId": "demo-course",
            "points": self.index_points,
        })

    def test_index_point_completion_and_graph_progression(self):
        self.assertEqual(self.snapshot()["gate"], "G0")

        self.write_course_and_index()
        indexed = self.snapshot()
        self.assertEqual(indexed["gate"], "G1")
        self.assertEqual(indexed["total_points"], 2)
        self.assertFalse(any(point["complete"] for point in indexed["points"]))

        _write(self.content / "generation/manifest.json", {
            "schema_version": "course-content-generation/1.0",
            "subject": {"id": "demo-course"},
            "generation": {"pointCount": 2},
            "sources": [],
            "pointEvidence": [
                {"pointId": "first-point"},
                {"pointId": "second-point"},
            ],
            "reviewQueue": [],
        })
        self.assertEqual(self.snapshot()["gate"], "G2")

        # Placeholders and malformed in-flight JSON must not count as complete.
        _write(self.data / "points/first-point.json", {})
        (self.data / "points/second-point.json").write_text("{", encoding="utf-8")
        started = self.snapshot()
        self.assertEqual(started["gate"], "G3")
        self.assertFalse(any(point["complete"] for point in started["points"]))

        first = _complete_point("first-point", "第一知识点", 0.9)
        second = _complete_point("second-point", "第二知识点", 0.7)
        _write(self.data / "points/first-point.json", first)
        content = self.snapshot()
        self.assertEqual(content["gate"], "G3")
        self.assertEqual(
            [point["complete"] for point in content["points"]],
            [True, False],
        )
        _write(self.data / "points/second-point.json", second)

        _write(self.content / "generation/animation-manifest.json", {
            "schema_version": "course-content-animations/1.0",
            "animations": [],
        })
        self.assertEqual(self.snapshot()["gate"], "G4")
        for path in (
            self.content / "src/data/courseKnowledge.ts",
            self.content / "src/components/AnimationBlock.tsx",
            self.content / "src/components/AnimationBlock.css",
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("generated", encoding="utf-8")
        self.assertEqual(self.snapshot()["gate"], "G5")

        graph_points = [
            {**first, "clusterIds": ["fundamentals"], "role": "trunk", "related": []},
            {**second, "clusterIds": ["fundamentals"], "role": "branch", "related": []},
        ]
        _write(self.pipeline / "clustered-graph.json", {
            "schema_version": "clustered-graph/2.0",
            "subject": {"id": "demo-course"},
            "generation": {
                "sourceCourseId": "demo-course",
                "pointCount": 2,
                "clusterCount": 1,
            },
            "clusters": [{
                "id": "fundamentals",
                "title": "基础知识",
                "subtitle": "从基础开始",
                "description": "课程的基础知识簇。",
                "order": 1,
            }],
            "points": graph_points,
        })
        graph = self.snapshot()
        self.assertEqual(graph["gate"], "G6")
        self.assertFalse(graph["published"])
        self.assertEqual(graph["points"][0]["clusterId"], "fundamentals")
        self.assertEqual(graph["clusters"][0]["title"], "基础知识")

        published = self.snapshot(published=True)
        self.assertEqual(published["gate"], "G7")
        self.assertTrue(published["published"])

    def test_textbook_v2_point_and_thin_graph_progression(self):
        self.write_course_and_index()
        _write(self.content / "generation/manifest.json", {
            "schema_version": "course-content-generation/1.0",
            "subject": {"id": "demo-course"},
            "generation": {
                "pointCount": 2,
                "contentContract": "textbook-content/2.0",
            },
            "sources": [],
            "pointEvidence": [
                {"pointId": "first-point"},
                {"pointId": "second-point"},
            ],
            "reviewQueue": [],
        })
        first = _complete_designed_textbook_point(
            "first-point", "第一知识点", 0.9
        )
        second = _complete_designed_textbook_point(
            "second-point", "第二知识点", 0.7
        )
        _write(self.data / "points/first-point.json", first)
        _write(self.data / "points/second-point.json", second)

        content = self.snapshot()
        self.assertEqual(content["gate"], "G3")
        self.assertEqual(
            [point["complete"] for point in content["points"]],
            [True, True],
        )

        _write(self.content / "generation/animation-manifest.json", {
            "schema_version": "course-content-animations/1.0",
            "animations": [],
        })
        for path in (
            self.content / "src/data/courseKnowledge.ts",
            self.content / "src/components/AnimationBlock.tsx",
            self.content / "src/components/AnimationBlock.css",
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("generated", encoding="utf-8")

        _write(self.pipeline / "clustered-graph.json", {
            "schema_version": "clustered-graph/3.0",
            "subject": {"id": "demo-course"},
            "generation": {
                "sourceCourseId": "demo-course",
                "pointCount": 2,
                "clusterCount": 1,
            },
            "clusters": [{
                "id": "fundamentals",
                "title": "基础知识",
                "subtitle": "从基础开始",
                "description": "课程的基础知识簇。",
                "order": 1,
            }],
            "sequences": {
                "cluster": [],
                "point": [{"fromId": "first-point", "toId": "second-point"}],
            },
            "points": [
                {
                    "id": first["id"],
                    "title": first["title"],
                    "origin": "textbook",
                    "clusterIds": ["fundamentals"],
                    "role": "trunk",
                    "prerequisites": [],
                    "related": [],
                },
                {
                    "id": second["id"],
                    "title": second["title"],
                    "origin": "textbook",
                    "clusterIds": ["fundamentals"],
                    "role": "leaf",
                    "prerequisites": [],
                    "related": [],
                },
            ],
        })

        graph = self.snapshot()
        self.assertEqual(graph["gate"], "G6")
        self.assertEqual(graph["points"][0]["clusterId"], "fundamentals")
        self.assertEqual(self.snapshot(published=True)["gate"], "G7")

    def test_designed_textbook_point_completion_uses_strict_content_contract(self):
        expected = _index_point("first-point", "First point", 0.9)
        point = _complete_designed_textbook_point(
            "first-point", "First point", 0.9
        )

        self.assertEqual(_validate_textbook_content_point(point, "point"), [])
        self.assertTrue(_valid_textbook_point(point, expected))

        missing_outcome = deepcopy(point)
        missing_outcome["content"]["learningAssets"][0]["outcomeRefs"] = [
            "missing-outcome"
        ]

        unknown_design_field = deepcopy(point)
        unknown_design_field["content"]["learningDesign"]["unexpected"] = True

        invalid_module_role = deepcopy(point)
        invalid_module_role["content"]["learningDesign"]["modules"][0]["role"] = ""

        mismatched_asset_module = deepcopy(point)
        mismatched_asset_module["content"]["learningAssets"][0][
            "moduleId"
        ] = "missing-module"

        unusable_asset_fallback = deepcopy(point)
        unusable_asset_fallback["content"]["learningAssets"][0]["fallback"] = {
            "markdown": "Answer the check."
        }

        forward_grounding = deepcopy(point)
        forward_grounding["content"]["learningAssets"][0][
            "anchorBlockId"
        ] = "textbook-explanation"
        forward_grounding["content"]["learningAssets"][0]["grounding"] = {
            "basedOnBlockIds": ["model-example"]
        }

        for name, invalid in {
            "unknown learningDesign field": unknown_design_field,
            "invalid module role": invalid_module_role,
            "missing asset outcome": missing_outcome,
            "unknown asset module": mismatched_asset_module,
            "unusable asset fallback": unusable_asset_fallback,
            "asset grounded after its anchor": forward_grounding,
        }.items():
            with self.subTest(name=name):
                self.assertTrue(
                    _validate_textbook_content_point(invalid, "point"),
                    "test mutation must be rejected by the canonical validator",
                )
                self.assertFalse(_valid_textbook_point(invalid, expected))

        legacy_v2 = _complete_textbook_point("first-point", "First point", 0.9)
        self.assertEqual(_validate_textbook_content_point(legacy_v2, "point"), [])
        self.assertFalse(
            _valid_textbook_point(legacy_v2, expected),
            "stored legacy v2 remains readable but cannot count as a newly generated point",
        )

        missing_mode = deepcopy(point)
        del missing_mode["content"]["learningDesign"]["adaptationLevel"]
        self.assertEqual(_validate_textbook_content_point(missing_mode, "point"), [])
        self.assertFalse(_valid_textbook_point(missing_mode, expected))


class CourseGenerationObserverTest(unittest.IsolatedAsyncioTestCase):
    async def test_emits_initial_and_changed_snapshots_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            pipeline_root = Path(temporary) / "pipeline"
            observer = CourseGenerationObserver(
                pipeline_root,
                "conversation-2",
                interval_seconds=0.01,
            )
            messages: list[dict] = []

            async def send(message: dict) -> None:
                messages.append(message)

            await observer.emit_if_changed(send)
            await observer.emit_if_changed(send)
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["type"], "course_generation_snapshot")

            data = pipeline_root / "new-course/course-content/src/data"
            _write(data / "course.json", {
                "schema_version": "1.0",
                "id": "new-course",
                "title": "新课程",
            })
            _write(data / "index.json", {
                "schema_version": "course-content-index/1.0",
                "courseId": "new-course",
                "points": [_index_point("only-point", "唯一知识点", 0.8)],
            })
            await observer.emit_if_changed(send)
            await observer.emit_if_changed(send)
            self.assertEqual(len(messages), 2)
            self.assertEqual(messages[-1]["payload"]["gate"], "G1")

    async def test_keeps_last_good_snapshot_during_partial_rewrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            pipeline_root = Path(temporary) / "pipeline"
            data = pipeline_root / "stable-course/course-content/src/data"
            point = _index_point("only-point", "唯一知识点", 0.8)
            _write(data / "course.json", {
                "schema_version": "1.0",
                "id": "stable-course",
                "title": "稳定课程",
            })
            _write(data / "index.json", {
                "schema_version": "course-content-index/1.0",
                "courseId": "stable-course",
                "points": [point],
            })
            _write(data / "points/only-point.json", _complete_point(
                "only-point",
                "唯一知识点",
                0.8,
            ))
            observer = CourseGenerationObserver(pipeline_root, "conversation-stable")
            messages: list[dict] = []

            async def send(message: dict) -> None:
                messages.append(message)

            first = await observer.emit_if_changed(send)
            self.assertEqual(first["gate"], "G3")
            self.assertTrue(first["points"][0]["complete"])

            (data / "points/only-point.json").write_text("{", encoding="utf-8")
            second = await observer.emit_if_changed(send)
            self.assertEqual(second, first)
            self.assertEqual(len(messages), 1)

    async def test_allows_reviewed_index_revision_before_content_starts(self):
        with tempfile.TemporaryDirectory() as temporary:
            pipeline_root = Path(temporary) / "pipeline"
            content = pipeline_root / "review-course/course-content"
            data = content / "src/data"
            _write(data / "course.json", {
                "schema_version": "1.0",
                "id": "review-course",
                "title": "复核课程",
            })

            def write_index(point_id: str, title: str) -> None:
                point = _index_point(point_id, title, 0.8)
                _write(data / "index.json", {
                    "schema_version": "course-content-index/1.0",
                    "courseId": "review-course",
                    "points": [point],
                })
                _write(content / "generation/manifest.json", {
                    "schema_version": "course-content-generation/1.0",
                    "subject": {"id": "review-course"},
                    "generation": {"pointCount": 1},
                    "sources": [],
                    "pointEvidence": [{"pointId": point_id}],
                    "reviewQueue": [],
                })

            write_index("old-point", "旧知识点")
            observer = CourseGenerationObserver(pipeline_root, "conversation-review")
            messages: list[dict] = []

            async def send(message: dict) -> None:
                messages.append(message)

            first = await observer.emit_if_changed(send)
            self.assertEqual(first["gate"], "G2")
            self.assertEqual(first["points"][0]["id"], "old-point")

            write_index("new-point", "复核后的知识点")
            second = await observer.emit_if_changed(send)
            self.assertEqual(second["gate"], "G2")
            self.assertEqual(second["points"][0]["id"], "new-point")
            self.assertEqual(len(messages), 2)

    async def test_polling_task_is_cleanly_cancellable(self):
        with tempfile.TemporaryDirectory() as temporary:
            observer = CourseGenerationObserver(
                Path(temporary) / "pipeline",
                "conversation-3",
                interval_seconds=0.01,
            )
            messages: list[dict] = []

            async def send(message: dict) -> None:
                messages.append(message)

            task = asyncio.create_task(observer.run(send))
            await asyncio.sleep(0.025)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            emitted = len(messages)
            await asyncio.sleep(0.025)
            self.assertEqual(len(messages), emitted)


if __name__ == "__main__":
    unittest.main()
