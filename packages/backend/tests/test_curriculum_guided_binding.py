from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.services.documents import curriculum_binding


TEXTBOOK_ID = "doc-0123456789abcdef01234567"
CURRICULUM_ID = "curr-0123456789abcdef01234567"


class _TextbookStore:
    def get(self, document_id: str):
        assert document_id == TEXTBOOK_ID
        return {
            "id": document_id,
            "status": "ready",
            "filename": "人工智能教材.md",
            "sha256": "a" * 64,
            "content_type": "text/markdown",
            "parser": "test",
        }

    def get_outline(self, document_id: str):
        return {
            "schema_version": "textbook-outline/1.0",
            "document_id": document_id,
            "title": "人工智能导论",
            "source": {"filename": "人工智能教材.md", "sha256": "a" * 64},
            "chapters": [{
                "id": "chapter-1",
                "title": "基础",
                "points": [{"id": "ai-basics", "title": "人工智能基础"}],
            }],
        }

    def get_material(self, _document_id: str):
        return {
            "schema_version": "textbook-material/1.0",
            "sections": [{
                "id": "block-1",
                "heading_path": ["基础"],
                "line_start": 1,
                "line_end": 3,
                "asset_refs": [],
                "sha256": "b" * 64,
            }],
            "point_sources": [{
                "point_id": "ai-basics",
                "section_ids": ["block-1"],
            }],
        }

    def get_markdown(self, _document_id: str):
        return "# 基础\n\n人工智能基础。\n"


class _CurriculumStore:
    def get(self, document_id: str):
        assert document_id == CURRICULUM_ID
        return {
            "id": document_id,
            "status": "ready",
            "filename": "教学大纲.docx",
            "sha256": "c" * 64,
        }

    def get_requirements(self, document_id: str):
        return {
            "schema_version": "curriculum-requirements/1.0",
            "document_id": document_id,
            "document_type": "syllabus",
            "title": "人工智能导论教学大纲",
            "source": {"sha256": "c" * 64},
            "course_goals": ["掌握人工智能基础"],
            "prerequisites": [],
            "content_units": [],
            "requirements": [{
                "id": "req-1",
                "text": "理解人工智能基本概念",
                "level": "understand",
                "level_label": "理解",
                "kind": "knowledge",
                "priority": "core",
                "source": {},
            }],
            "experiments": [],
            "warnings": [],
            "summary": {},
        }

    def get_markdown(self, _document_id: str):
        return "# 教学大纲\n\n理解人工智能基本概念。\n"


class CurriculumGuidedBindingTests(unittest.TestCase):
    def test_first_bind_resume_and_source_change_rejection(self):
        with tempfile.TemporaryDirectory() as temporary:
            session_root = Path(temporary) / "session"
            session_root.mkdir()
            with (
                patch.object(
                    curriculum_binding,
                    "get_document_store",
                    return_value=_TextbookStore(),
                ),
                patch(
                    "src.services.curricula.get_curriculum_store",
                    return_value=_CurriculumStore(),
                ),
            ):
                first = curriculum_binding.bind_curriculum_guided_workspace(
                    session_root,
                    textbook_document_id=TEXTBOOK_ID,
                    curriculum_document_id=CURRICULUM_ID,
                )
                recovered = curriculum_binding.bind_curriculum_guided_workspace(
                    session_root
                )
                self.assertEqual(recovered, first)
                with self.assertRaisesRegex(
                    curriculum_binding.CurriculumGuidedBindingError,
                    "另一组",
                ):
                    curriculum_binding.bind_curriculum_guided_workspace(
                        session_root,
                        textbook_document_id=TEXTBOOK_ID,
                        curriculum_document_id="curr-fedcba9876543210fedcba98",
                    )

            binding_path = session_root / "curriculum-guided-binding.json"
            persisted = json.loads(binding_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["schema_version"], "curriculum-guided-binding/1.0")
            self.assertTrue((
                session_root
                / "curriculum-guided-input"
                / "textbook"
                / TEXTBOOK_ID
                / "outline.json"
            ).is_file())
            self.assertFalse((session_root / "textbook-binding.json").exists())
            self.assertFalse((
                session_root
                / "pipeline"
                / first.course_id
                / "textbook-outline.json"
            ).exists())


if __name__ == "__main__":
    unittest.main()
