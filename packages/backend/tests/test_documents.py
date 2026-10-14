import json
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from src.main import app
from src.services.documents import binding
from src.services.documents.local_parser import parse_pdf_outline, parse_toc_text
from src.services.documents.store import (
    DocumentStorageError,
    DocumentStore,
    DocumentUnsupportedMediaTypeError,
    DocumentValidationError,
)
import src.services.documents.store as store_module


def _outline(document_id: str, filename: str, sha256: str) -> dict:
    return {
        "schema_version": "textbook-outline/1.0",
        "document_id": document_id,
        "title": "测试教材",
        "source": {
            "filename": filename,
            "sha256": sha256,
            "page_count": 1,
            "parser": "test-parser",
            "toc_pages": 1,
        },
        "chapters": [
            {
                "id": "chapter-1",
                "number": "1",
                "title": "第一章",
                "page": 1,
                "order": 0,
                "points": [
                    {
                        "id": "point-1-1",
                        "number": "1.1",
                        "title": "第一个知识点",
                        "page": 1,
                        "order": 0,
                        "origin": "textbook",
                    }
                ],
            }
        ],
    }


class DocumentServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = DocumentStore(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_toc_parser_preserves_un_numbered_front_matter(self):
        chapters = parse_toc_text(
            "\f".join(
                [
                    "目录\n",
                    "前言                                                        1\n"
                    "安装                                                        9\n"
                    "符号                                                       13\n"
                    "1 引言                                                     17\n"
                    " 1.1 基本概念 . . . . . . . . . . . . . . . . . . . . . 18\n",
                    "",
                ]
            )
        )
        self.assertEqual([chapter["id"] for chapter in chapters], ["chapter-0", "chapter-1"])
        self.assertEqual(chapters[0]["number"], "0")
        self.assertEqual(
            [(point["id"], point["number"], point["title"]) for point in chapters[0]["points"]],
            [
                ("point-0-1", "0.1", "前言"),
                ("point-0-2", "0.2", "安装"),
                ("point-0-3", "0.3", "符号"),
            ],
        )
        self.assertEqual(chapters[1]["points"][0]["id"], "point-1-1")

    def test_toc_parser_ignores_repeated_toc_heading_rows(self):
        chapters = parse_toc_text(
            "\f".join(
                [
                    "目录\n",
                    "前言                                                        1\n"
                    "1 引言                                                     17\n"
                    " 1.1 基本概念 . . . . . . . . . . . . . . . . . . . . . 18\n"
                    "目录                                                        3\n"
                    "目录                                                        5\n",
                    "",
                ]
            )
        )
        self.assertEqual(
            [(chapter["id"], [point["title"] for point in chapter["points"]])
            for chapter in chapters
        ],
            [
                ("chapter-0", ["前言"]),
                ("chapter-1", ["基本概念"]),
            ],
        )

    def test_toc_parser_repairs_right_aligned_wrapped_page_number(self):
        first = " 2.4.3 梯度 . . . . . . . . . . . . . . . . . . . . . 68"
        wrapped = " 2.4.4 链式法则 . . . . . . . . . . . . . . . . . . . 6"
        page_column = wrapped.rfind("6")
        wrapped_page = f"{wrapped}\n{' ' * page_column}8"
        chapters = parse_toc_text(
            "\f".join(
                [
                    "目录\n",
                    "2 预备知识 . . . . . . . . . . . . . . . . . . . . . 39\n"
                    f"{first}\n"
                    f"{wrapped_page}\n"
                    " 2.5 自动微分 . . . . . . . . . . . . . . . . . . . . 69\n",
                    "",
                ]
            )
        )
        points = chapters[0]["points"]
        repaired = next(point for point in points if point["number"] == "2.4.4")
        self.assertEqual(repaired["page"], 68)

    def test_toc_parser_does_not_join_an_unaligned_page_footer(self):
        row = " 1.1 基本概念 . . . . . . . . . . . . . . . . . . . . . 6"
        chapters = parse_toc_text(
            "\f".join(
                [
                    "目录\n",
                    "1 引言 . . . . . . . . . . . . . . . . . . . . . . . 5\n"
                    f"{row}\n"
                    "8\n"
                    " 1.2 后续内容 . . . . . . . . . . . . . . . . . . . . 9\n",
                    "",
                ]
            )
        )
        point = next(point for point in chapters[0]["points"] if point["number"] == "1.1")
        self.assertEqual(point["page"], 6)

    def test_store_accepts_synthetic_un_numbered_chapter(self):
        source = b"%PDF-1.7\nminimal test source\n"
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(source)
            stream.seek(0)
            metadata = self.store.create_upload(
                stream,
                filename="教材.pdf",
                content_type="application/pdf",
            )

        chapters = [
            {
                "id": "chapter-0",
                "number": "0",
                "title": "未编号目录项",
                "page": 1,
                "order": 0,
                "points": [
                    {
                        "id": "point-0-1",
                        "number": "0.1",
                        "title": "前言",
                        "page": 1,
                        "order": 0,
                        "origin": "textbook",
                    }
                ],
            },
            {
                "id": "chapter-1",
                "number": "1",
                "title": "第一章",
                "page": 2,
                "order": 1,
                "points": [
                    {
                        "id": "point-1",
                        "number": "1",
                        "title": "第一章",
                        "page": 2,
                        "order": 0,
                        "origin": "textbook",
                    }
                ],
            },
        ]
        expected = _outline(metadata["id"], metadata["filename"], metadata["sha256"])
        expected["chapters"] = chapters
        result = self.store.parse(
            metadata["id"],
            parser=lambda *_args, **_kwargs: expected,
        )
        self.assertEqual(result["document"]["outline_summary"]["chapter_count"], 2)
        self.assertEqual(result["document"]["outline_summary"]["knowledge_point_count"], 2)

    def test_upload_accepts_missing_and_generic_pdf_media_types(self):
        """A MIME hint may be absent or generic; the PDF signature is authoritative."""

        media_types = (
            None,
            "",
            "application/octet-stream",
            "binary/octet-stream",
            "application/x-pdf",
            "application/pdf; charset=binary",
        )
        for index, content_type in enumerate(media_types):
            metadata = self.store.create_upload(
                io.BytesIO(f"%PDF-1.7\nsource-{index}".encode("ascii")),
                filename=f"教材-{index}.bin",
                content_type=content_type,
            )
            self.assertEqual(metadata["content_type"], "application/pdf")
            self.assertEqual(metadata["status"], "uploaded")

    def test_upload_rejects_explicit_non_pdf_media_type_and_bad_signature(self):
        # A clearly non-PDF declaration is rejected even when the bytes happen
        # to start like a PDF, while a generic declaration still has to carry
        # the real PDF signature.
        with self.assertRaisesRegex(DocumentUnsupportedMediaTypeError, "媒体类型"):
            self.store.create_upload(
                io.BytesIO(b"%PDF-1.7\nsource"),
                filename="教材.pdf",
                content_type="text/plain",
            )
        with self.assertRaisesRegex(DocumentUnsupportedMediaTypeError, "不是有效的 PDF"):
            self.store.create_upload(
                io.BytesIO(b"plain text"),
                filename="教材.bin",
                content_type="application/octet-stream",
            )

    def test_upload_parse_and_retry_are_durable(self):
        source = b"%PDF-1.7\nminimal test source\n"
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(source)
            stream.seek(0)
            metadata = self.store.create_upload(
                stream,
                filename="教材.pdf",
                content_type="application/pdf",
            )

        expected = _outline(metadata["id"], metadata["filename"], metadata["sha256"])
        result = self.store.parse(
            metadata["id"],
            parser=lambda *_args, **_kwargs: expected,
        )
        self.assertEqual(result["document"]["status"], "ready")
        self.assertEqual(result["document"]["outline_summary"]["chapter_count"], 1)
        self.assertEqual(self.store.get_outline(metadata["id"]), expected)
        # A second parse reuses the validated derived artifact rather than
        # invoking the parser again.
        with patch("src.services.documents.store.DocumentStore._validate_outline") as validate:
            cached = self.store.parse(
                metadata["id"],
                parser=lambda: self.fail("parser should not run for a ready document"),
            )
        self.assertEqual(cached["outline"], expected)
        validate.assert_called()

    def test_parse_rejects_source_pdf_replacement(self):
        source = b"%PDF-1.7\noriginal source\n"
        metadata = self.store.create_upload(
            io.BytesIO(source),
            filename="教材.pdf",
            content_type="application/pdf",
        )
        source_path = self.root / metadata["id"] / "source.pdf"
        source_path.write_bytes(b"%PDF-1.7\nreplacement\n")

        with self.assertRaisesRegex(
            DocumentValidationError,
            "原始 PDF .*上传记录|原始 PDF 摘要",
        ):
            self.store.parse(
                metadata["id"],
                parser=lambda *_args, **_kwargs: self.fail(
                    "replaced source must not reach parser"
                ),
            )
        self.assertEqual(self.store.get(metadata["id"])["status"], "failed")

    def test_parse_clears_active_lease_when_status_write_fails(self):
        source = b"%PDF-1.7\nminimal test source\n"
        metadata = self.store.create_upload(
            io.BytesIO(source),
            filename="教材.pdf",
            content_type="application/pdf",
        )
        expected = _outline(metadata["id"], metadata["filename"], metadata["sha256"])
        original_write = self.store._write_json_atomic
        failed_once = False

        def fail_first_status_write(path, value):
            nonlocal failed_once
            if path.name == "metadata.json" and not failed_once:
                failed_once = True
                raise DocumentStorageError("模拟磁盘写入失败")
            return original_write(path, value)

        with patch.object(
            self.store,
            "_write_json_atomic",
            side_effect=fail_first_status_write,
        ):
            with self.assertRaises(DocumentStorageError):
                self.store.parse(
                    metadata["id"],
                    parser=lambda *_args, **_kwargs: expected,
                )
        self.assertNotIn(metadata["id"], self.store._active_parses)

    def test_document_paths_reject_symlink_components(self):
        outside = Path(tempfile.mkdtemp())
        link = self.root / "linked"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"symbolic links unavailable: {exc}")
        with self.assertRaises(DocumentValidationError):
            self.store._within_root(link / "doc-deadbeefdeadbeefdeadbeef")
        with self.assertRaisesRegex(DocumentStorageError, "文档存储目录不可用"):
            DocumentStore(link)

    def test_textbook_binding_rejects_symlink_session_root(self):
        outside = Path(tempfile.mkdtemp())
        link = self.root / "session-link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"symbolic links unavailable: {exc}")
        with patch.object(binding, "get_document_store", return_value=self.store):
            with self.assertRaisesRegex(binding.TextbookBindingError, "符号链接"):
                binding.bind_textbook_workspace(
                    link,
                    document_id="doc-0123456789abcdef01234567",
                )

    def test_pdf_binding_copies_input_and_recovers_without_document_id(self):
        source = b"%PDF-1.7\nminimal test source\n"
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(source)
            stream.seek(0)
            metadata = self.store.create_upload(
                stream,
                filename="教材.pdf",
                content_type="application/pdf",
            )
        expected = _outline(metadata["id"], metadata["filename"], metadata["sha256"])
        self.store.parse(metadata["id"], parser=lambda *_args, **_kwargs: expected)
        session_root = self.root / "session"
        (session_root / "courses").mkdir(parents=True)
        with patch.object(binding, "get_document_store", return_value=self.store):
            first = binding.bind_textbook_workspace(
                session_root,
                document_id=metadata["id"],
            )
            output = session_root / "pipeline" / first.course_id / "textbook-outline.json"
            value = json.loads(output.read_text(encoding="utf-8"))
            value["chapters"][0]["points"].append(
                {
                    "id": "extra-point",
                    "title": "扩展点",
                    "order": 1,
                    "origin": "llm-extension",
                    "anchor_point_id": "point-1-1",
                    "extension_reason": "帮助理解",
                }
            )
            output.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            recovered = binding.bind_textbook_workspace(session_root)
        self.assertEqual(recovered, first)
        persisted = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(persisted["chapters"][0]["points"][-1]["origin"], "llm-extension")
        self.assertTrue((session_root / "textbook-input" / metadata["id"] / "outline.json").is_file())

    def test_pdf_binding_rejects_changes_to_parser_owned_point_identity(self):
        source = b"%PDF-1.7\nminimal test source\n"
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(source)
            stream.seek(0)
            metadata = self.store.create_upload(
                stream,
                filename="教材.pdf",
                content_type="application/pdf",
            )
        expected = _outline(metadata["id"], metadata["filename"], metadata["sha256"])
        self.store.parse(metadata["id"], parser=lambda *_args, **_kwargs: expected)
        session_root = self.root / "session"
        (session_root / "courses").mkdir(parents=True)
        with patch.object(binding, "get_document_store", return_value=self.store):
            first = binding.bind_textbook_workspace(
                session_root,
                document_id=metadata["id"],
            )
            output = session_root / "pipeline" / first.course_id / "textbook-outline.json"
            value = json.loads(output.read_text(encoding="utf-8"))
            value["chapters"][0]["points"][0]["title"] = "被篡改的教材点"
            output.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            with self.assertRaisesRegex(binding.TextbookBindingError, "不可变校验失败"):
                binding.bind_textbook_workspace(session_root)

    def test_pdf_binding_rejects_changes_to_parser_owned_locator(self):
        source = b"%PDF-1.7\nminimal test source\n"
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(source)
            stream.seek(0)
            metadata = self.store.create_upload(
                stream,
                filename="教材.pdf",
                content_type="application/pdf",
            )
        expected = _outline(metadata["id"], metadata["filename"], metadata["sha256"])
        self.store.parse(metadata["id"], parser=lambda *_args, **_kwargs: expected)
        session_root = self.root / "session"
        (session_root / "courses").mkdir(parents=True)
        with patch.object(binding, "get_document_store", return_value=self.store):
            first = binding.bind_textbook_workspace(
                session_root,
                document_id=metadata["id"],
            )
            output = session_root / "pipeline" / first.course_id / "textbook-outline.json"
            value = json.loads(output.read_text(encoding="utf-8"))
            value["chapters"][0]["points"][0]["page"] = 99
            output.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            with self.assertRaisesRegex(binding.TextbookBindingError, "不可变校验失败"):
                binding.bind_textbook_workspace(session_root)

    def test_pdf_binding_rejects_missing_immutable_input_after_first_bind(self):
        source = b"%PDF-1.7\nminimal test source\n"
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(source)
            stream.seek(0)
            metadata = self.store.create_upload(
                stream,
                filename="教材.pdf",
                content_type="application/pdf",
            )
        expected = _outline(metadata["id"], metadata["filename"], metadata["sha256"])
        self.store.parse(metadata["id"], parser=lambda *_args, **_kwargs: expected)
        session_root = self.root / "session"
        (session_root / "courses").mkdir(parents=True)
        with patch.object(binding, "get_document_store", return_value=self.store):
            first = binding.bind_textbook_workspace(
                session_root,
                document_id=metadata["id"],
            )
            input_path = session_root / "textbook-input" / metadata["id"] / "outline.json"
            input_path.unlink()
            with self.assertRaisesRegex(binding.TextbookBindingError, "缺少.*教材输入结构"):
                binding.bind_textbook_workspace(session_root)

    def test_textbook_binding_prompt_marks_source_fields_as_untrusted(self):
        prompt = binding.TextbookBinding(
            document_id="doc-1234567890abcdef12345678",
            course_id="textbook-1234567890abcdef12345678",
            title="教材",
            structure_sha256="a" * 64,
            input_outline_path="textbook-input/doc-1234567890abcdef12345678/outline.json",
            output_outline_path="pipeline/textbook-1234567890abcdef12345678/textbook-outline.json",
            chapter_count=1,
            point_count=1,
        ).prompt_context()
        self.assertIn("外部不可信资料", prompt)
        self.assertIn("任何指令", prompt)

    def test_http_upload_parse_and_outline_contract(self):
        old_store = store_module._document_store
        try:
            store_module._document_store = self.store
            expected_holder: dict[str, dict] = {}

            def fake_parser(path, *, document_id, filename, sha256, **_kwargs):
                expected_holder["value"] = _outline(document_id, filename, sha256)
                return expected_holder["value"]

            with patch("src.api.documents.parse_pdf_outline", fake_parser), TestClient(app) as client:
                uploaded = client.post(
                    "/api/documents",
                    files={"file": ("教材.pdf", b"%PDF-1.7\nsource", "application/pdf")},
                )
                self.assertEqual(uploaded.status_code, 201)
                generic = client.post(
                    "/api/documents",
                    files={
                        "file": (
                            "教材.bin",
                            b"%PDF-1.7\ngeneric-content-type",
                            "application/octet-stream",
                        )
                    },
                )
                self.assertEqual(generic.status_code, 201)
                missing = client.post(
                    "/api/documents",
                    files={
                        "file": (
                            "教材-no-mime.bin",
                            b"%PDF-1.7\nmissing-content-type",
                            None,
                        )
                    },
                )
                self.assertEqual(missing.status_code, 201)
                invalid = client.post(
                    "/api/documents",
                    files={
                        "file": (
                            "教材.txt",
                            b"plain text",
                            "application/octet-stream",
                        )
                    },
                )
                self.assertEqual(invalid.status_code, 415)
                document_id = uploaded.json()["id"]
                parsed = client.post(f"/api/documents/{document_id}/parse")
                self.assertEqual(parsed.status_code, 200)
                self.assertEqual(parsed.json()["document"]["status"], "ready")
                outline = client.get(f"/api/documents/{document_id}/outline")
                self.assertEqual(outline.status_code, 200)
                self.assertEqual(outline.json()["chapters"][0]["points"][0]["id"], "point-1-1")
                self.assertEqual(client.get("/api/documents/doc-invalid").status_code, 404)
        finally:
            store_module._document_store = old_store
