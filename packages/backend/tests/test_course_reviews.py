from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import agent as agent_api
from src.api import conversations as conversations_api
from src.api import reviews as reviews_api
from src.services.conversations.store import ConversationStore
from src.services.reviews import store as review_store_module
from src.services.reviews.store import (
    CourseReviewConflictError,
    CourseReviewStore,
    CourseReviewUnsafePathError,
    CourseReviewValidationError,
)


COURSE_ID = "demo-course"
CONVERSATION_ID = "conversation-1"
PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _sha256(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _index_point(point_id: str, title: str) -> dict:
    return {
        "id": point_id,
        "title": title,
        "shortSummary": (
            f"{title} 是课程中的独立学习单元，用于建立核心概念、适用边界、"
            "实践方法与后续知识之间的清晰联系。"
        ),
        "difficulty": "基础",
        "importance": 0.8,
        "keyTerms": [title, "课程要点"],
    }


def _graph_point(
    point_id: str,
    title: str,
    *,
    prerequisites: list[str] | None = None,
    related: list[str] | None = None,
) -> dict:
    return {
        **_index_point(point_id, title),
        "prerequisites": prerequisites or [],
        "clusterIds": ["core"],
        "role": "trunk",
        "related": related or [],
    }


class ReviewFixture:
    def __init__(self, root: Path):
        self.workspace_root = root / "sessions"
        self.session_root = self.workspace_root / CONVERSATION_ID
        self.content_root = self.session_root / "pipeline" / COURSE_ID / "course-content"
        self.data_root = self.content_root / "src" / "data"
        self.course_root = self.session_root / "pipeline" / COURSE_ID
        self.review_root = self.course_root / "reviews"
        self.approval_root = self.session_root / ".course-review-approvals" / COURSE_ID
        self.resource_root = self.session_root / ".course-reviews" / COURSE_ID
        self.points = [
            _index_point("alpha", "Alpha"),
            _index_point("beta", "Beta"),
            _index_point("gamma", "Gamma"),
        ]

    def write_index(self) -> None:
        _write_json(
            self.data_root / "course.json",
            {
                "schema_version": "1.0",
                "id": COURSE_ID,
                "title": "Demo Course",
                "description": "A complete fixture for structured course reviews.",
                "language": "zh-CN",
                "version": "0.1.0",
                "updatedAt": "2026-07-23",
            },
        )
        _write_json(
            self.data_root / "index.json",
            {
                "schema_version": "course-content-index/1.0",
                "courseId": COURSE_ID,
                "points": self.points,
            },
        )
        _write_json(
            self.content_root / "generation" / "manifest.json",
            {
                "schema_version": "course-content-generation/1.0",
                "subject": {
                    "id": COURSE_ID,
                    "input": "Demo Course",
                    "normalizedTitle": "Demo Course",
                    "inputType": "course",
                    "language": "zh-CN",
                    "audience": "本科生",
                    "depth": "一学期课程中的基础单元",
                    "scope": "覆盖演示课程的核心概念与实践方法。",
                    "exclusions": [],
                    "outcomes": ["能够解释并应用课程中的核心概念。"],
                },
                "generation": {
                    "evidenceMode": "model-only",
                    "generatedAt": "2026-07-23",
                    "pointCount": len(self.points),
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
                    for point in self.points
                ],
                "reviewQueue": [],
            },
        )

    def write_marker(self, kind: str) -> None:
        gate = "G2_IDENTITY_REVIEW" if kind == "knowledge-points" else "G6_PREREQUISITE_REVIEW"
        _write_json(
            self.review_root / f"{kind}.request.json",
            {
                "schema_version": "course-review-request/1.0",
                "course_id": COURSE_ID,
                "kind": kind,
                "gate": gate,
                "requested_at": "2026-07-23T00:00:00.000Z",
            },
        )

    def approve_identity(self, *, resume_pending: bool = False) -> None:
        identity = [[point["id"], point["title"]] for point in self.points]
        _write_json(
            self.approval_root / "knowledge-points.json",
            {
                "schema_version": "course-review-approval/1.0",
                "review_id": "knowledge-review",
                "course_id": COURSE_ID,
                "kind": "knowledge-points",
                "gate": "G2_IDENTITY_REVIEW",
                "identity_sha256": _sha256(identity),
                "approved_at": "2026-07-23T00:00:00.000Z",
                "operation_count": 0,
                "submitted_operations": [],
                "resume_pending": resume_pending,
            },
        )

    def write_graph(
        self,
        *,
        source_edges: dict[str, list[str]] | None = None,
        graph_edges: dict[str, list[str]] | None = None,
        related: dict[str, list[str]] | None = None,
        refinements: list[dict] | None = None,
        identity_resume_pending: bool | None = False,
    ) -> None:
        source_edges = source_edges or {}
        graph_edges = graph_edges or source_edges
        related = related or {}
        if identity_resume_pending is not None:
            self.approve_identity(resume_pending=identity_resume_pending)
        for point in self.points:
            point_id = point["id"]
            _write_json(
                self.data_root / "points" / f"{point_id}.json",
                {
                    **point,
                    "prerequisites": list(source_edges.get(point_id, [])),
                },
            )
        graph_points = [
            _graph_point(
                point["id"],
                point["title"],
                prerequisites=list(graph_edges.get(point["id"], [])),
                related=list(related.get(point["id"], [])),
            )
            for point in self.points
        ]
        _write_json(
            self.course_root / "clustered-graph.json",
            {
                "schema_version": "clustered-graph/2.0",
                "subject": {"id": COURSE_ID, "title": "Demo Course"},
                "generation": {
                    "generatedAt": "2026-07-23",
                    "sourceCourseId": COURSE_ID,
                    "pointCount": len(graph_points),
                    "clusterCount": 1,
                    "brokenCycleEdges": [],
                    "refinedPrerequisiteEdges": refinements or [],
                },
                "clusters": [{"id": "core", "title": "Core"}],
                "points": graph_points,
            },
        )
        self.write_marker("prerequisites")


class CourseReviewStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = ReviewFixture(Path(self.temporary.name))
        self.fixture.write_index()
        self.store = CourseReviewStore(self.fixture.workspace_root, PROJECT_ROOT)
        self.store._run_validator = Mock()

    def pending(self, kind: str = "knowledge-points") -> dict:
        self.fixture.write_marker(kind)
        resources = self.store.pending_for_conversation(CONVERSATION_ID)
        return next(resource for resource in resources if resource["kind"] == kind)

    def submit(self, resource: dict, operations: list[dict]) -> dict:
        return self.store.submit(
            resource["id"],
            conversation_id=CONVERSATION_ID,
            revision=resource["revision"],
            artifact_hash=resource["artifact_hash"],
            operations=operations,
        )

    def test_knowledge_review_only_adds_and_deletes_and_writes_receipt(self):
        resource = self.pending()
        operations = [
            {"op": "delete", "point_id": "beta"},
            {"op": "add", "point": {"id": "delta", "title": "Delta"}},
        ]

        result = self.submit(resource, operations)

        index = json.loads((self.fixture.data_root / "index.json").read_text(encoding="utf-8"))
        self.assertEqual([point["id"] for point in index["points"]], ["alpha", "gamma", "delta"])
        manifest = json.loads(
            (self.fixture.content_root / "generation" / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(manifest["generation"]["pointCount"], 3)
        self.assertEqual([item["pointId"] for item in manifest["pointEvidence"]], ["alpha", "gamma", "delta"])
        approval = json.loads(
            (self.fixture.approval_root / "knowledge-points.json").read_text(encoding="utf-8")
        )
        self.assertEqual(approval["schema_version"], "course-review-approval/1.0")
        self.assertEqual(approval["submitted_operations"], operations)
        self.assertEqual(result["review"]["status"], "resolved")
        self.assertEqual(result["review"]["submitted_operations"], operations)

    def test_knowledge_review_rejects_rename_merge_and_extra_fields(self):
        resource = self.pending()
        invalid_operations = [
            [{"op": "rename", "point_id": "alpha", "title": "Renamed"}],
            [{"op": "merge", "point_ids": ["alpha", "beta"], "title": "Merged"}],
            [{"op": "add", "point": {"id": "delta", "title": "Delta", "after": "alpha"}}],
        ]
        original = (self.fixture.data_root / "index.json").read_bytes()

        for operations in invalid_operations:
            with self.subTest(operations=operations):
                with self.assertRaises(CourseReviewValidationError):
                    self.submit(resource, operations)
                self.assertEqual((self.fixture.data_root / "index.json").read_bytes(), original)

    def test_stale_revision_and_hash_are_rejected(self):
        resource = self.pending()
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

    def test_malformed_matching_approval_remains_pending(self):
        identity = [[point["id"], point["title"]] for point in self.fixture.points]
        _write_json(
            self.fixture.approval_root / "knowledge-points.json",
            {
                "schema_version": "course-review-approval/1.0",
                "review_id": "malformed-review",
                "course_id": COURSE_ID,
                "kind": "knowledge-points",
                "gate": "G2_IDENTITY_REVIEW",
                "identity_sha256": _sha256(identity),
                "approved_at": "2026-07-23T00:00:00.000Z",
                # operation_count is required by the release validator.
            },
        )

        resource = self.pending()

        self.assertEqual(resource["status"], "pending")

    def test_earlier_identity_gate_is_returned_before_stale_prerequisite_marker(self):
        self.fixture.write_marker("knowledge-points")
        self.fixture.write_graph(source_edges={"beta": ["alpha"]})
        (self.fixture.approval_root / "knowledge-points.json").unlink()

        resources = self.store.pending_for_conversation(CONVERSATION_ID)

        self.assertEqual(len(resources), 1)
        self.assertEqual(resources[0]["kind"], "knowledge-points")

    def test_researched_addition_uses_an_explicit_user_review_source(self):
        manifest_path = self.fixture.content_root / "generation" / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["generation"]["evidenceMode"] = "researched"
        manifest["sources"] = [
            {
                "id": "src-course-guide",
                "type": "curriculum",
                "title": "Course guide",
                "locator": "https://example.edu/course-guide",
                "accessedAt": "2026-07-23",
            },
            {
                "id": "src-textbook",
                "type": "textbook",
                "title": "Course textbook",
                "locator": "https://example.edu/textbook",
                "accessedAt": "2026-07-23",
            },
            {
                "id": "src-handbook",
                "type": "handbook",
                "title": "Course handbook",
                "locator": "https://example.edu/handbook",
                "accessedAt": "2026-07-23",
            },
        ]
        for evidence in manifest["pointEvidence"]:
            evidence["sourceRefs"] = ["src-course-guide"]
        _write_json(manifest_path, manifest)
        resource = self.pending()
        self.store._run_validator = CourseReviewStore._run_validator.__get__(self.store)

        self.submit(
            resource,
            [{"op": "add", "point": {"id": "delta", "title": "Delta"}}],
        )

        updated = json.loads(manifest_path.read_text(encoding="utf-8"))
        evidence = next(item for item in updated["pointEvidence"] if item["pointId"] == "delta")
        self.assertEqual(evidence["sourceRefs"], ["src-user-review"])
        self.assertEqual(updated["sources"][:3], manifest["sources"])
        self.assertEqual(
            updated["sources"][3],
            {
                "id": "src-user-review",
                "type": "reference",
                "title": "课程知识点结构化用户审核",
                "locator": f"course-studio://reviews/{resource['id']}",
                "accessedAt": resource["created_at"][:10],
            },
        )

    def test_researched_addition_rejects_conflicting_user_review_source(self):
        manifest_path = self.fixture.content_root / "generation" / "manifest.json"
        index_path = self.fixture.data_root / "index.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["generation"]["evidenceMode"] = "researched"
        manifest["sources"] = [
            {
                "id": "src-user-review",
                "type": "reference",
                "title": "Unrelated source",
                "locator": "https://example.edu/unrelated",
                "accessedAt": "2026-07-23",
            }
        ]
        _write_json(manifest_path, manifest)
        resource = self.pending()
        original_manifest = manifest_path.read_bytes()
        original_index = index_path.read_bytes()

        with self.assertRaisesRegex(
            CourseReviewValidationError,
            "src-user-review 与当前审核来源冲突",
        ):
            self.submit(
                resource,
                [{"op": "add", "point": {"id": "delta", "title": "Delta"}}],
            )

        self.assertEqual(manifest_path.read_bytes(), original_manifest)
        self.assertEqual(index_path.read_bytes(), original_index)
        self.assertFalse(
            (self.fixture.approval_root / "knowledge-points.json").exists()
        )

    def test_knowledge_addition_passes_the_real_index_validator(self):
        resource = self.pending()
        self.store._run_validator = CourseReviewStore._run_validator.__get__(self.store)

        result = self.submit(
            resource,
            [{"op": "add", "point": {"id": "delta", "title": "Delta"}}],
        )

        self.assertEqual(result["review"]["status"], "resolved")

    def test_knowledge_submission_rolls_back_if_resource_refresh_fails(self):
        resource = self.pending()
        tracked = [
            self.fixture.data_root / "index.json",
            self.fixture.content_root / "generation" / "manifest.json",
            self.fixture.approval_root / "knowledge-points.json",
            self.fixture.resource_root / "knowledge-points.json",
        ]
        originals = {path: path.read_bytes() if path.exists() else None for path in tracked}
        original_refresh = self.store._refresh_marker

        def fail_final_refresh(*args, **kwargs):
            if kwargs.get("preserve_review_id"):
                raise CourseReviewConflictError("forced refresh failure")
            return original_refresh(*args, **kwargs)

        with patch.object(self.store, "_refresh_marker", side_effect=fail_final_refresh):
            with self.assertRaises(CourseReviewConflictError):
                self.submit(resource, [{"op": "delete", "point_id": "beta"}])

        for path, original in originals.items():
            self.assertEqual(path.read_bytes() if path.exists() else None, original)

    def test_new_store_recovers_process_exit_between_knowledge_file_writes(self):
        resource = self.pending()
        tracked = [
            self.fixture.data_root / "index.json",
            self.fixture.content_root / "generation" / "manifest.json",
            self.fixture.approval_root / "knowledge-points.json",
            self.fixture.resource_root / "knowledge-points.json",
        ]
        originals = {path: path.read_bytes() if path.exists() else None for path in tracked}
        index_path = self.fixture.data_root / "index.json"
        resolved_index_path = index_path.resolve()
        original_write = review_store_module._write_json_atomic

        def stop_after_index(path: Path, value: dict) -> bytes:
            content = original_write(path, value)
            if path.resolve() == resolved_index_path:
                raise KeyboardInterrupt("simulated process stop")
            return content

        with patch.object(
            review_store_module,
            "_write_json_atomic",
            side_effect=stop_after_index,
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.submit(resource, [{"op": "delete", "point_id": "beta"}])

        journal = (
            self.fixture.session_root
            / ".course-review-transactions"
            / COURSE_ID
            / "knowledge-points.json"
        )
        self.assertTrue(journal.exists())
        self.assertNotEqual(index_path.read_bytes(), originals[index_path])

        self.store.pending_for_conversation(CONVERSATION_ID)

        self.assertFalse(journal.exists())
        for path, original in originals.items():
            self.assertEqual(path.read_bytes() if path.exists() else None, original)

    def test_second_store_waits_for_live_knowledge_transaction(self):
        resource = self.pending()
        journal = (
            self.fixture.session_root
            / ".course-review-transactions"
            / COURSE_ID
            / "knowledge-points.json"
        )
        first_target_planned = threading.Event()
        allow_submit_to_continue = threading.Event()
        second_started = threading.Event()
        second_finished = threading.Event()
        submit_errors: list[BaseException] = []
        second_errors: list[BaseException] = []
        submit_results: list[dict] = []
        original_cas = review_store_module._write_json_cas
        paused = False

        def pause_before_first_target(
            path: Path,
            value: dict,
            *,
            expected: bytes | None,
        ) -> bytes:
            nonlocal paused
            if not paused:
                paused = True
                first_target_planned.set()
                if not allow_submit_to_continue.wait(5):
                    raise RuntimeError("timed out waiting to continue review submit")
            return original_cas(path, value, expected=expected)

        def submit_review() -> None:
            try:
                submit_results.append(
                    self.submit(resource, [{"op": "delete", "point_id": "beta"}])
                )
            except BaseException as exc:
                submit_errors.append(exc)

        def construct_second_store() -> None:
            second_started.set()
            try:
                CourseReviewStore(self.fixture.workspace_root, PROJECT_ROOT)
            except BaseException as exc:
                second_errors.append(exc)
            finally:
                second_finished.set()

        with patch.object(
            review_store_module,
            "_write_json_cas",
            side_effect=pause_before_first_target,
        ):
            submitter = threading.Thread(target=submit_review)
            submitter.start()
            self.assertTrue(first_target_planned.wait(5))
            self.assertTrue(journal.exists())

            second_constructor = threading.Thread(target=construct_second_store)
            second_constructor.start()
            self.assertTrue(second_started.wait(5))
            self.assertFalse(
                second_finished.wait(0.1),
                "a second store must not recover another store's live review transaction",
            )

            allow_submit_to_continue.set()
            submitter.join(5)
            second_constructor.join(5)

        self.assertFalse(submitter.is_alive())
        self.assertFalse(second_constructor.is_alive())
        self.assertEqual(submit_errors, [])
        self.assertEqual(second_errors, [])
        self.assertEqual(submit_results[0]["review"]["status"], "resolved")
        index = json.loads(
            (self.fixture.data_root / "index.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            [point["id"] for point in index["points"]],
            ["alpha", "gamma"],
        )
        self.assertFalse(journal.exists())

    def test_committed_review_journal_recovery_keeps_completed_submission(self):
        resource = self.pending()
        journal = (
            self.fixture.session_root
            / ".course-review-transactions"
            / COURSE_ID
            / "knowledge-points.json"
        )

        with patch.object(
            self.store,
            "_cleanup_review_transaction",
            side_effect=KeyboardInterrupt("simulated process stop after commit"),
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.submit(resource, [{"op": "delete", "point_id": "beta"}])

        self.assertEqual(
            json.loads(journal.read_text(encoding="utf-8"))["state"],
            "committed",
        )
        self.assertNotIn(
            "beta",
            [
                point["id"]
                for point in json.loads(
                    (self.fixture.data_root / "index.json").read_text(encoding="utf-8")
                )["points"]
            ],
        )

        recovered = CourseReviewStore(self.fixture.workspace_root, PROJECT_ROOT)

        self.assertFalse(journal.exists())
        replayed = recovered.submit(
            resource["id"],
            conversation_id=CONVERSATION_ID,
            revision=resource["revision"],
            artifact_hash=resource["artifact_hash"],
            operations=[{"op": "delete", "point_id": "beta"}],
        )
        self.assertEqual(replayed["review"]["status"], "resolved")

    def test_new_store_recovers_process_exit_between_prerequisite_writes(self):
        self.fixture.write_graph(source_edges={"beta": ["alpha"]})
        resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        graph_path = self.fixture.course_root / "clustered-graph.json"
        tracked = [
            graph_path,
            self.fixture.approval_root / "prerequisites.json",
            self.fixture.resource_root / "prerequisites.json",
        ]
        originals = {path: path.read_bytes() if path.exists() else None for path in tracked}
        resolved_graph_path = graph_path.resolve()
        original_write = review_store_module._write_json_atomic

        def stop_after_graph(path: Path, value: dict) -> bytes:
            content = original_write(path, value)
            if path.resolve() == resolved_graph_path:
                raise KeyboardInterrupt("simulated process stop")
            return content

        with patch.object(
            review_store_module,
            "_write_json_atomic",
            side_effect=stop_after_graph,
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.submit(
                    resource,
                    [{
                        "op": "remove",
                        "dependent_id": "beta",
                        "prerequisite_id": "alpha",
                        "reason": "remove for crash recovery test",
                    }],
                )

        journal = (
            self.fixture.session_root
            / ".course-review-transactions"
            / COURSE_ID
            / "prerequisites.json"
        )
        self.assertTrue(journal.exists())
        self.assertNotEqual(graph_path.read_bytes(), originals[graph_path])

        CourseReviewStore(self.fixture.workspace_root, PROJECT_ROOT)

        self.assertFalse(journal.exists())
        for path, original in originals.items():
            self.assertEqual(path.read_bytes() if path.exists() else None, original)

    def test_knowledge_cas_rejects_mutation_between_backend_writes(self):
        resource = self.pending()
        index_path = self.fixture.data_root / "index.json"
        manifest_path = self.fixture.content_root / "generation" / "manifest.json"
        approval_path = self.fixture.approval_root / "knowledge-points.json"
        original_index = index_path.read_bytes()
        concurrent_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        concurrent_manifest["subject"]["scope"] = "concurrent scope update"
        original_write = review_store_module._write_json_atomic
        mutated = False

        def mutate_after_index(path: Path, value: dict) -> bytes:
            nonlocal mutated
            content = original_write(path, value)
            if path == index_path.resolve() and not mutated:
                mutated = True
                _write_json(manifest_path, concurrent_manifest)
            return content

        with patch.object(
            review_store_module,
            "_write_json_atomic",
            side_effect=mutate_after_index,
        ):
            with self.assertRaises(CourseReviewConflictError):
                self.submit(
                    resource,
                    [{"op": "delete", "point_id": "beta"}],
                )

        self.assertTrue(mutated)
        self.assertEqual(index_path.read_bytes(), original_index)
        self.assertEqual(
            json.loads(manifest_path.read_text(encoding="utf-8")),
            concurrent_manifest,
        )
        self.assertFalse(approval_path.exists())

    def test_prerequisite_rollback_preserves_validator_period_mutation(self):
        self.fixture.write_graph(source_edges={"beta": ["alpha"]})
        resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        graph_path = self.fixture.course_root / "clustered-graph.json"
        approval_path = self.fixture.approval_root / "prerequisites.json"
        resource_path = self.fixture.resource_root / "prerequisites.json"
        original_resource = resource_path.read_bytes()
        concurrent_graph = json.loads(graph_path.read_text(encoding="utf-8"))
        concurrent_graph["generation"]["externalRevision"] = "preserve-me"
        mutated = False

        def mutate_during_validation(*args, **kwargs) -> None:
            nonlocal mutated
            if not mutated:
                mutated = True
                _write_json(graph_path, concurrent_graph)

        self.store._run_validator = Mock(side_effect=mutate_during_validation)
        with self.assertRaises(CourseReviewConflictError):
            self.submit(
                resource,
                [{
                    "op": "remove",
                    "dependent_id": "beta",
                    "prerequisite_id": "alpha",
                    "reason": "concurrent validation test",
                }],
            )

        self.assertTrue(mutated)
        self.assertEqual(
            json.loads(graph_path.read_text(encoding="utf-8")),
            concurrent_graph,
        )
        self.assertFalse(approval_path.exists())
        self.assertEqual(resource_path.read_bytes(), original_resource)

    def test_matching_approval_requires_strict_timestamp_and_operation_shape(self):
        resource = self.pending()
        approval = {
            "schema_version": "course-review-approval/1.0",
            "review_id": resource["id"],
            "course_id": COURSE_ID,
            "kind": "knowledge-points",
            "gate": "G2_IDENTITY_REVIEW",
            "identity_sha256": resource["identity_sha256"],
            "approved_at": "2026-07-23T00:00:00.000Z",
            "operation_count": 0,
            "submitted_operations": [],
        }
        self.assertTrue(
            self.store._approval_matches(
                approval,
                course_id=COURSE_ID,
                kind="knowledge-points",
                identity_sha256=resource["identity_sha256"],
            )
        )
        invalid_changes = [
            {"approved_at": "2026-07-23 00:00:00Z"},
            {"approved_at": "2026-07-23T00:00:00+00:00"},
            {"approved_at": "2026-07-23T00:00:00.0000Z"},
            {"operation_count": True},
            {"operation_count": 1},
            {"submitted_operations": {}},
        ]
        for changes in invalid_changes:
            with self.subTest(changes=changes):
                candidate = {**approval, **changes}
                self.assertFalse(
                    self.store._approval_matches(
                        candidate,
                        course_id=COURSE_ID,
                        kind="knowledge-points",
                        identity_sha256=resource["identity_sha256"],
                    )
                )

    def test_pipeline_marker_leaf_symlink_is_rejected(self):
        self.fixture.write_marker("knowledge-points")
        marker = self.fixture.review_root / "knowledge-points.request.json"
        target = Path(self.temporary.name) / "outside-marker.json"
        marker.replace(target)
        try:
            marker.symlink_to(target)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")

        with self.assertRaises(CourseReviewUnsafePathError):
            self.store.pending_for_conversation(CONVERSATION_ID)

    def test_pipeline_ancestor_symlink_is_rejected(self):
        self.fixture.write_marker("knowledge-points")
        pipeline = self.fixture.session_root / "pipeline"
        escaped = Path(self.temporary.name) / "escaped-pipeline"
        pipeline.replace(escaped)
        try:
            pipeline.symlink_to(escaped, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")

        with self.assertRaises(CourseReviewUnsafePathError):
            self.store.pending_for_conversation(CONVERSATION_ID)

    def test_resource_and_approval_ancestor_symlinks_are_rejected(self):
        resource = self.pending()
        resource_root = self.fixture.session_root / ".course-reviews"
        escaped_resources = Path(self.temporary.name) / "escaped-resources"
        resource_root.replace(escaped_resources)
        try:
            resource_root.symlink_to(escaped_resources, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        with self.assertRaises(CourseReviewUnsafePathError):
            self.store.get(resource["id"])

        resource_root.unlink()
        escaped_resources.replace(resource_root)
        self.fixture.write_graph(source_edges={"beta": ["alpha"]})
        approval_root = self.fixture.session_root / ".course-review-approvals"
        escaped_approvals = Path(self.temporary.name) / "escaped-approvals"
        approval_root.replace(escaped_approvals)
        approval_root.symlink_to(escaped_approvals, target_is_directory=True)
        with self.assertRaises(CourseReviewUnsafePathError):
            self.store.pending_for_conversation(CONVERSATION_ID)

    def test_workspace_root_itself_cannot_be_a_symlink(self):
        real_root = Path(self.temporary.name) / "real-workspace"
        real_root.mkdir()
        linked_root = Path(self.temporary.name) / "linked-workspace"
        try:
            linked_root.symlink_to(real_root, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        with self.assertRaises(CourseReviewUnsafePathError):
            CourseReviewStore(linked_root, PROJECT_ROOT)

    def test_prerequisite_source_validates_all_ids_before_point_file_reads(self):
        outside_point = self.fixture.content_root / "src" / "outside.json"
        _write_json(outside_point, _graph_point("outside", "Outside"))
        cases = {
            "path traversal": ["alpha", "../../outside", "gamma"],
            "duplicate": ["alpha", "alpha", "gamma"],
            "non-string": ["alpha", 123, "gamma"],
        }

        for label, point_ids in cases.items():
            with self.subTest(label=label):
                self.fixture.write_graph()
                graph_path = self.fixture.course_root / "clustered-graph.json"
                graph = json.loads(graph_path.read_text(encoding="utf-8"))
                for point, point_id in zip(graph["points"], point_ids, strict=True):
                    point["id"] = point_id
                _write_json(graph_path, graph)

                with patch.object(
                    self.store,
                    "_required_document",
                    wraps=self.store._required_document,
                ) as required_document:
                    with self.assertRaises(CourseReviewValidationError):
                        self.store._prerequisite_source(
                            self.store._session_root(CONVERSATION_ID),
                            COURSE_ID,
                        )

                self.assertEqual(
                    [call.args[1] for call in required_document.call_args_list],
                    ["课程元数据", "聚类图谱"],
                )

    def test_prerequisite_source_paths_resolve_within_points_root(self):
        self.fixture.write_graph()

        _, originals = self.store._prerequisite_source(
            self.store._session_root(CONVERSATION_ID),
            COURSE_ID,
        )

        points_root = self.fixture.data_root.joinpath("points").resolve()
        point_paths = [
            path
            for path in originals
            if path.name in {"alpha.json", "beta.json", "gamma.json"}
        ]
        self.assertEqual(len(point_paths), 3)
        for path in point_paths:
            self.assertEqual(path.resolve().parent, points_root)

    def test_prerequisite_gate_materializes_while_knowledge_resume_is_pending(self):
        self.fixture.write_graph()
        knowledge_approval_path = (
            self.fixture.approval_root / "knowledge-points.json"
        )
        knowledge_approval = json.loads(
            knowledge_approval_path.read_text(encoding="utf-8")
        )
        knowledge_approval["resume_pending"] = True
        _write_json(knowledge_approval_path, knowledge_approval)

        resources = self.store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual(len(resources), 1)
        self.assertEqual(resources[0]["kind"], "prerequisites")
        self.assertTrue(
            (self.fixture.resource_root / "prerequisites.json").is_file()
        )

    def test_prerequisite_refresh_allows_but_submit_rejects_unconsumed_resume(self):
        self.fixture.write_graph(source_edges={"beta": ["alpha"]})
        resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        graph_path = self.fixture.course_root / "clustered-graph.json"
        original_graph = graph_path.read_bytes()
        knowledge_approval_path = (
            self.fixture.approval_root / "knowledge-points.json"
        )
        knowledge_approval = json.loads(
            knowledge_approval_path.read_text(encoding="utf-8")
        )
        knowledge_approval["resume_pending"] = True
        _write_json(knowledge_approval_path, knowledge_approval)

        refreshed = self.store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual([item["id"] for item in refreshed], [resource["id"]])
        with self.assertRaisesRegex(
            CourseReviewConflictError,
            "尚未恢复到生成流程",
        ):
            self.submit(resource, [])
        self.assertEqual(graph_path.read_bytes(), original_graph)
        self.assertFalse(
            (self.fixture.approval_root / "prerequisites.json").exists()
        )

        knowledge_approval["resume_pending"] = False
        _write_json(knowledge_approval_path, knowledge_approval)
        result = self.submit(resource, [])
        self.assertEqual(result["review"]["status"], "resolved")

    def test_prerequisite_validation_rejects_invalid_edges(self):
        self.fixture.write_graph(
            source_edges={"beta": ["alpha"]},
            related={"alpha": ["gamma"], "gamma": ["alpha"]},
        )
        resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        invalid_operations = {
            "dangling": [{"op": "add", "dependent_id": "gamma", "prerequisite_id": "missing", "reason": "missing"}],
            "self": [{"op": "add", "dependent_id": "gamma", "prerequisite_id": "gamma", "reason": "self"}],
            "duplicate": [{"op": "add", "dependent_id": "beta", "prerequisite_id": "alpha", "reason": "duplicate"}],
            "related": [{"op": "add", "dependent_id": "gamma", "prerequisite_id": "alpha", "reason": "conflict"}],
            "cycle": [{"op": "add", "dependent_id": "alpha", "prerequisite_id": "beta", "reason": "cycle"}],
        }
        graph_path = self.fixture.course_root / "clustered-graph.json"
        original = graph_path.read_bytes()

        for label, operations in invalid_operations.items():
            with self.subTest(label=label):
                with self.assertRaises(CourseReviewValidationError):
                    self.submit(resource, operations)
                self.assertEqual(graph_path.read_bytes(), original)

    def test_prerequisite_resource_exposes_unique_related_pairs(self):
        self.fixture.write_graph(
            source_edges={"beta": ["alpha"]},
            related={
                "alpha": ["gamma"],
                "beta": ["gamma"],
                "gamma": ["alpha", "beta"],
            },
        )

        resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]

        self.assertEqual(
            resource["related_pairs"],
            [
                {"first_id": "alpha", "second_id": "gamma"},
                {"first_id": "beta", "second_id": "gamma"},
            ],
        )

    def test_prerequisite_review_updates_graph_and_preserves_reasons(self):
        self.fixture.write_graph(source_edges={"beta": ["alpha"]})
        resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        operations = [
            {"op": "remove", "dependent_id": "beta", "prerequisite_id": "alpha", "reason": "Not required"},
            {"op": "add", "dependent_id": "gamma", "prerequisite_id": "beta", "reason": "Builds on beta"},
        ]

        result = self.submit(resource, operations)

        graph = json.loads((self.fixture.course_root / "clustered-graph.json").read_text(encoding="utf-8"))
        by_id = {point["id"]: point for point in graph["points"]}
        self.assertEqual(by_id["beta"]["prerequisites"], [])
        self.assertEqual(by_id["gamma"]["prerequisites"], ["beta"])
        self.assertEqual(
            graph["generation"]["refinedPrerequisiteEdges"],
            [
                {"op": "remove", "from": "beta", "to": "alpha", "reason": "Not required"},
                {"op": "add", "from": "gamma", "to": "beta", "reason": "Builds on beta"},
            ],
        )
        approval = json.loads(
            (self.fixture.approval_root / "prerequisites.json").read_text(encoding="utf-8")
        )
        self.assertEqual(approval["submitted_operations"], operations)
        self.assertEqual(result["review"]["status"], "resolved")

    def test_prerequisite_approval_is_invalidated_by_audit_reason_drift(self):
        self.fixture.write_graph(
            source_edges={},
            graph_edges={"beta": ["alpha"]},
            refinements=[{
                "op": "add",
                "from": "beta",
                "to": "alpha",
                "reason": "original review reason",
            }],
        )
        resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        _write_json(
            self.fixture.approval_root / "prerequisites.json",
            {
                "schema_version": "course-review-approval/1.0",
                "review_id": resource["id"],
                "course_id": COURSE_ID,
                "kind": "prerequisites",
                "gate": "G6_PREREQUISITE_REVIEW",
                "identity_sha256": resource["identity_sha256"],
                "prerequisites_sha256": resource["prerequisites_sha256"],
                "review_audit_sha256": resource["review_audit_sha256"],
                "approved_at": "2026-07-23T00:00:00.000Z",
                "operation_count": 0,
                "submitted_operations": [],
            },
        )
        self.assertEqual(
            self.store.pending_for_conversation(CONVERSATION_ID),
            [],
        )

        graph_path = self.fixture.course_root / "clustered-graph.json"
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        graph["generation"]["refinedPrerequisiteEdges"][0]["reason"] = (
            "a materially different review reason"
        )
        _write_json(graph_path, graph)

        pending = self.store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["status"], "pending")
        self.assertNotEqual(
            pending[0]["review_audit_sha256"],
            resource["review_audit_sha256"],
        )

    def test_removing_model_added_edge_keeps_user_reason_only_in_backend_audit(self):
        model_refinement = {
            "op": "add",
            "from": "beta",
            "to": "alpha",
            "reason": "Model inferred relation",
        }
        self.fixture.write_graph(
            source_edges={},
            graph_edges={"beta": ["alpha"]},
            refinements=[model_refinement],
        )
        resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        operation = {
            "op": "remove",
            "dependent_id": "beta",
            "prerequisite_id": "alpha",
            "reason": "User rejects this dependency",
        }

        result = self.submit(resource, [operation])

        graph = json.loads((self.fixture.course_root / "clustered-graph.json").read_text(encoding="utf-8"))
        self.assertEqual(graph["generation"]["refinedPrerequisiteEdges"], [])
        approval = json.loads(
            (self.fixture.approval_root / "prerequisites.json").read_text(encoding="utf-8")
        )
        self.assertEqual(approval["submitted_operations"], [operation])
        self.assertEqual(result["review"]["submitted_operations"], [operation])

    def test_resume_claim_release_complete_is_persisted_and_exclusive(self):
        resource = self.pending()
        result = self.submit(resource, [])
        review_id = result["review"]["id"]

        claimed = self.store.claim_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="claim-one",
        )
        self.assertEqual(claimed["review"]["resume_claim_id"], "claim-one")
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
            document = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(document["resume_claim_id"], "claim-one")
            self.assertTrue(document["resume_pending"])

        released = self.store.release_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="claim-one",
        )
        self.assertNotIn("resume_claim_id", released["review"])
        self.store.claim_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="claim-two",
        )
        completed = self.store.complete_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="claim-two",
        )
        self.assertFalse(completed["review"]["resume_pending"])
        with self.assertRaises(CourseReviewConflictError):
            self.store.get_resume(review_id, conversation_id=CONVERSATION_ID)
        self.assertIsNone(
            self.store.resume_pending_for_conversation(CONVERSATION_ID)
        )
        for path in (
            self.fixture.approval_root / "knowledge-points.json",
            self.fixture.resource_root / "knowledge-points.json",
        ):
            document = json.loads(path.read_text(encoding="utf-8"))
            self.assertFalse(document["resume_pending"])
            self.assertNotIn("resume_claim_id", document)

    def test_two_store_instances_cannot_both_claim_the_same_resume(self):
        resource = self.pending()
        result = self.submit(resource, [])
        review_id = result["review"]["id"]
        second_store = CourseReviewStore(
            self.fixture.workspace_root,
            PROJECT_ROOT,
        )
        first_ready_to_persist = threading.Event()
        allow_first_to_persist = threading.Event()
        second_started = threading.Event()
        second_finished = threading.Event()
        first_results: list[dict] = []
        first_errors: list[BaseException] = []
        second_errors: list[BaseException] = []
        original_persist = CourseReviewStore._persist_resume_documents

        def pause_first_persist(
            approval_path: Path,
            resource_path: Path,
            approval: dict,
            updated_resource: dict,
            originals: dict[Path, bytes | None],
        ) -> None:
            first_ready_to_persist.set()
            if not allow_first_to_persist.wait(5):
                raise RuntimeError("timed out waiting to persist first claim")
            original_persist(
                approval_path,
                resource_path,
                approval,
                updated_resource,
                originals,
            )

        def claim_first() -> None:
            try:
                first_results.append(
                    self.store.claim_resume(
                        review_id,
                        conversation_id=CONVERSATION_ID,
                        claim_id="claim-one",
                    )
                )
            except BaseException as exc:
                first_errors.append(exc)

        def claim_second() -> None:
            second_started.set()
            try:
                second_store.claim_resume(
                    review_id,
                    conversation_id=CONVERSATION_ID,
                    claim_id="claim-two",
                )
            except BaseException as exc:
                second_errors.append(exc)
            finally:
                second_finished.set()

        with patch.object(
            self.store,
            "_persist_resume_documents",
            side_effect=pause_first_persist,
        ):
            first_claim = threading.Thread(target=claim_first)
            first_claim.start()
            self.assertTrue(first_ready_to_persist.wait(5))

            second_claim = threading.Thread(target=claim_second)
            second_claim.start()
            self.assertTrue(second_started.wait(5))
            self.assertFalse(
                second_finished.wait(0.1),
                "a second store must wait while the first claim is being persisted",
            )

            allow_first_to_persist.set()
            first_claim.join(5)
            second_claim.join(5)

        self.assertFalse(first_claim.is_alive())
        self.assertFalse(second_claim.is_alive())
        self.assertEqual(first_errors, [])
        self.assertEqual(first_results[0]["review"]["resume_claim_id"], "claim-one")
        self.assertEqual(len(second_errors), 1)
        self.assertIsInstance(second_errors[0], CourseReviewConflictError)
        for path in (
            self.fixture.approval_root / "knowledge-points.json",
            self.fixture.resource_root / "knowledge-points.json",
        ):
            document = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(document["resume_claim_id"], "claim-one")

    def test_partial_resume_resource_write_recovers_from_approval(self):
        resource = self.pending()
        result = self.submit(resource, [])
        review_id = result["review"]["id"]
        resource_path = self.fixture.resource_root / "knowledge-points.json"
        partial = json.loads(resource_path.read_text(encoding="utf-8"))
        partial["resume_pending"] = False
        partial["resumed_at"] = "2026-07-23T00:01:00.000Z"
        _write_json(resource_path, partial)

        recovered = self.store.get(review_id)

        self.assertTrue(recovered["resume_pending"])
        self.assertNotIn("resumed_at", recovered)
        self.assertTrue(
            json.loads(resource_path.read_text(encoding="utf-8"))["resume_pending"]
        )

    def test_resume_claim_lease_is_short_and_independent_of_terminal_timeout(self):
        with patch.object(
            review_store_module.settings,
            "opencode_terminal_timeout_seconds",
            3600,
        ):
            self.assertEqual(
                review_store_module._resume_claim_lease().total_seconds(),
                120,
            )
        with patch.object(
            review_store_module.settings,
            "opencode_terminal_timeout_seconds",
            60,
        ):
            self.assertEqual(
                review_store_module._resume_claim_lease().total_seconds(),
                120,
            )
        self.assertLess(
            review_store_module.RESUME_CLAIM_HEARTBEAT_SECONDS,
            review_store_module.RESUME_CLAIM_LEASE_SECONDS,
        )

    def test_expired_resume_claim_can_be_reclaimed_and_renewed(self):
        resource = self.pending()
        review_id = self.submit(resource, [])["review"]["id"]
        self.store.claim_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="expired-claim",
        )
        for path in (
            self.fixture.approval_root / "knowledge-points.json",
            self.fixture.resource_root / "knowledge-points.json",
        ):
            document = json.loads(path.read_text(encoding="utf-8"))
            document["resume_claimed_at"] = "2000-01-01T00:00:00.000Z"
            _write_json(path, document)

        reclaimed = self.store.claim_resume(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="active-claim",
        )
        reclaimed_at = reclaimed["review"]["resume_claimed_at"]
        renewed = self.store.renew_resume_claim(
            review_id,
            conversation_id=CONVERSATION_ID,
            claim_id="active-claim",
        )
        self.assertGreaterEqual(
            renewed["review"]["resume_claimed_at"],
            reclaimed_at,
        )
        with self.assertRaises(CourseReviewConflictError):
            self.store.claim_resume(
                review_id,
                conversation_id=CONVERSATION_ID,
                claim_id="second-active-claim",
            )

    def test_resolved_knowledge_review_is_scoped_to_course(self):
        resource = self.pending()
        self.submit(resource, [])

        self.assertTrue(
            self.store.has_resolved_knowledge_review(CONVERSATION_ID, COURSE_ID)
        )
        self.assertFalse(
            self.store.has_resolved_knowledge_review(
                CONVERSATION_ID,
                "another-course",
            )
        )
        self.assertEqual(
            self.store.resolved_knowledge_course_for_conversation(CONVERSATION_ID),
            COURSE_ID,
        )

        another_pipeline = self.fixture.session_root / "pipeline" / "another-course"
        another_pipeline.mkdir()
        self.assertIsNone(
            self.store.resolved_knowledge_course_for_conversation(CONVERSATION_ID)
        )
        another_pipeline.rmdir()
        _write_json(
            self.fixture.session_root / "courses" / COURSE_ID / "course.json",
            {"id": COURSE_ID, "status": "published"},
        )
        self.assertIsNone(
            self.store.resolved_knowledge_course_for_conversation(CONVERSATION_ID)
        )


class CourseReviewApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = ReviewFixture(Path(self.temporary.name))
        self.fixture.write_index()
        self.fixture.write_marker("knowledge-points")
        self.store = CourseReviewStore(self.fixture.workspace_root, PROJECT_ROOT)
        self.store._run_validator = Mock()
        app = FastAPI()
        app.include_router(reviews_api.router, prefix="/api/agent/reviews")
        self.patch = patch.object(reviews_api, "get_course_review_store", return_value=self.store)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.client = TestClient(app)

    def test_list_detail_and_stale_submit_contract(self):
        listed = self.client.get(
            "/api/agent/reviews",
            params={"conversation_id": CONVERSATION_ID},
        )
        self.assertEqual(listed.status_code, 200)
        pointer = listed.json()["pending_review"]
        self.assertEqual(pointer["kind"], "knowledge-points")
        self.assertEqual(pointer["review_url"], f"#/reviews/{pointer['id']}/points")
        detail = self.client.get(f"/api/agent/reviews/{pointer['id']}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["points"][0]["id"], "alpha")

        stale = self.client.post(
            f"/api/agent/reviews/{pointer['id']}/submit",
            json={
                "conversation_id": CONVERSATION_ID,
                "revision": pointer["revision"] + 1,
                "artifact_hash": pointer["artifact_hash"],
                "operations": [],
            },
        )
        self.assertEqual(stale.status_code, 409)

        submit_body = {
            "conversation_id": CONVERSATION_ID,
            "revision": pointer["revision"],
            "artifact_hash": pointer["artifact_hash"],
            "operations": [],
        }
        submitted = self.client.post(
            f"/api/agent/reviews/{pointer['id']}/submit",
            json=submit_body,
        )
        self.assertEqual(submitted.status_code, 200)
        self.assertEqual(submitted.json()["review"]["status"], "resolved")
        self.assertTrue(submitted.json()["resume_message"])
        self.assertTrue(submitted.json()["display_content"])

        # A lost response can be replayed without applying operations twice or
        # minting a different receipt.
        replayed = self.client.post(
            f"/api/agent/reviews/{pointer['id']}/submit",
            json=submit_body,
        )
        self.assertEqual(replayed.status_code, 200)
        self.assertEqual(replayed.json(), submitted.json())
        conflicting_retry = self.client.post(
            f"/api/agent/reviews/{pointer['id']}/submit",
            json={
                **submit_body,
                "operations": [{"op": "delete", "point_id": "beta"}],
            },
        )
        self.assertEqual(conflicting_retry.status_code, 409)

        restored = self.client.get(
            "/api/agent/reviews",
            params={"conversation_id": CONVERSATION_ID},
        )
        self.assertEqual(restored.status_code, 200)
        self.assertIsNone(restored.json()["pending_review"])
        self.assertEqual(
            restored.json()["pending_review_resume"]["id"],
            pointer["id"],
        )

    def test_real_g2_resume_handoff_keeps_g6_internal_until_resume_completes(self):
        knowledge_resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        submitted = self.store.submit(
            knowledge_resource["id"],
            conversation_id=CONVERSATION_ID,
            revision=knowledge_resource["revision"],
            artifact_hash=knowledge_resource["artifact_hash"],
            operations=[],
        )
        self.fixture.write_graph(identity_resume_pending=None)

        internal_resources = self.store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual(len(internal_resources), 1)
        prerequisite_resource = internal_resources[0]
        self.assertEqual(prerequisite_resource["kind"], "prerequisites")

        external_reviews = self.client.get(
            "/api/agent/reviews",
            params={"conversation_id": CONVERSATION_ID},
        )
        self.assertEqual(external_reviews.status_code, 200)
        self.assertEqual(external_reviews.json()["reviews"], [])
        self.assertIsNone(external_reviews.json()["pending_review"])
        self.assertEqual(
            external_reviews.json()["pending_review_resume"]["id"],
            submitted["review"]["id"],
        )

        blocked_submit = self.client.post(
            f"/api/agent/reviews/{prerequisite_resource['id']}/submit",
            json={
                "conversation_id": CONVERSATION_ID,
                "revision": prerequisite_resource["revision"],
                "artifact_hash": prerequisite_resource["artifact_hash"],
                "operations": [],
            },
        )
        self.assertEqual(blocked_submit.status_code, 409)
        self.assertIn("尚未恢复到生成流程", blocked_submit.json()["detail"])

        conversation_store = ConversationStore(
            Path(self.temporary.name) / "handoff-conversations.sqlite3"
        )
        conversation_store.ensure_conversation(
            CONVERSATION_ID,
            mode="agent",
            workflow="course-create",
            title_hint="Create demo",
        )
        conversation_app = FastAPI()
        conversation_app.include_router(
            conversations_api.router,
            prefix="/api/conversations",
        )
        with (
            patch.object(
                conversations_api,
                "get_conversation_store",
                return_value=conversation_store,
            ),
            patch.object(
                conversations_api,
                "get_course_review_store",
                return_value=self.store,
            ),
        ):
            conversation = TestClient(conversation_app).get(
                f"/api/conversations/{CONVERSATION_ID}"
            )
        self.assertEqual(conversation.status_code, 200)
        self.assertIsNone(conversation.json()["pending_review"])
        self.assertEqual(
            conversation.json()["pending_review_resume"]["id"],
            submitted["review"]["id"],
        )

        class CollectingWebSocket:
            def __init__(self) -> None:
                self.messages: list[dict] = []

            async def send_json(self, message: dict) -> None:
                self.messages.append(message)

        websocket = CollectingWebSocket()
        with patch.object(
            agent_api,
            "get_course_review_store",
            return_value=self.store,
        ):
            asyncio.run(
                agent_api._run_agent_turn_opencode(
                    websocket,
                    {
                        "review_resume_id": submitted["review"]["id"],
                        "conversation_id": CONVERSATION_ID,
                        "mode": "agent",
                        "workflow": "course-create",
                    },
                    {"id": None},
                )
            )

        self.assertTrue(any(
            message["type"] == "agent_review_resolved"
            for message in websocket.messages
        ))
        self.assertTrue(any(
            message["type"] == "agent_review_required"
            and message["payload"]["id"] == prerequisite_resource["id"]
            for message in websocket.messages
        ))
        knowledge_approval = json.loads(
            (self.fixture.approval_root / "knowledge-points.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertFalse(knowledge_approval["resume_pending"])

        visible_reviews = self.client.get(
            "/api/agent/reviews",
            params={"conversation_id": CONVERSATION_ID},
        )
        self.assertEqual(
            visible_reviews.json()["pending_review"]["id"],
            prerequisite_resource["id"],
        )
        self.assertIsNone(visible_reviews.json()["pending_review_resume"])

    def test_public_apis_return_g2_resume_without_reading_broken_g6_marker(self):
        knowledge_resource = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        submitted = self.store.submit(
            knowledge_resource["id"],
            conversation_id=CONVERSATION_ID,
            revision=knowledge_resource["revision"],
            artifact_hash=knowledge_resource["artifact_hash"],
            operations=[],
        )
        self.fixture.write_marker("prerequisites")
        with self.assertRaisesRegex(CourseReviewValidationError, "缺少聚类图谱"):
            self.store.pending_for_conversation(CONVERSATION_ID)

        reviews = self.client.get(
            "/api/agent/reviews",
            params={"conversation_id": CONVERSATION_ID},
        )
        self.assertEqual(reviews.status_code, 200)
        self.assertEqual(reviews.json()["reviews"], [])
        self.assertIsNone(reviews.json()["pending_review"])
        self.assertEqual(
            reviews.json()["pending_review_resume"]["id"],
            submitted["review"]["id"],
        )

        conversation_store = ConversationStore(
            Path(self.temporary.name) / "broken-g6-conversations.sqlite3"
        )
        conversation_store.ensure_conversation(
            CONVERSATION_ID,
            mode="agent",
            workflow="course-create",
            title_hint="Create demo",
        )
        conversation_app = FastAPI()
        conversation_app.include_router(
            conversations_api.router,
            prefix="/api/conversations",
        )
        with (
            patch.object(
                conversations_api,
                "get_conversation_store",
                return_value=conversation_store,
            ),
            patch.object(
                conversations_api,
                "get_course_review_store",
                return_value=self.store,
            ),
        ):
            conversation = TestClient(conversation_app).get(
                f"/api/conversations/{CONVERSATION_ID}"
            )

        self.assertEqual(conversation.status_code, 200)
        self.assertIsNone(conversation.json()["pending_review"])
        self.assertEqual(
            conversation.json()["pending_review_resume"]["id"],
            submitted["review"]["id"],
        )

    def test_conversation_detail_includes_pending_review_without_deleting_workspace(self):
        conversation_store = ConversationStore(Path(self.temporary.name) / "conversations.sqlite3")
        conversation_store.ensure_conversation(
            CONVERSATION_ID,
            mode="agent",
            workflow="course-create",
            title_hint="Create demo",
        )
        app = FastAPI()
        app.include_router(conversations_api.router, prefix="/api/conversations")
        with (
            patch.object(conversations_api, "get_conversation_store", return_value=conversation_store),
            patch.object(conversations_api, "get_course_review_store", return_value=self.store),
        ):
            client = TestClient(app)
            response = client.get(f"/api/conversations/{CONVERSATION_ID}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["pending_review"]["kind"], "knowledge-points")
            deleted = client.delete(f"/api/conversations/{CONVERSATION_ID}")
            self.assertEqual(deleted.status_code, 204)

        self.assertTrue(self.fixture.session_root.is_dir())

    def test_conversation_restores_lost_submit_response_until_resume_completes(self):
        conversation_store = ConversationStore(
            Path(self.temporary.name) / "resume-conversations.sqlite3"
        )
        conversation_store.ensure_conversation(
            CONVERSATION_ID,
            mode="agent",
            workflow="course-create",
            title_hint="Create demo",
        )
        pending = self.store.pending_for_conversation(CONVERSATION_ID)[0]
        submitted = self.store.submit(
            pending["id"],
            conversation_id=CONVERSATION_ID,
            revision=pending["revision"],
            artifact_hash=pending["artifact_hash"],
            operations=[],
        )
        app = FastAPI()
        app.include_router(conversations_api.router, prefix="/api/conversations")
        with (
            patch.object(
                conversations_api,
                "get_conversation_store",
                return_value=conversation_store,
            ),
            patch.object(
                conversations_api,
                "get_course_review_store",
                return_value=self.store,
            ),
        ):
            client = TestClient(app)
            restored = client.get(f"/api/conversations/{CONVERSATION_ID}")
            self.assertEqual(restored.status_code, 200)
            self.assertIsNone(restored.json()["pending_review"])
            self.assertEqual(
                restored.json()["pending_review_resume"]["id"],
                submitted["review"]["id"],
            )

            self.store.consume_resume(
                submitted["review"]["id"],
                conversation_id=CONVERSATION_ID,
            )
            completed = client.get(f"/api/conversations/{CONVERSATION_ID}")
            self.assertEqual(completed.status_code, 200)
            self.assertIsNone(completed.json()["pending_review_resume"])

    def test_conversation_prioritizes_g2_resume_before_same_course_g6_review(self):
        conversation_store = ConversationStore(
            Path(self.temporary.name) / "crash-conversations.sqlite3"
        )
        conversation_store.ensure_conversation(
            CONVERSATION_ID,
            mode="agent",
            workflow="course-create",
            title_hint="Create demo",
        )
        upstream = {
            "id": "review-g2",
            "kind": "knowledge-points",
            "gate": "G2_IDENTITY_REVIEW",
            "status": "resolved",
            "conversation_id": CONVERSATION_ID,
            "course_id": COURSE_ID,
            "resume_pending": True,
        }
        downstream = {
            "id": "review-g6",
            "kind": "prerequisites",
            "gate": "G6_PREREQUISITE_REVIEW",
            "status": "pending",
            "conversation_id": CONVERSATION_ID,
            "course_id": COURSE_ID,
        }
        review_store = Mock()
        review_store.pending_for_conversation.return_value = [downstream]
        review_store.resume_pending_for_conversation.return_value = upstream
        review_store.pointer.side_effect = lambda resource: resource
        app = FastAPI()
        app.include_router(conversations_api.router, prefix="/api/conversations")
        with (
            patch.object(
                conversations_api,
                "get_conversation_store",
                return_value=conversation_store,
            ),
            patch.object(
                conversations_api,
                "get_course_review_store",
                return_value=review_store,
            ),
        ):
            response = TestClient(app).get(
                f"/api/conversations/{CONVERSATION_ID}"
            )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["pending_review"])
        self.assertEqual(
            response.json()["pending_review_resume"]["id"],
            "review-g2",
        )


if __name__ == "__main__":
    unittest.main()
