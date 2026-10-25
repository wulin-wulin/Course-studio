from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.services.documents.markdown_parser import build_markdown_artifacts
from src.services.documents.mineru_artifacts import (
    _find_chapter_sections,
    _is_auxiliary_boundary_title,
)
from src.services.documents.store import DocumentStore, DocumentValidationError


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "mineru" / "structure_cases"


class MinerUArtifactIntegrationTest(unittest.TestCase):
    def test_matching_ignores_numbered_cross_reference_before_real_chapter(self):
        markdown = "\n".join(
            [
                "# Book",
                "## 1. Introduction",
                "## 1. Physical layer",
                "## Physical layer",
                "### 2.1 Physical layer protocols",
            ]
        )
        _outline, material = build_markdown_artifacts(
            markdown,
            document_id="doc-heading-match",
            filename="book.md",
            sha256="0" * 64,
            parser_name="mineru-vlm",
        )
        candidate = {
            "chapters": [
                {"number": "1", "title": "Introduction"},
                {"number": "2", "title": "Physical layer"},
            ]
        }

        matched = _find_chapter_sections(markdown, candidate, material["sections"])

        self.assertEqual([item[1].line for item in matched], [2, 4])

    def test_bare_chapter_marker_and_first_point_are_valid_fallbacks(self):
        markdown = "\n".join(
            [
                "# Book",
                "## 1. Introduction",
                "### 1.1 Basics",
                "## \u7b2c 2 \u7ae0",
                "## 2.1 Physical layer protocols",
            ]
        )
        _outline, material = build_markdown_artifacts(
            markdown,
            document_id="doc-heading-marker",
            filename="book.md",
            sha256="0" * 64,
            parser_name="mineru-vlm",
        )
        candidate = {
            "chapters": [
                {"number": "1", "title": "Introduction"},
                {"number": "2", "title": "Physical layer"},
            ]
        }

        matched = _find_chapter_sections(markdown, candidate, material["sections"])

        self.assertEqual([item[1].line for item in matched], [2, 4])

    def test_body_index_heading_does_not_end_chapter_search(self):
        self.assertFalse(
            _is_auxiliary_boundary_title("\u7d22\u5f15\u7684\u5efa\u7acb\u4e0e\u5220\u9664")
        )
        self.assertTrue(_is_auxiliary_boundary_title("\u7d22\u5f15"))

    def test_duplicate_title_prefers_anchor_followed_by_first_point(self):
        markdown = "\n".join(
            [
                "# Book",
                "## 1. Introduction",
                "## Physical layer",
                "## Physical layer",
                "### 2.1 Physical layer protocols",
                "## \u9644\u5f55",
                "## Physical layer",
            ]
        )
        _outline, material = build_markdown_artifacts(
            markdown,
            document_id="doc-heading-duplicate",
            filename="book.md",
            sha256="0" * 64,
            parser_name="mineru-vlm",
        )
        candidate = {
            "chapters": [
                {"number": "1", "title": "Introduction"},
                {"number": "2", "title": "Physical layer"},
            ]
        }

        matched = _find_chapter_sections(markdown, candidate, material["sections"])

        # The first identical heading is a cross-reference. The second one
        # is immediately followed by 2.1 and must become the chapter anchor;
        # the copy after the appendix is outside the searchable body.
        self.assertEqual([item[1].line for item in matched], [2, 4])

    def test_matching_backtracks_when_late_exact_copy_would_break_order(self):
        markdown = "\n".join(
            [
                "# Book",
                "## 1. Introduction",
                "## 第 2 章",
                "## 3. Transport",
                "## 2. Physical layer",
            ]
        )
        _outline, material = build_markdown_artifacts(
            markdown,
            document_id="doc-heading-order",
            filename="book.md",
            sha256="0" * 64,
            parser_name="mineru-vlm",
        )
        candidate = {
            "chapters": [
                {"number": "1", "title": "Introduction"},
                {"number": "2", "title": "Physical layer"},
                {"number": "3", "title": "Transport"},
            ]
        }

        matched = _find_chapter_sections(markdown, candidate, material["sections"])

        # The later exact copy for chapter 2 scores higher locally, but it
        # would make chapter 3 impossible. The global monotonic matcher falls
        # back to the earlier bare chapter marker.
        self.assertEqual([item[1].line for item in matched], [2, 3, 4])

    def test_store_promotes_evidence_checked_seven_chapter_structure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            content = json.loads(
                (FIXTURE_ROOT / "seven_chapter_content_list.json").read_text(
                    encoding="utf-8"
                )
            )
            markdown_bytes = (FIXTURE_ROOT / "seven_chapter_full.md").read_bytes()
            markdown = markdown_bytes.decode("utf-8")
            raw_digest = hashlib.sha256(markdown_bytes).hexdigest()
            store = DocumentStore(root / "library")
            upload = store.create_upload(
                io.BytesIO(b"%PDF- synthetic source"),
                filename="textbook.pdf",
                content_type="application/pdf",
            )

            def parser(path: Path, *, document_id: str, filename: str, sha256: str, **_kwargs):
                raw = path.parent / "mineru-vlm"
                raw.mkdir(parents=True, exist_ok=True)
                (raw / "full.md").write_bytes(markdown_bytes)
                (raw / "content-list.json").write_text(
                    json.dumps(content, ensure_ascii=False), encoding="utf-8"
                )
                # Deliberately return a bad native TOC. The store must use the
                # evidence candidate, not silently derive a five-root outline.
                return {
                    "schema_version": "textbook-outline/1.0",
                    "document_id": document_id,
                    "title": "Textbook",
                    "source": {
                        "filename": filename,
                        "sha256": sha256,
                        "parser": "mineru-vlm",
                        "page_count": 241,
                        "toc_pages": 40,
                    },
                    "chapters": [
                        {
                            "id": "chapter-0",
                            "number": "0",
                            "title": "bad native toc",
                            "page": 1,
                            "order": 0,
                            "points": [
                                {
                                    "id": "point-0-1",
                                    "number": "0.1",
                                    "title": "bad point",
                                    "page": 1,
                                    "order": 0,
                                    "origin": "textbook",
                                }
                            ],
                        }
                    ],
                }

            with patch(
                "src.services.documents.structure_llm.ai_router.get_provider"
            ) as get_provider:
                result = store.parse(
                    upload["id"], parser=parser, parser_name="mineru-vlm"
                )
                get_provider.assert_not_called()
            self.assertEqual(result["document"]["status"], "ready")
            self.assertEqual(result["document"]["outline_summary"]["chapter_count"], 7)
            self.assertEqual(result["document"]["outline_summary"]["knowledge_point_count"], 7)
            self.assertEqual(
                [chapter["number"] for chapter in result["outline"]["chapters"]],
                [str(index) for index in range(1, 8)],
            )
            material = store.get_material(upload["id"])
            outline_ids = {
                point["id"]
                for chapter in result["outline"]["chapters"]
                for point in chapter["points"]
            }
            self.assertEqual(
                outline_ids,
                {item["point_id"] for item in material["point_sources"]},
            )
            referenced_sections = {
                section_id
                for item in material["point_sources"]
                for section_id in item["section_ids"]
            }
            auxiliary_titles = {
                section["title"]
                for section in material["sections"]
                if section["id"] not in referenced_sections
            }
            self.assertTrue(any("附录" in title for title in auxiliary_titles))
            self.assertTrue(any("参考文献" in title for title in auxiliary_titles))
            raw = root / "library" / upload["id"] / "mineru-vlm"
            self.assertEqual(
                hashlib.sha256((raw / "full.md").read_bytes()).hexdigest(),
                raw_digest,
            )
            self.assertTrue((raw / "structure-candidate.json").is_file())

            # A previously generated ready cache without the evidence sidecar
            # must not remain readable as if its old outline were authoritative.
            (raw / "structure-candidate.json").unlink()
            with self.assertRaises(DocumentValidationError):
                store.get_outline(upload["id"])


if __name__ == "__main__":
    unittest.main()
