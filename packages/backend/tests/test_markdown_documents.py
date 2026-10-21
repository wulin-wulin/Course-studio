import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from src.main import app
from src.services.documents import binding
from src.services.documents.markdown_parser import (
    build_markdown_artifacts,
    parse_markdown_document,
)
from src.services.documents.store import (
    DocumentConflictError,
    DocumentStore,
    DocumentUnsupportedMediaTypeError,
)
import src.services.documents.store as store_module


MARKDOWN = """# 栈与队列入门

## 第一章 栈的基础

本章解释后进先出结构。

### 1.1 栈的定义

栈只允许在一端进行插入和删除。

![栈示意图](images/stack.png)

### 1.2 入栈与出栈

入栈修改栈顶，出栈返回栈顶元素。

## 第二章 队列的基础

### 2.1 队列的定义

队列遵循先进先出原则。
"""


class MarkdownDocumentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = DocumentStore(self.root / "library")

    def _upload_and_parse(self, content_type: str = "text/markdown"):
        metadata = self.store.create_markdown_upload(
            io.BytesIO(MARKDOWN.encode("utf-8")),
            filename="栈与队列.md",
            content_type=content_type,
        )
        result = self.store.parse(
            metadata["id"],
            parser=parse_markdown_document,
            parser_name="markdown-import",
        )
        return metadata, result

    def test_markdown_import_produces_outline_and_line_addressable_material(self):
        metadata, result = self._upload_and_parse("text/plain")

        self.assertEqual(result["document"]["content_type"], "text/markdown")
        self.assertEqual(result["document"]["parser"], "markdown-import")
        outline = result["outline"]
        self.assertEqual(outline["title"], "栈与队列入门")
        self.assertEqual([chapter["title"] for chapter in outline["chapters"]], [
            "栈的基础",
            "队列的基础",
        ])
        self.assertEqual(
            [point["title"] for chapter in outline["chapters"] for point in chapter["points"]],
            ["栈的定义", "入栈与出栈", "队列的定义"],
        )
        self.assertTrue(outline["chapters"][0]["points"][0]["source_refs"])

        material = self.store.get_material(metadata["id"])
        self.assertEqual(material["schema_version"], "textbook-material/1.0")
        self.assertGreaterEqual(len(material["sections"]), 5)
        self.assertGreaterEqual(len(material["chunks"]), len(material["sections"]))
        first_point = material["point_sources"][0]
        self.assertTrue(first_point["section_ids"])
        self.assertTrue(first_point["chunk_ids"])
        stack_section = next(
            section for section in material["sections"] if section["title"] == "栈的定义"
        )
        self.assertEqual(stack_section["asset_refs"], ["images/stack.png"])
        self.assertLessEqual(stack_section["line_start"], stack_section["line_end"])
        self.assertEqual(len(stack_section["sha256"]), 64)
        self.assertEqual(self.store.get_markdown(metadata["id"]), MARKDOWN)

    def test_large_mineru_fixture_recovers_numbered_tree_and_point_subtrees(self):
        fixture_root = Path(__file__).parent / "fixtures" / "mineru" / "large"
        markdown = (fixture_root / "full.md").read_text(encoding="utf-8")
        expected = json.loads(
            (fixture_root / "expected.json").read_text(encoding="utf-8")
        )

        outline, material = build_markdown_artifacts(
            markdown,
            document_id="doc-large-mineru-fixture",
            filename="full.md",
            sha256=expected["artifacts"]["full.md"],
        )

        self.assertEqual(outline["title"], expected["title"])
        self.assertEqual(
            [
                {
                    "number": chapter["number"],
                    "title": chapter["title"],
                    "point_numbers": [point["number"] for point in chapter["points"]],
                }
                for chapter in outline["chapters"]
            ],
            [
                {
                    "number": chapter["number"],
                    "title": chapter["title"],
                    "point_numbers": chapter["point_numbers"],
                }
                for chapter in expected["chapters"]
            ],
        )

        points = [
            point
            for chapter in outline["chapters"]
            for point in chapter["points"]
        ]
        self.assertEqual(
            [point["title"] for point in points], expected["textbook_points"]
        )
        node_titles = {
            chapter["title"] for chapter in outline["chapters"]
        } | {point["title"] for point in points}
        self.assertNotIn(expected["title"], node_titles)
        self.assertTrue(
            node_titles.isdisjoint(set(expected["outline_only_headings"]))
        )

        sections = material["sections"]
        sections_by_id = {section["id"]: section for section in sections}
        sources_by_point = {
            source["point_id"]: source for source in material["point_sources"]
        }
        for point in points:
            source = sources_by_point[point["id"]]
            self.assertEqual(point["source_refs"], source["section_ids"])
            source_ids = set(source["section_ids"])
            own_section = next(
                section for section in sections if section["title"] == point["title"]
            )
            self.assertIn(own_section["id"], source_ids)

            descendants: list[str] = []
            for section in sections[own_section["order"] + 1 :]:
                if section["heading_level"] <= own_section["heading_level"]:
                    break
                descendants.append(section["id"])
            self.assertTrue(descendants)
            self.assertTrue(set(descendants).issubset(source_ids))
            self.assertIn(
                "推演、边界与自查",
                [sections_by_id[section_id]["title"] for section_id in descendants],
            )

            expected_chunks = [
                chunk["id"]
                for section_id in source["section_ids"]
                for chunk in material["chunks"]
                if section_id in chunk["section_ids"]
            ]
            self.assertEqual(source["chunk_ids"], expected_chunks)

    def test_markdown_binding_copies_immutable_material_and_markdown(self):
        metadata, _result = self._upload_and_parse()
        session_root = self.root / "session"
        session_root.mkdir()
        with patch.object(binding, "get_document_store", return_value=self.store):
            bound = binding.bind_textbook_workspace(
                session_root,
                document_id=metadata["id"],
            )

        self.assertIsNotNone(bound.input_material_path)
        self.assertIsNotNone(bound.input_markdown_path)
        material_path = session_root / str(bound.input_material_path)
        markdown_path = session_root / str(bound.input_markdown_path)
        self.assertTrue(material_path.is_file())
        self.assertTrue(markdown_path.is_file())
        self.assertIn("point_sources", json.loads(material_path.read_text(encoding="utf-8")))
        self.assertIn("material.point_sources", bound.prompt_context())
        workflow = json.loads(
            (session_root / bound.output_outline_path).read_text(encoding="utf-8")
        )
        self.assertTrue(workflow["chapters"][0]["points"][0]["source_refs"])

    def test_markdown_upload_rejects_non_utf8_content(self):
        with self.assertRaises(DocumentUnsupportedMediaTypeError):
            self.store.create_markdown_upload(
                io.BytesIO(b"\xff\xfe\x00"),
                filename="bad.md",
                content_type="text/markdown",
            )

    def test_markdown_upload_accepts_browser_x_markdown_media_type(self):
        metadata = self.store.create_markdown_upload(
            io.BytesIO(MARKDOWN.encode("utf-8")),
            filename="教材.markdown",
            content_type="text/x-markdown",
        )
        self.assertEqual(metadata["content_type"], "text/markdown")

    def test_content_addressed_identity_rejects_cross_format_collision(self):
        content = b"%PDF-\n# 1 Chapter\n\n## 1.1 Point\n"
        self.store.create_markdown_upload(
            io.BytesIO(content),
            filename="教材.md",
            content_type="text/markdown",
        )
        with self.assertRaises(DocumentConflictError):
            self.store.create_upload(
                io.BytesIO(content),
                filename="教材.pdf",
                content_type="application/pdf",
            )

    def test_http_document_endpoint_routes_markdown_to_local_parser(self):
        previous = store_module._document_store
        try:
            store_module._document_store = self.store
            with (
                patch("src.api.documents.settings.document_parser", "mineru"),
                TestClient(app) as client,
            ):
                upload = client.post(
                    "/api/documents",
                    files={"file": ("教材.md", MARKDOWN.encode("utf-8"), "text/plain")},
                )
                self.assertEqual(upload.status_code, 201, upload.text)
                document_id = upload.json()["id"]
                parsed = client.post(f"/api/documents/{document_id}/parse")
                self.assertEqual(parsed.status_code, 200, parsed.text)
                self.assertEqual(parsed.json()["document"]["parser"], "markdown-import")
                material = client.get(f"/api/documents/{document_id}/material")
                self.assertEqual(material.status_code, 200, material.text)
                markdown = client.get(f"/api/documents/{document_id}/markdown")
                self.assertEqual(markdown.status_code, 200, markdown.text)
                self.assertTrue(markdown.headers["content-type"].startswith("text/markdown"))
                self.assertIn("栈只允许", markdown.text)
        finally:
            store_module._document_store = previous


if __name__ == "__main__":
    unittest.main()
