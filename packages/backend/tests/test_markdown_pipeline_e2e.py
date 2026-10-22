from __future__ import annotations

from copy import deepcopy
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from src.services.documents import binding
from src.services.documents.markdown_parser import parse_markdown_document
from src.services.documents.store import DocumentStore
from src.services.reviews import CourseReviewStore


PROJECT_ROOT = Path(__file__).resolve().parents[3]
SMALL_MINERU_FIXTURE = Path(__file__).parent / "fixtures" / "mineru" / "small" / "full.md"
CONVERSATION_ID = "markdown-pipeline-e2e"
GENERATED_AT = "2026-10-22"


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class MarkdownPipelineEndToEndTest(unittest.TestCase):
    """Exercise one Markdown textbook through the real publish boundary.

    The point-content builder below is deliberately deterministic and stands
    in for the production LLM.  The test therefore verifies every local
    contract, review receipt, and publishing step without making a model or
    network call.
    """

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace_root = self.root / "sessions"
        self.session_root = self.workspace_root / CONVERSATION_ID
        self.session_root.mkdir(parents=True)
        self.document_store = DocumentStore(self.root / "documents")

    def _run_node(self, script: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            ["node", str(script), *map(str, arguments)],
            cwd=self.session_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
            env={
                **__import__("os").environ,
                "COURSE_STUDIO_PROJECT_ROOT": str(PROJECT_ROOT),
            },
        )
        self.assertEqual(
            completed.returncode,
            0,
            completed.stderr or completed.stdout,
        )
        return completed

    def _install_session_skills(self) -> None:
        target_root = self.session_root / ".opencode" / "skills"
        target_root.mkdir(parents=True)
        for name in (
            "candidate-knowledge-point-generator",
            "knowledge-cluster-builder",
            "knowledge-pipeline-orchestrator",
        ):
            shutil.copytree(PROJECT_ROOT / "skills" / name, target_root / name)

    @staticmethod
    def _flatten_outline(outline: dict) -> list[tuple[dict, dict]]:
        return [
            (chapter, point)
            for chapter in outline["chapters"]
            for point in chapter["points"]
        ]

    @staticmethod
    def _source_spans(
        *,
        outline: dict,
        material: dict,
        point: dict,
    ) -> list[dict]:
        source = next(
            item
            for item in material["point_sources"]
            if item["point_id"] == point["id"]
        )
        sections = {
            section["id"]: section
            for section in material["sections"]
        }
        spans = []
        for section_id in source["section_ids"]:
            section = sections[section_id]
            span = {
                "materialId": outline["document_id"],
                "blockIds": [section["id"]],
                "headingPath": list(section["heading_path"]),
                "lineStart": section["line_start"],
                "lineEnd": section["line_end"],
                "assetRefs": list(section["asset_refs"]),
                "excerptSha256": section["sha256"],
            }
            if section.get("page") is not None:
                span["page"] = section["page"]
            spans.append(span)
        return spans

    def _write_index_stage(
        self,
        *,
        binding_result: binding.TextbookBinding,
        outline: dict,
        material: dict,
    ) -> tuple[Path, dict, list[dict]]:
        content_root = (
            self.session_root
            / "pipeline"
            / binding_result.course_id
            / "course-content"
        )
        flattened = self._flatten_outline(outline)
        index_points = []
        evidence = []
        for _chapter, point in flattened:
            summary = (
                f"{point['title']}由教材证据确定范围，并由确定性测试替身补充定义、"
                "边界、实践步骤与检查方法，形成可审核的学习单元。"
            )
            index_points.append({
                "id": point["id"],
                "title": point["title"],
                "shortSummary": summary,
                "difficulty": "基础",
                "importance": 0.8,
                "keyTerms": [point["title"], f"{point['title']}方法"],
            })
            evidence.append({
                "pointId": point["id"],
                "title": point["title"],
                "kind": "concept",
                "sourceRefs": ["src-textbook"],
                "confidence": 0.95,
                "scopeStatus": "core",
                "origin": point["origin"],
                "sourceSpans": self._source_spans(
                    outline=outline,
                    material=material,
                    point=point,
                ),
            })

        subject = {
            "id": binding_result.course_id,
            "input": outline["title"],
            "normalizedTitle": outline["title"],
            "inputType": "course",
            "language": "zh-CN",
            "audience": "传感器数据处理入门学习者",
            "depth": "两章教材的基础学习单元",
            "scope": "覆盖采样质量、数据清洗、平滑处理与阈值告警。",
            "exclusions": [],
            "outcomes": ["能够依据教材证据解释并应用各知识点。"],
        }
        _write_json(
            content_root / "src" / "data" / "course.json",
            {
                "schema_version": "1.0",
                "id": binding_result.course_id,
                "title": outline["title"],
                "description": "由 MinerU 风格 Markdown 测试教材生成的确定性知识森林课程。",
                "language": "zh-CN",
                "version": "0.1.0",
                "updatedAt": GENERATED_AT,
            },
        )
        _write_json(
            content_root / "src" / "data" / "index.json",
            {
                "schema_version": "course-content-index/1.0",
                "courseId": binding_result.course_id,
                "points": index_points,
            },
        )
        _write_json(
            content_root / "generation" / "manifest.json",
            {
                "schema_version": "course-content-generation/1.0",
                "subject": subject,
                "generation": {
                    "evidenceMode": "textbook-grounded",
                    "contentContract": "textbook-content/2.0",
                    "generatedAt": GENERATED_AT,
                    "pointCount": len(index_points),
                },
                "sources": [{
                    "id": "src-textbook",
                    "type": "textbook",
                    "title": outline["title"],
                    "locator": binding_result.input_markdown_path,
                    "accessedAt": GENERATED_AT,
                }],
                "pointEvidence": evidence,
                "reviewQueue": [],
            },
        )
        return content_root, subject, evidence

    def _write_detail_and_graph_stage(
        self,
        *,
        course_id: str,
        content_root: Path,
        outline: dict,
        subject: dict,
        evidence: list[dict],
    ) -> dict:
        index = _read_json(content_root / "src" / "data" / "index.json")
        index_by_id = {point["id"]: point for point in index["points"]}
        evidence_by_id = {item["pointId"]: item for item in evidence}
        detail_by_id: dict[str, dict] = {}

        for _chapter, outline_point in self._flatten_outline(outline):
            point_id = outline_point["id"]
            index_point = index_by_id[point_id]
            point_evidence = evidence_by_id[point_id]
            detail = {
                **deepcopy(index_point),
                "animationType": "none",
                "prerequisites": [],
                "origin": point_evidence["origin"],
                "content": {
                    "schema_version": "textbook-content/2.0",
                    "blocks": [
                        {
                            "id": "textbook-source",
                            "kind": "explanation",
                            "title": "教材说明",
                            "markdown": (
                                f"教材给出了{outline_point['title']}的定义、条件和适用范围。"
                            ),
                            "provenance": {
                                "origin": "textbook",
                                "representation": "paraphrase",
                                "sourceSpans": deepcopy(point_evidence["sourceSpans"]),
                            },
                        },
                        {
                            "id": "model-enrichment",
                            "kind": "worked-example",
                            "title": "补充应用示例",
                            "markdown": (
                                f"根据教材内容，补充一个在传感器数据处理流程中应用"
                                f"{outline_point['title']}的可检查示例。"
                            ),
                            "provenance": {
                                "origin": "model",
                                "basedOnBlockIds": ["textbook-source"],
                            },
                        },
                    ],
                },
            }
            detail_by_id[point_id] = detail
            _write_json(
                content_root / "src" / "data" / "points" / f"{point_id}.json",
                detail,
            )
            _write_json(
                content_root
                / "generation"
                / "animation-requests"
                / f"{point_id}.json",
                {
                    "schema_version": "animation-request/1.0",
                    "pointId": point_id,
                    "needed": False,
                    "rationale": "该知识点可由教材证据、静态步骤和问答完整表达，无需单独动画。",
                },
            )

        _write_json(
            content_root / "generation" / "animation-manifest.json",
            {
                "schema_version": "course-content-animations/1.0",
                "animations": [],
            },
        )
        self._run_node(
            PROJECT_ROOT
            / "skills"
            / "candidate-knowledge-point-generator"
            / "scripts"
            / "build_animation_registry.mjs",
            "--root",
            str(content_root),
        )

        clusters = [{
            "id": chapter["id"],
            "title": chapter["title"],
            "subtitle": f"{chapter['title']}学习单元",
            "description": f"按照教材顺序组织{chapter['title']}中的知识点。",
            "order": chapter["order"],
        } for chapter in outline["chapters"]]
        graph_points = []
        for chapter in outline["chapters"]:
            for point_index, outline_point in enumerate(chapter["points"]):
                graph_points.append({
                    "id": outline_point["id"],
                    "title": outline_point["title"],
                    "origin": outline_point["origin"],
                    "clusterIds": [chapter["id"]],
                    "role": "trunk" if point_index == 0 else "leaf",
                    "prerequisites": [],
                    "related": [],
                })
        graph = {
            "schema_version": "clustered-graph/3.0",
            "subject": deepcopy(subject),
            "generation": {
                "generatedAt": GENERATED_AT,
                "sourceCourseId": course_id,
                "pointCount": len(graph_points),
                "clusterCount": len(clusters),
                "brokenCycleEdges": [],
                "refinedPrerequisiteEdges": [],
            },
            "clusters": clusters,
            "sequences": {
                "cluster": [
                    {
                        "fromId": outline["chapters"][index]["id"],
                        "toId": outline["chapters"][index + 1]["id"],
                    }
                    for index in range(len(outline["chapters"]) - 1)
                ],
                "point": [
                    {
                        "fromId": chapter["points"][index]["id"],
                        "toId": chapter["points"][index + 1]["id"],
                    }
                    for chapter in outline["chapters"]
                    for index in range(len(chapter["points"]) - 1)
                ],
            },
            "points": graph_points,
        }
        _write_json(
            self.session_root / "pipeline" / course_id / "clustered-graph.json",
            graph,
        )
        return graph

    def _prepare_review(self, kind: str, course_id: str) -> dict:
        completed = self._run_node(
            PROJECT_ROOT / "scripts" / "prepare-course-review.mjs",
            kind,
            course_id,
        )
        return json.loads(completed.stdout)

    def _submit_only_pending_review(
        self,
        review_store: CourseReviewStore,
        *,
        expected_kind: str,
    ) -> dict:
        pending = review_store.pending_for_conversation(CONVERSATION_ID)
        self.assertEqual(len(pending), 1)
        resource = pending[0]
        self.assertEqual(resource["kind"], expected_kind)
        submitted = review_store.submit(
            resource["id"],
            conversation_id=CONVERSATION_ID,
            revision=resource["revision"],
            artifact_hash=resource["artifact_hash"],
            operations=[],
        )
        self.assertTrue(submitted["ok"])
        self.assertEqual(submitted["review"]["status"], "resolved")
        return submitted

    def test_small_mineru_markdown_reaches_published_forest_with_deterministic_llm_stub(self):
        markdown = SMALL_MINERU_FIXTURE.read_bytes()
        metadata = self.document_store.create_markdown_upload(
            io.BytesIO(markdown),
            filename="full.md",
            content_type="text/markdown",
        )
        parsed = self.document_store.parse(
            metadata["id"],
            parser=parse_markdown_document,
            parser_name="markdown-import",
        )
        self.assertEqual(parsed["document"]["parser"], "markdown-import")

        with patch.object(binding, "get_document_store", return_value=self.document_store):
            binding_result = binding.bind_textbook_workspace(
                self.session_root,
                document_id=metadata["id"],
            )
        self.assertIsNotNone(binding_result)
        assert binding_result is not None
        outline = _read_json(self.session_root / binding_result.output_outline_path)
        material = _read_json(
            self.session_root / str(binding_result.input_material_path)
        )
        self.assertEqual(binding_result.chapter_count, 2)
        self.assertEqual(binding_result.point_count, 4)

        self._install_session_skills()
        content_root, subject, evidence = self._write_index_stage(
            binding_result=binding_result,
            outline=outline,
            material=material,
        )

        textbook_gate = PROJECT_ROOT / "scripts" / "validate-textbook-outline.mjs"
        candidate_validator = (
            PROJECT_ROOT
            / "skills"
            / "candidate-knowledge-point-generator"
            / "scripts"
            / "validate_output.mjs"
        )
        graph_checker = (
            PROJECT_ROOT
            / "skills"
            / "knowledge-cluster-builder"
            / "knowledge-cluster-builder"
            / "scripts"
            / "check-graph.mjs"
        )
        self._run_node(textbook_gate, "outline", binding_result.course_id)
        self._run_node(
            candidate_validator,
            "--root",
            str(content_root),
            "--phase",
            "index",
        )

        g2_prepared = self._prepare_review("knowledge-points", binding_result.course_id)
        self.assertEqual(g2_prepared["status"], "pending")
        review_store = CourseReviewStore(self.workspace_root, PROJECT_ROOT)
        self._submit_only_pending_review(
            review_store,
            expected_kind="knowledge-points",
        )
        g2_approved = self._prepare_review("knowledge-points", binding_result.course_id)
        self.assertEqual(g2_approved["status"], "approved")

        graph = self._write_detail_and_graph_stage(
            course_id=binding_result.course_id,
            content_root=content_root,
            outline=outline,
            subject=subject,
            evidence=evidence,
        )
        self._run_node(
            candidate_validator,
            "--root",
            str(content_root),
            "--phase",
            "all",
        )
        self._run_node(textbook_gate, "graph", binding_result.course_id)
        checked_graph = self._run_node(
            graph_checker,
            str(self.session_root / "pipeline" / binding_result.course_id / "clustered-graph.json"),
            "--json",
        )
        self.assertTrue(json.loads(checked_graph.stdout)["ok"])

        g6_prepared = self._prepare_review("knowledge-graph", binding_result.course_id)
        self.assertEqual(g6_prepared["status"], "pending")
        self._submit_only_pending_review(
            review_store,
            expected_kind="knowledge-graph",
        )
        g6_approved = self._prepare_review("knowledge-graph", binding_result.course_id)
        self.assertEqual(g6_approved["status"], "approved")

        for kind in ("knowledge-points", "knowledge-graph"):
            approval = _read_json(
                self.session_root
                / ".course-review-approvals"
                / binding_result.course_id
                / f"{kind}.json"
            )
            self.assertEqual(approval["schema_version"], "course-review-approval/1.0")
            self.assertEqual(
                approval["textbook_structure_sha256"],
                binding_result.structure_sha256,
            )

        published = self._run_node(
            PROJECT_ROOT / "scripts" / "publish-course-pipeline.mjs",
            binding_result.course_id,
        )
        self.assertEqual(json.loads(published.stdout)["points"], 4)

        output_root = self.session_root / "courses" / binding_result.course_id
        published_index = _read_json(output_root / "index.json")
        self.assertEqual(published_index["sequences"], graph["sequences"])
        self.assertEqual(
            [point.get("origin") for point in published_index["points"]],
            ["textbook"] * 4,
        )
        for item in evidence:
            detail = _read_json(
                output_root / "points" / f"{item['pointId']}.json"
            )
            self.assertEqual(detail["origin"], "textbook")
            self.assertEqual(detail["sourceSpans"], item["sourceSpans"])
            self.assertTrue(detail["modelEnriched"])
            self.assertEqual(
                detail["content"]["schema_version"],
                "textbook-content/2.0",
            )
            self.assertEqual(
                [block["provenance"]["origin"] for block in detail["content"]["blocks"]],
                ["textbook", "model"],
            )


if __name__ == "__main__":
    unittest.main()
