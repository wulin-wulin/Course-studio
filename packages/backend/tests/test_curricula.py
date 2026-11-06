import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from fastapi.testclient import TestClient

from src.main import app
from src.services.curricula import (
    CurriculumStore,
    CurriculumUnsupportedMediaTypeError,
)
from src.services.curricula.parser import SourceBlock, build_requirements


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"""

PACKAGE_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"""


def _paragraph(text: str) -> str:
    return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"


def make_docx(*, external_relationship: bool = False) -> bytes:
    body = "".join(
        _paragraph(text)
        for text in (
            "机器学习课程教学大纲",
            "第一章 机器学习基础（4学时）",
            "【教学内容】",
            "1.1 机器学习基本概念",
            "1.2 聚类算法",
            "【教学要求】",
            "了解：机器学习的主要分类",
            "掌握：使用 K-means 完成聚类分析",
            "教学媒体",
            "网络课程用于辅助教学",
        )
    )
    document = f"""<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>{body}<w:sectPr/></w:body>
</w:document>
"""
    document_rels = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/prompt" TargetMode="External"/>
</Relationships>
"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", PACKAGE_RELS)
        archive.writestr("word/document.xml", document)
        if external_relationship:
            archive.writestr("word/_rels/document.xml.rels", document_rels)
    return buffer.getvalue()


def build_guidance(*blocks: SourceBlock):
    return build_requirements(
        list(blocks),
        document_id="curr-" + "a" * 24,
        filename="教学大纲.docx",
        content_type=(
            "application/vnd.openxmlformats-officedocument."
            "wordprocessingml.document"
        ),
        sha256="0" * 64,
        page_count=None,
    )


class CurriculumParserTest(unittest.TestCase):
    def test_docx_module_topics_reset_after_key_and_difficult_sections(self):
        def block(text: str, line: int, style: str = "") -> SourceBlock:
            return SourceBlock(text, {"type": "docx", "block": line}, style=style)

        guidance = build_guidance(
            block("《AI 传媒导论》教学大纲", 1, "Heading1"),
            block("五、各章节内容", 2, "Heading2"),
            block("模块一 AI 传媒基础（10学时）", 3, "Heading3"),
            block("教学重点：生成式媒体的基本原理", 4),
            block("教学难点：人机协作边界", 5),
            block("第一讲 AI 传媒概论", 6, "Heading4"),
            block("生成式媒体与传统媒体的差异", 7, "ListParagraph"),
            block("教学媒体", 8, "Heading2"),
            block("多媒体课件与网络课程", 9, "ListParagraph"),
        )

        self.assertEqual(guidance["title"], "AI 传媒导论")
        self.assertEqual(len(guidance["content_units"]), 1)
        unit = guidance["content_units"][0]
        self.assertEqual(
            [topic["text"] for topic in unit["topics"]],
            ["第一讲 AI 传媒概论", "生成式媒体与传统媒体的差异"],
        )
        self.assertNotIn("多媒体课件与网络课程", str(guidance))
        self.assertGreaterEqual(len(guidance["requirements"]), 4)

    def test_requirement_headings_and_level_legends_are_distinguished(self):
        def block(text: str, line: int, style: str = "") -> SourceBlock:
            return SourceBlock(text, {"type": "docx", "block": line}, style=style)

        guidance = build_guidance(
            block("机器学习课程教学大纲", 1, "Heading1"),
            block("知识要求", 2, "Heading2"),
            block("1. 了解：能正确判别有关概念和方法。", 3),
            block("2. 理解：能正确表达有关概念和方法的含义。", 4),
            block("3. 掌握：在理解的基础上加以灵活应用。", 5),
            block("掌握：神经网络的基本结构与训练过程", 6),
        )

        self.assertEqual(
            [item["text"] for item in guidance["requirements"]],
            ["神经网络的基本结构与训练过程"],
        )
        self.assertEqual(guidance["course_goals"], [])


class CurriculumStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.store = CurriculumStore(Path(self.temporary.name))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def upload_docx(self):
        return self.store.create_upload(
            io.BytesIO(make_docx()),
            filename="机器学习教学大纲.docx",
            content_type=(
                "application/vnd.openxmlformats-officedocument."
                "wordprocessingml.document"
            ),
        )

    def test_docx_round_trip_extracts_only_knowledge_adjustment_guidance(self):
        uploaded = self.upload_docx()
        self.assertEqual(uploaded["status"], "uploaded")

        ready = self.store.parse(uploaded["id"])
        self.assertEqual(ready["status"], "ready")
        self.assertEqual(ready["requirements_summary"]["unit_count"], 1)

        requirements = self.store.get_requirements(uploaded["id"])
        self.assertEqual(requirements["schema_version"], "curriculum-requirements/1.0")
        self.assertEqual(
            [item["level"] for item in requirements["requirements"]],
            ["awareness", "mastery"],
        )
        self.assertEqual(
            [item["text"] for item in requirements["content_units"][0]["topics"]],
            ["机器学习基本概念", "聚类算法"],
        )
        serialized = str(requirements)
        self.assertNotIn("网络课程用于辅助教学", serialized)
        self.assertIn("机器学习基本概念", self.store.get_markdown(uploaded["id"]))

    def test_rejects_external_docx_relationships(self):
        with self.assertRaisesRegex(
            CurriculumUnsupportedMediaTypeError,
            "外部链接关系",
        ):
            self.store.create_upload(
                io.BytesIO(make_docx(external_relationship=True)),
                filename="大纲.docx",
                content_type=(
                    "application/vnd.openxmlformats-officedocument."
                    "wordprocessingml.document"
                ),
            )

    def test_rejects_legacy_doc_with_conversion_instruction(self):
        with self.assertRaisesRegex(CurriculumUnsupportedMediaTypeError, "另存为 DOCX"):
            self.store.create_upload(
                io.BytesIO(b"legacy-doc"),
                filename="培养方案.doc",
                content_type="application/msword",
            )

    def test_ready_parse_is_idempotent(self):
        uploaded = self.upload_docx()
        first = self.store.parse(uploaded["id"])
        second = self.store.parse(uploaded["id"])
        self.assertEqual(first, second)

    def test_stale_parsing_status_recovers_after_restart(self):
        uploaded = self.upload_docx()
        metadata_path = self.store.root / uploaded["id"] / "metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["status"] = "parsing"
        metadata_path.write_text(
            json.dumps(metadata, ensure_ascii=False),
            encoding="utf-8",
        )
        self.assertEqual(self.store.parse(uploaded["id"])["status"], "ready")


class CurriculumApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.store = CurriculumStore(Path(self.temporary.name))
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()
        self.temporary.cleanup()

    def test_upload_parse_and_read_requirements(self):
        with patch("src.api.curricula.get_curriculum_store", return_value=self.store):
            upload = self.client.post(
                "/api/curricula",
                files={
                    "file": (
                        "机器学习教学大纲.docx",
                        make_docx(),
                        "application/vnd.openxmlformats-officedocument."
                        "wordprocessingml.document",
                    )
                },
            )
            self.assertEqual(upload.status_code, 201, upload.text)
            document_id = upload.json()["id"]

            parsed = self.client.post(f"/api/curricula/{document_id}/parse")
            self.assertEqual(parsed.status_code, 200, parsed.text)
            self.assertEqual(parsed.json()["status"], "ready")

            requirements = self.client.get(
                f"/api/curricula/{document_id}/requirements"
            )
            self.assertEqual(requirements.status_code, 200, requirements.text)
            self.assertEqual(
                requirements.json()["summary"]["requirement_count"],
                2,
            )

            markdown = self.client.get(f"/api/curricula/{document_id}/markdown")
            self.assertEqual(markdown.status_code, 200, markdown.text)
            self.assertIn("机器学习基本概念", markdown.text)

    def test_old_doc_returns_415(self):
        with patch("src.api.curricula.get_curriculum_store", return_value=self.store):
            response = self.client.post(
                "/api/curricula",
                files={"file": ("旧大纲.doc", b"legacy", "application/msword")},
            )
        self.assertEqual(response.status_code, 415)
        self.assertIn("DOCX", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
