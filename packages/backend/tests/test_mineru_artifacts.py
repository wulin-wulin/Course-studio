from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.services.documents.store import DocumentStore, DocumentValidationError


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "mineru" / "structure_cases"


class MinerUArtifactIntegrationTest(unittest.TestCase):
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
