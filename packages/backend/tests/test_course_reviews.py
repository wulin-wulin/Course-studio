from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import conversations as conversations_api
from src.api import reviews as reviews_api
from src.services.reviews import (
    CourseReviewConflictError,
    CourseReviewStore,
    CourseReviewValidationError,
)


COURSE_ID = "demo-course"
CONVERSATION_ID = "conversation-1"
PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _index_point(point_id: str, title: str, importance: float = 0.8) -> dict:
    return {
        "id": point_id,
        "title": title,
        "shortSummary": (
            f"{title} 是课程中的独立学习单元，用于建立核心概念、适用边界、"
            "实践方法与后续知识之间的清晰联系。"
        ),
        "difficulty": "基础",
        "importance": importance,
        "keyTerms": [title, "课程要点"],
    }


def _point(
    point_id: str,
    title: str,
    *,
    importance: float = 0.8,
    prerequisites: list[str] | None = None,
) -> dict:
    return {
        **_index_point(point_id, title, importance),
        "coreIdea": f"{title} 的核心思想与适用边界。",
        "principles": [f"{title} 原理一", f"{title} 原理二"],
        "applications": [f"{title} 的课程实践"],
        "aliases": [],
        "intuition": f"通过直观案例理解 {title}。",
        "misconceptions": [f"不能把 {title} 与相邻概念混为一谈。"],
        "qa": [
            {"q": f"什么是 {title}？", "a": f"{title} 是本课程的知识单元。"},
            {"q": f"何时使用 {title}？", "a": "在满足适用边界时使用。"},
        ],
        "animationType": "none",
        "prerequisites": list(prerequisites or []),
    }


class ReviewFixture:
    def __init__(self, root: Path):
        self.workspace_root = root / "sessions"
        self.session_root = self.workspace_root / CONVERSATION_ID
        self.course_root = self.session_root / "pipeline" / COURSE_ID
        self.content_root = self.course_root / "course-content"
        self.data_root = self.content_root / "src" / "data"
        self.review_root = self.course_root / "reviews"
        self.approval_root = (
            self.session_root / ".course-review-approvals" / COURSE_ID
        )
        self.resource_root = self.session_root / ".course-reviews" / COURSE_ID
        self.subject = {
            "id": COURSE_ID,
            "input": "Demo Course",
            "normalizedTitle": "Demo Course",
            "inputType": "course",
            "language": "zh-CN",
            "audience": "本科生",
            "depth": "基础课程",
            "scope": "覆盖演示课程的核心概念与实践方法。",
            "exclusions": [],
            "outcomes": ["能够解释并应用课程中的核心概念。"],
        }
        self.index_points = [
            _index_point("alpha", "Alpha", 0.9),
            _index_point("beta", "Beta", 0.8),
            _index_point("gamma", "Gamma", 0.7),
        ]
        self.write_index()

    def write_index(self) -> None:
        _write_json(
            self.data_root / "course.json",
            {
                "schema_version": "1.0",
                "id": COURSE_ID,
                "title": "Demo Course",
                "description": "A complete fixture for structured reviews.",
                "language": "zh-CN",
                "version": "0.1.0",
                "updatedAt": "2026-07-24",
            },
        )
        _write_json(
            self.data_root / "index.json",
            {
                "schema_version": "course-content-index/1.0",
                "courseId": COURSE_ID,
                "points": deepcopy(self.index_points),
            },
        )
        _write_json(
            self.content_root / "generation" / "manifest.json",
            {
                "schema_version": "course-content-generation/1.0",
                "subject": deepcopy(self.subject),
                "generation": {
                    "evidenceMode": "model-only",
                    "generatedAt": "2026-07-24",
                    "pointCount": len(self.index_points),
                },
                "sources": [],
                "pointEvidence": [
                    {
                        "pointId": point["id"],
                        "title": point["title"],
                        "kind": "concept",
                        "sourceRefs": [],
                        "confidence": 0.6,
                        "scopeStatus": "core",
                    }
                    for point in self.index_points
                ],
                "reviewQueue": [],
            },
        )

    def write_marker(self, kind: str) -> None:
        gates = {
            "knowledge-points": "G2_IDENTITY_REVIEW",
            "knowledge-graph": "G6_GRAPH_REVIEW",
        }
        _write_json(
            self.review_root / f"{kind}.request.json",
            {
                "schema_version": "course-review-request/1.0",
                "course_id": COURSE_ID,
                "kind": kind,
                "gate": gates[kind],
                "requested_at": datetime.now(UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
            },
        )

    def write_graph(
        self,
        *,
        prerequisites: dict[str, list[str]] | None = None,
        related: dict[str, list[str]] | None = None,
    ) -> None:
        prerequisites = prerequisites or {}
        related = related or {}
        point_documents: list[dict] = []
        for point in self.index_points:
            document = _point(
                point["id"],
                point["title"],
                importance=point["importance"],
                prerequisites=prerequisites.get(point["id"], []),
            )
            _write_json(
                self.data_root / "points" / f"{point['id']}.json",
                document,
            )
            point_documents.append(document)
            _write_json(
                self.content_root
                / "generation"
                / "animation-requests"
                / f"{point['id']}.json",
                {
                    "schema_version": "animation-request/1.0",
                    "pointId": point["id"],
                    "needed": False,
                    "rationale": (
                        f"{point['title']} 使用静态示例即可解释，"
                        "当前课程不需要独立动画。"
                    ),
                },
            )
        _write_json(
            self.content_root / "generation" / "animation-manifest.json",
            {
                "schema_version": "course-content-animations/1.0",
                "animations": [],
            },
        )
        clusters = [
            {
                "id": "core",
                "title": "核心",
                "subtitle": "核心概念",
                "description": "课程中的核心概念。",
                "order": 0,
            },
            {
                "id": "practice",
                "title": "实践",
                "subtitle": "实践方法",
                "description": "课程中的实践方法。",
                "order": 1,
            },
        ]
        graph_points = []
        for document in point_documents:
            point_id = document["id"]
            graph_points.append({
                **deepcopy(document),
                "clusterIds": ["core"],
                "role": "trunk",
                "related": list(related.get(point_id, [])),
            })
        _write_json(
            self.course_root / "clustered-graph.json",
            {
                "schema_version": "clustered-graph/2.0",
                "subject": deepcopy(self.subject),
                "generation": {
                    "generatedAt": "2026-07-24",
                    "sourceCourseId": COURSE_ID,
                    "pointCount": len(graph_points),
                    "clusterCount": len(clusters),
                    "brokenCycleEdges": [],
                    "refinedPrerequisiteEdges": [],
                },
                "clusters": clusters,
                "sequences": {
                    "cluster": [{"fromId": "core", "toId": "practice"}],
                    "point": [
                        {"fromId": "alpha", "toId": "beta"},
                        {"fromId": "beta", "toId": "gamma"},
                    ],
                },
                "points": graph_points,
            },
        )
        self.write_marker("knowledge-graph")

    def build_animation_registry(self) -> None:
        completed = subprocess.run(
            [
                "node",
                str(
                    PROJECT_ROOT
                    / "skills"
                    / "candidate-knowledge-point-generator"
                    / "scripts"
                    / "build_animation_registry.mjs"
                ),
                "--root",
                str(self.content_root),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        if completed.returncode != 0:
            raise AssertionError(completed.stderr or completed.stdout)


class CourseReviewStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = ReviewFixture(Path(self.temporary.name))
        self.store = CourseReviewStore(
            self.fixture.workspace_root,
            PROJECT_ROOT,
        )
        self.store._run_validator = Mock()

    def pending(self, kind: str) -> dict:
        self.fixture.write_marker(kind)
        resources = self.store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual(len(resources), 1)
        return resources[0]

    def submit(self, resource: dict, operations: list[dict]) -> dict:
        return self.store.submit(
            resource["id"],
            conversation_id=CONVERSATION_ID,
            revision=resource["revision"],
            artifact_hash=resource["artifact_hash"],
            operations=operations,
        )

    def approve_identity(self) -> None:
        resource = self.pending("knowledge-points")
        result = self.submit(resource, [])
        self.store.consume_resume(
            result["review"]["id"],
            conversation_id=CONVERSATION_ID,
        )

    def pending_graph(
        self,
        *,
        prerequisites: dict[str, list[str]] | None = None,
        related: dict[str, list[str]] | None = None,
    ) -> dict:
        self.approve_identity()
        self.fixture.write_graph(
            prerequisites=prerequisites,
            related=related,
        )
        resources = self.store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual(len(resources), 1)
        return resources[0]

    def write_textbook_outline(self) -> None:
        _write_json(
            self.fixture.course_root / "textbook-outline.json",
            {
                "schema_version": "textbook-outline/1.0",
                "document_id": "doc-1234567890abcdef12345678",
                "title": "教材课程",
                "course": {"id": COURSE_ID, "title": "Demo Course"},
                "source": {"sha256": "f" * 64},
                "chapters": [
                    {
                        "id": "chapter-one",
                        "title": "第一章",
                        "order": 0,
                        "points": [
                            {"id": "alpha", "title": "Alpha", "origin": "textbook", "order": 0},
                            {"id": "beta", "title": "Beta", "origin": "textbook", "order": 1},
                        ],
                    },
                    {
                        "id": "chapter-two",
                        "title": "第二章",
                        "order": 1,
                        "points": [
                            {"id": "gamma", "title": "Gamma", "origin": "textbook", "order": 0},
                        ],
                    },
                ],
            },
        )

    def write_textbook_graph(self, *, wrong_point_id: str | None = None) -> None:
        """Write a graph whose clusters mirror the bound textbook chapters.

        ``ReviewFixture.write_graph`` intentionally creates the generic
        non-textbook graph used by the rest of this module.  Textbook review
        tests need the chapter IDs/titles in the graph before they can test a
        point-to-chapter mismatch.
        """

        self.fixture.write_graph()
        graph_path = self.fixture.course_root / "clustered-graph.json"
        graph = _read_json(graph_path)
        graph["clusters"] = [
            {
                "id": "chapter-one",
                "title": "第一章",
                "subtitle": "第一章知识点",
                "description": "教材第一章知识点。",
                "order": 0,
            },
            {
                "id": "chapter-two",
                "title": "第二章",
                "subtitle": "第二章知识点",
                "description": "教材第二章知识点。",
                "order": 1,
            },
        ]
        graph["sequences"] = {
            "cluster": [{"fromId": "chapter-one", "toId": "chapter-two"}],
            "point": [
                {"fromId": "alpha", "toId": "beta"},
                {"fromId": "beta", "toId": "gamma"},
            ],
        }
        expected_cluster = {
            "alpha": "chapter-one",
            "beta": "chapter-one",
            "gamma": "chapter-two",
        }
        for point in graph["points"]:
            point["clusterIds"] = [expected_cluster[point["id"]]]
        if wrong_point_id is not None:
            point = next(
                point for point in graph["points"] if point["id"] == wrong_point_id
            )
            point["clusterIds"] = [
                "chapter-two"
                if expected_cluster[wrong_point_id] == "chapter-one"
                else "chapter-one"
            ]
        _write_json(graph_path, graph)

    def test_textbook_g2_exposes_tree_and_invalidates_approval_on_structure_change(self):
        self.write_textbook_outline()
        resource = self.pending("knowledge-points")
        self.assertEqual(resource["textbook_outline"]["chapters"][0]["title"], "第一章")
        self.assertEqual(
            [point["id"] for point in resource["textbook_outline"]["chapters"][0]["points"]],
            ["alpha", "beta"],
        )
        self.assertRegex(resource["textbook_structure_sha256"], r"^[a-f0-9]{64}$")
        original_hash = resource["artifact_hash"]
        submitted = self.submit(resource, [])
        self.assertEqual(submitted["review"]["status"], "resolved")

        outline_path = self.fixture.course_root / "textbook-outline.json"
        outline = _read_json(outline_path)
        # Keep the flattened index identity unchanged while changing chapter
        # metadata.  This isolates the chapter-assignment hash contract.
        outline["chapters"][1]["title"] = "第二章（修订版）"
        _write_json(outline_path, outline)
        refreshed = self.store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual(len(refreshed), 1)
        self.assertEqual(refreshed[0]["status"], "pending")
        self.assertNotEqual(refreshed[0]["artifact_hash"], original_hash)
        self.assertNotEqual(refreshed[0]["id"], submitted["review"]["id"])

    def test_textbook_g2_rejects_mutations_without_chapter_aware_operations(self):
        self.write_textbook_outline()
        resource = self.pending("knowledge-points")
        with self.assertRaises(CourseReviewValidationError):
            self.submit(resource, [{"op": "delete", "point_id": "alpha"}])

    def test_textbook_g2_zero_modification_still_resolves(self):
        self.write_textbook_outline()
        resource = self.pending("knowledge-points")

        result = self.submit(resource, [])

        self.assertEqual(result["review"]["status"], "resolved")
        self.assertEqual(result["review"]["submitted_operations"], [])
        approval = _read_json(
            self.fixture.approval_root / "knowledge-points.json"
        )
        self.assertEqual(
            approval["textbook_structure_sha256"],
            resource["textbook_structure_sha256"],
        )

    def test_textbook_g2_rejects_outline_index_identity_mismatch(self):
        self.write_textbook_outline()
        index_path = self.fixture.data_root / "index.json"
        index = _read_json(index_path)
        index["points"][1]["title"] = "Beta（索引标题不一致）"
        _write_json(index_path, index)
        self.fixture.write_marker("knowledge-points")

        with self.assertRaisesRegex(
            CourseReviewValidationError,
            "教材结构与课程索引的知识点 ID、标题或顺序不一致",
        ):
            self.store.pending_for_conversation(CONVERSATION_ID)

    def test_textbook_review_rejects_sidecar_mutation_against_input_snapshot(self):
        self.write_textbook_outline()
        outline_path = self.fixture.course_root / "textbook-outline.json"
        outline = _read_json(outline_path)
        input_path = (
            self.fixture.session_root
            / "textbook-input"
            / outline["document_id"]
            / "outline.json"
        )
        _write_json(input_path, deepcopy(outline))

        outline["chapters"][0]["points"][0]["origin"] = "llm-extension"
        outline["chapters"][0]["points"][0]["anchor_point_id"] = "beta"
        outline["chapters"][0]["points"][0]["extension_reason"] = "伪造来源"
        _write_json(outline_path, outline)
        self.fixture.write_marker("knowledge-points")

        with self.assertRaisesRegex(
            CourseReviewValidationError,
            "教材原始结构不可变校验失败",
        ):
            self.store.pending_for_conversation(CONVERSATION_ID)

    def test_textbook_review_rejects_missing_sidecar_when_binding_exists(self):
        self.write_textbook_outline()
        outline_path = self.fixture.course_root / "textbook-outline.json"
        outline = _read_json(outline_path)
        _write_json(
            self.fixture.session_root / "textbook-binding.json",
            {
                "schema_version": "textbook-binding/1.0",
                "document_id": outline["document_id"],
                "course_id": COURSE_ID,
                "output_outline_path": f"pipeline/{COURSE_ID}/textbook-outline.json",
            },
        )
        outline_path.unlink()
        self.fixture.write_marker("knowledge-points")

        with self.assertRaisesRegex(
            CourseReviewValidationError,
            "缺少教材工作流结构",
        ):
            self.store.pending_for_conversation(CONVERSATION_ID)

    def test_textbook_graph_rejects_point_mapped_to_wrong_chapter(self):
        self.write_textbook_outline()
        self.approve_identity()
        self.write_textbook_graph(wrong_point_id="gamma")

        with self.assertRaisesRegex(
            CourseReviewValidationError,
            "知识点 gamma 的主知识簇不是其教材章节",
        ):
            self.store.pending_for_conversation(CONVERSATION_ID)

    def test_textbook_graph_with_chapter_mapping_generates_resource(self):
        self.write_textbook_outline()
        self.approve_identity()
        self.write_textbook_graph()

        resources = self.store.pending_for_conversation(CONVERSATION_ID)

        self.assertEqual(len(resources), 1)
        self.assertEqual(resources[0]["kind"], "knowledge-graph")
        self.assertEqual(
            [cluster["id"] for cluster in resources[0]["clusters"]],
            ["chapter-one", "chapter-two"],
        )

    def test_knowledge_review_add_delete_signs_revision_hash_and_operations(self):
        resource = self.pending("knowledge-points")
        operations = [
            {"op": "delete", "point_id": "beta"},
            {"op": "add", "point": {"id": "delta", "title": "Delta"}},
        ]

        result = self.submit(resource, operations)

        index = _read_json(self.fixture.data_root / "index.json")
        self.assertEqual(
            [point["id"] for point in index["points"]],
            ["alpha", "gamma", "delta"],
        )
        approval = _read_json(
            self.fixture.approval_root / "knowledge-points.json"
        )
        self.assertEqual(approval["source_revision"], resource["revision"])
        self.assertEqual(
            approval["source_artifact_hash"],
            resource["artifact_hash"],
        )
        self.assertEqual(approval["submitted_operations"], operations)
        self.assertRegex(approval["identity_sha256"], r"^[a-f0-9]{64}$")
        self.assertTrue(result["review"]["resume_pending"])

    def test_stale_revision_and_artifact_are_rejected(self):
        resource = self.pending("knowledge-points")
        with self.assertRaises(CourseReviewConflictError):
            self.store.submit(
                resource["id"],
                conversation_id=CONVERSATION_ID,
                revision=resource["revision"] + 1,
                artifact_hash=resource["artifact_hash"],
                operations=[],
            )
        with self.assertRaises(CourseReviewConflictError):
            self.store.submit(
                resource["id"],
                conversation_id=CONVERSATION_ID,
                revision=resource["revision"],
                artifact_hash="0" * 64,
                operations=[],
            )

    def test_graph_resource_and_operations_update_clusters_and_prerequisites(self):
        resource = self.pending_graph(
            prerequisites={"beta": ["alpha"]},
        )
        self.assertEqual(resource["kind"], "knowledge-graph")
        self.assertEqual(resource["gate"], "G6_GRAPH_REVIEW")
        self.assertEqual(len(resource["clusters"]), 2)
        alpha = next(point for point in resource["points"] if point["id"] == "alpha")
        self.assertEqual(alpha["clusterIds"], ["core"])
        self.assertIn("prerequisites", alpha)
        self.assertIn("related", alpha)
        self.assertEqual(
            resource["sequences"]["cluster"],
            [{"fromId": "core", "toId": "practice"}],
        )
        operations = [
            {
                "op": "set-clusters",
                "point_id": "gamma",
                "cluster_ids": ["practice", "core"],
            },
            {
                "op": "remove-prerequisite",
                "point_id": "beta",
                "prerequisite_id": "alpha",
                "reason": "Beta 不再要求先掌握 Alpha。",
            },
            {
                "op": "add-prerequisite",
                "point_id": "gamma",
                "prerequisite_id": "beta",
                "reason": "Gamma 建立在 Beta 之上。",
            },
        ]

        result = self.submit(resource, operations)

        graph = _read_json(self.fixture.course_root / "clustered-graph.json")
        points = {point["id"]: point for point in graph["points"]}
        self.assertEqual(points["gamma"]["clusterIds"], ["practice", "core"])
        self.assertEqual(points["beta"]["prerequisites"], [])
        self.assertEqual(points["gamma"]["prerequisites"], ["beta"])
        self.assertEqual(
            graph["generation"]["refinedPrerequisiteEdges"],
            [
                {
                    "op": "remove",
                    "from": "beta",
                    "to": "alpha",
                    "reason": "Beta 不再要求先掌握 Alpha。",
                },
                {
                    "op": "add",
                    "from": "gamma",
                    "to": "beta",
                    "reason": "Gamma 建立在 Beta 之上。",
                },
            ],
        )
        approval = _read_json(
            self.fixture.approval_root / "knowledge-graph.json"
        )
        for key in (
            "clusters_sha256",
            "prerequisites_sha256",
            "review_audit_sha256",
        ):
            self.assertRegex(approval[key], r"^[a-f0-9]{64}$")
            self.assertEqual(approval[key], result["review"][key])
        self.assertEqual(approval["submitted_operations"], operations)

    def test_sequence_change_invalidates_resolved_graph_approval(self):
        resource = self.pending_graph(prerequisites={"beta": ["alpha"]})
        result = self.submit(resource, [])
        approved_hash = result["review"]["clusters_sha256"]

        graph_path = self.fixture.course_root / "clustered-graph.json"
        graph = _read_json(graph_path)
        graph["sequences"]["point"] = [
            {"fromId": "alpha", "toId": "gamma"},
        ]
        _write_json(graph_path, graph)

        refreshed = self.store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual(len(refreshed), 1)
        self.assertEqual(refreshed[0]["status"], "pending")
        self.assertNotEqual(refreshed[0]["clusters_sha256"], approved_hash)

    def test_related_is_read_only_and_mutually_exclusive_with_prerequisite(self):
        resource = self.pending_graph(
            related={"alpha": ["gamma"], "gamma": ["alpha"]},
        )
        graph_path = self.fixture.course_root / "clustered-graph.json"
        original = graph_path.read_bytes()

        with self.assertRaises(CourseReviewValidationError):
            self.submit(
                resource,
                [{
                    "op": "add-prerequisite",
                    "point_id": "gamma",
                    "prerequisite_id": "alpha",
                    "reason": "这会与只读 related 冲突。",
                }],
            )
        with self.assertRaises(CourseReviewValidationError):
            self.submit(
                resource,
                [{
                    "op": "set-related",
                    "point_id": "gamma",
                    "related": [],
                }],
            )
        self.assertEqual(graph_path.read_bytes(), original)

    def test_graph_snapshot_rejects_asymmetric_related(self):
        self.approve_identity()
        self.fixture.write_graph(related={"alpha": ["gamma"]})

        with self.assertRaisesRegex(
            CourseReviewValidationError,
            "related 必须双向声明",
        ):
            self.store.pending_for_conversation(CONVERSATION_ID)

    def test_graph_snapshot_rejects_related_prerequisite_conflict(self):
        self.approve_identity()
        self.fixture.write_graph(
            prerequisites={"gamma": ["alpha"]},
            related={"alpha": ["gamma"], "gamma": ["alpha"]},
        )

        with self.assertRaisesRegex(
            CourseReviewValidationError,
            "同时存在 related 和 prerequisite",
        ):
            self.store.pending_for_conversation(CONVERSATION_ID)

    def test_graph_cycle_and_unknown_cluster_are_rejected(self):
        resource = self.pending_graph(
            prerequisites={"beta": ["alpha"]},
        )
        invalid_operations = [
            [{
                "op": "add-prerequisite",
                "point_id": "alpha",
                "prerequisite_id": "beta",
                "reason": "形成环。",
            }],
            [{
                "op": "set-clusters",
                "point_id": "alpha",
                "cluster_ids": ["missing"],
            }],
            [{
                "op": "add-prerequisite",
                "point_id": "gamma",
                "prerequisite_id": "beta",
                "reason": "",
            }],
        ]
        graph_path = self.fixture.course_root / "clustered-graph.json"
        original = graph_path.read_bytes()

        for operations in invalid_operations:
            with self.subTest(operations=operations):
                with self.assertRaises(CourseReviewValidationError):
                    self.submit(resource, operations)
                self.assertEqual(graph_path.read_bytes(), original)

    def test_validator_failure_rolls_back_graph_approval_and_resource(self):
        resource = self.pending_graph()
        tracked = [
            self.fixture.course_root / "clustered-graph.json",
            self.fixture.approval_root / "knowledge-graph.json",
            self.fixture.resource_root / "knowledge-graph.json",
        ]
        originals = {
            path: path.read_bytes() if path.exists() else None
            for path in tracked
        }
        self.store._run_validator = Mock(
            side_effect=CourseReviewValidationError("forced validator failure")
        )

        with self.assertRaises(CourseReviewValidationError):
            self.submit(
                resource,
                [{
                    "op": "set-clusters",
                    "point_id": "alpha",
                    "cluster_ids": ["practice"],
                }],
            )

        for path, original in originals.items():
            self.assertEqual(
                path.read_bytes() if path.exists() else None,
                original,
            )

    def test_graph_submission_passes_real_pipeline_validators(self):
        self.approve_identity()
        self.fixture.write_graph()
        self.fixture.build_animation_registry()
        resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        self.store._run_validator = CourseReviewStore._run_validator.__get__(
            self.store
        )

        result = self.submit(
            resource,
            [{
                "op": "set-clusters",
                "point_id": "gamma",
                "cluster_ids": ["practice"],
            }],
        )

        self.assertEqual(result["review"]["status"], "resolved")

    def test_resume_claim_is_exclusive_expirable_and_persistent(self):
        resource = self.pending("knowledge-points")
        review_id = self.submit(resource, [])["review"]["id"]
        first = self.store.claim_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="claim-one",
        )
        self.assertEqual(first["review"]["resume_claim_id"], "claim-one")
        with self.assertRaises(CourseReviewConflictError):
            self.store.claim_resume(
                review_id,
                conversation_id=CONVERSATION_ID,
                claim_id="claim-two",
            )
        for path in (
            self.fixture.approval_root / "knowledge-points.json",
            self.fixture.resource_root / "knowledge-points.json",
        ):
            document = _read_json(path)
            document["resume_claimed_at"] = "2000-01-01T00:00:00.000Z"
            _write_json(path, document)

        second = self.store.claim_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="claim-two",
        )
        self.assertEqual(second["review"]["resume_claim_id"], "claim-two")
        completed = self.store.complete_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="claim-two",
        )
        self.assertFalse(completed["review"]["resume_pending"])
        self.assertIsNone(
            self.store.resume_pending_for_conversation(CONVERSATION_ID)
        )

    def test_identity_approval_keeps_id_across_content_sync(self):
        resource = self.pending("knowledge-points")
        review_id = self.submit(resource, [])["review"]["id"]
        claimed = self.store.claim_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="claim-one",
        )
        original_artifact_hash = claimed["review"]["artifact_hash"]

        index_path = self.fixture.data_root / "index.json"
        index = _read_json(index_path)
        index["points"][0]["shortSummary"] = (
            "Alpha 正文生成完成后同步的新摘要，只改变展示内容，不改变知识点身份。"
        )
        index["points"][0]["keyTerms"] = ["Alpha", "同步后的术语"]
        _write_json(index_path, index)

        self.assertEqual(
            self.store.pending_for_conversation(CONVERSATION_ID),
            [],
        )
        refreshed = _read_json(
            self.fixture.resource_root / "knowledge-points.json"
        )
        self.assertEqual(refreshed["id"], review_id)
        self.assertNotEqual(refreshed["artifact_hash"], original_artifact_hash)

        # Older builds could leave an approved marker under a newly generated
        # resource ID while the approval still referenced the original ID.
        # A read must repair that split identity before the resume heartbeat.
        refreshed["id"] = "00000000-0000-4000-8000-000000000001"
        _write_json(
            self.fixture.resource_root / "knowledge-points.json",
            refreshed,
        )
        self.assertEqual(
            self.store.pending_for_conversation(CONVERSATION_ID),
            [],
        )
        healed = _read_json(
            self.fixture.resource_root / "knowledge-points.json"
        )
        self.assertEqual(healed["id"], review_id)

        renewed = self.store.renew_resume_claim(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="claim-one",
        )
        self.assertEqual(renewed["review"]["id"], review_id)
        self.assertEqual(renewed["review"]["resume_claim_id"], "claim-one")

        index = _read_json(index_path)
        index["points"][0]["title"] = "Alpha Revised"
        _write_json(index_path, index)
        manifest_path = self.fixture.content_root / "generation" / "manifest.json"
        manifest = _read_json(manifest_path)
        manifest["pointEvidence"][0]["title"] = "Alpha Revised"
        _write_json(manifest_path, manifest)

        pending = self.store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["status"], "pending")
        self.assertNotEqual(pending[0]["id"], review_id)

    def test_g6_submission_completes_and_supersedes_stale_g2_resume(self):
        identity = self.pending("knowledge-points")
        submitted = self.submit(identity, [])
        self.assertEqual(
            self.store.resume_pending_for_conversation(CONVERSATION_ID)["id"],
            submitted["review"]["id"],
        )

        self.fixture.write_graph()
        graph = self.store.pending_for_conversation(CONVERSATION_ID)[0]

        self.assertEqual(graph["kind"], "knowledge-graph")
        self.assertIsNone(
            self.store.resume_pending_for_conversation(CONVERSATION_ID)
        )

        resolved = self.submit(graph, [])

        self.assertEqual(resolved["review"]["status"], "resolved")
        for path in (
            self.fixture.approval_root / "knowledge-points.json",
            self.fixture.resource_root / "knowledge-points.json",
        ):
            document = _read_json(path)
            self.assertFalse(document["resume_pending"])
            self.assertEqual(
                document["resume_completed_by"],
                "knowledge-graph-successor",
            )
            self.assertNotIn("resume_claim_id", document)
            self.assertNotIn("resume_claimed_at", document)


class CourseReviewApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = ReviewFixture(Path(self.temporary.name))
        self.fixture.write_marker("knowledge-points")
        self.store = CourseReviewStore(
            self.fixture.workspace_root,
            PROJECT_ROOT,
        )
        self.store._run_validator = Mock()
        app = FastAPI()
        app.include_router(reviews_api.router, prefix="/api/agent/reviews")
        self.client = TestClient(app)
        self.store_patch = patch.object(
            reviews_api,
            "get_course_review_store",
            return_value=self.store,
        )
        self.store_patch.start()
        self.addCleanup(self.store_patch.stop)

    def test_pending_get_submit_resume_and_claim_contract(self):
        pending_response = self.client.get(
            "/api/agent/reviews/pending",
            params={"conversation_id": CONVERSATION_ID},
        )
        self.assertEqual(pending_response.status_code, 200)
        pointer = pending_response.json()["pending_review"]
        self.assertEqual(pointer["kind"], "knowledge-points")

        detail_response = self.client.get(
            f"/api/agent/reviews/{pointer['id']}"
        )
        self.assertEqual(detail_response.status_code, 200)
        detail = detail_response.json()
        submit_response = self.client.post(
            f"/api/agent/reviews/{pointer['id']}/submit",
            json={
                "conversation_id": CONVERSATION_ID,
                "revision": detail["revision"],
                "artifact_hash": detail["artifact_hash"],
                "operations": [],
            },
        )
        self.assertEqual(submit_response.status_code, 200)

        resume_response = self.client.get(
            f"/api/agent/reviews/{pointer['id']}/resume",
            params={"conversation_id": CONVERSATION_ID},
        )
        self.assertEqual(resume_response.status_code, 200)
        claim_response = self.client.post(
            f"/api/agent/reviews/{pointer['id']}/resume/claim",
            json={
                "conversation_id": CONVERSATION_ID,
                "claim_id": "api-claim",
            },
        )
        self.assertEqual(claim_response.status_code, 200)
        complete_response = self.client.post(
            f"/api/agent/reviews/{pointer['id']}/resume/complete",
            json={
                "conversation_id": CONVERSATION_ID,
                "claim_id": "api-claim",
            },
        )
        self.assertEqual(complete_response.status_code, 200)
        self.assertFalse(
            complete_response.json()["review"]["resume_pending"]
        )

    def test_submit_rejects_stale_revision(self):
        detail = self.client.get(
            "/api/agent/reviews",
            params={"conversation_id": CONVERSATION_ID},
        ).json()["pending_review"]
        response = self.client.post(
            f"/api/agent/reviews/{detail['id']}/submit",
            json={
                "conversation_id": CONVERSATION_ID,
                "revision": detail["revision"] + 1,
                "artifact_hash": detail["artifact_hash"],
                "operations": [],
            },
        )
        self.assertEqual(response.status_code, 409)


class ConversationReviewPointerApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = ReviewFixture(Path(self.temporary.name))
        self.fixture.write_marker("knowledge-points")
        self.review_store = CourseReviewStore(
            self.fixture.workspace_root,
            PROJECT_ROOT,
        )
        self.review_store._run_validator = Mock()
        self.conversation_store = Mock()
        self.conversation_store.get_conversation.return_value = {
            "id": CONVERSATION_ID,
            "mode": "agent",
            "workflow": "course-create",
            "messages": [],
            "opencode_session_id": "must-not-leak",
        }
        app = FastAPI()
        app.include_router(
            conversations_api.router,
            prefix="/api/conversations",
        )
        self.client = TestClient(app)
        self.review_patch = patch.object(
            conversations_api,
            "get_course_review_store",
            return_value=self.review_store,
        )
        self.conversation_patch = patch.object(
            conversations_api,
            "get_conversation_store",
            return_value=self.conversation_store,
        )
        self.review_patch.start()
        self.conversation_patch.start()
        self.addCleanup(self.review_patch.stop)
        self.addCleanup(self.conversation_patch.stop)

    def test_conversation_prioritizes_resume_pointer_over_pending_gate(self):
        pending = self.review_store.pending_for_conversation(
            CONVERSATION_ID
        )[0]
        before = self.client.get(
            f"/api/conversations/{CONVERSATION_ID}"
        )
        self.assertEqual(before.status_code, 200)
        self.assertEqual(
            before.json()["pending_review"]["id"],
            pending["id"],
        )
        self.assertNotIn("opencode_session_id", before.json())

        submitted = self.review_store.submit(
            pending["id"],
            conversation_id=CONVERSATION_ID,
            revision=pending["revision"],
            artifact_hash=pending["artifact_hash"],
            operations=[],
        )
        after = self.client.get(
            f"/api/conversations/{CONVERSATION_ID}"
        )
        self.assertEqual(after.status_code, 200)
        self.assertIsNone(after.json()["pending_review"])
        self.assertEqual(
            after.json()["pending_review_resume"]["id"],
            submitted["review"]["id"],
        )

        self.fixture.write_graph()
        with_successor = self.client.get(
            f"/api/conversations/{CONVERSATION_ID}"
        )
        self.assertEqual(with_successor.status_code, 200)
        self.assertEqual(
            with_successor.json()["pending_review"]["kind"],
            "knowledge-graph",
        )
        self.assertIsNone(with_successor.json()["pending_review_resume"])


if __name__ == "__main__":
    unittest.main()
