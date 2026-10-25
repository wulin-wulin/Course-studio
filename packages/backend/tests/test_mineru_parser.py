import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

import httpx
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, NumberObject

from src.api import documents as api
from src.services.documents import mineru_parser as mineru
from src.services.documents.store import (
    DocumentParseError, DocumentParserUnavailableError, DocumentStore,
    DocumentValidationError,
)


class MinerUParserTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.pdf"
        self.write_pdf(3)

    def write_pdf(self, count):
        with PdfWriter() as writer:
            for index in range(count):
                page = writer.add_blank_page(width=612, height=792)
                page[NameObject("/TestPage")] = NumberObject(index)
            writer.write(self.source)

    def test_500_pages_split_parallel_upload_and_ordered_merge(self):
        self.write_pdf(500)
        uploads = {}
        archives = {}
        downloads = []
        upload_barrier = threading.Barrier(5, timeout=10)
        downloaded = {f"part-{index:04d}": threading.Event() for index in range(2, 6)}
        toc = "目录\n1 数组 …… 2\n1.1 下标 …… 2\n2 查找 …… 201\n2.1 二分 …… 201"

        def handle(request):
            name = request.url.path.rsplit("/", 1)[-1]
            if request.method == "POST":
                self.assertEqual(request.headers["authorization"], "Bearer test-secret")
                file = json.loads(request.content)["files"][0]
                name = Path(file["name"]).stem
                self.assertEqual(file["data_id"], f"doc-test-{name}")
                return httpx.Response(200, json={"code": 0, "data": {
                    "batch_id": name, "file_urls": [f"https://storage.test/upload/{name}"],
                }})
            if request.method == "PUT":
                self.assertNotIn("authorization", request.headers)
                reader = PdfReader(io.BytesIO(request.content))
                uploads[name] = [int(page["/TestPage"]) for page in reader.pages]
                blocks = [{"type": "text", "page_idx": index, "text": f"PDF page {original + 1}"}
                          for index, original in enumerate(uploads[name])]
                if name == "part-0001":
                    blocks.insert(0, {"type": "text", "page_idx": 0, "text": toc})
                markdown = "\n".join(block["text"] for block in blocks)
                markdown += '\n![figure](images/figure.png)\n<img src="./images/figure.png">'
                blocks.append({"type": "image", "page_idx": 0, "img_path": "images/figure.png"})
                buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, "w") as archive:
                    archive.writestr("output/full.md", markdown)
                    archive.writestr("output/test_content_list.json", json.dumps(blocks, ensure_ascii=False))
                    archive.writestr("output/images/figure.png", name.encode())
                archives[name] = buffer.getvalue()
                # This fails if uploads are accidentally serialized.
                upload_barrier.wait()
                return httpx.Response(200)
            if request.url.host == "api.test":
                return httpx.Response(200, json={"code": 0, "data": {"extract_result": [{
                    "state": "done", "full_zip_url": f"https://storage.test/result/{name}",
                }]}})
            self.assertNotIn("authorization", request.headers)
            if name == "part-0001":
                for event in downloaded.values():
                    self.assertTrue(event.wait(10))
            downloads.append(name)
            if name in downloaded:
                downloaded[name].set()
            return httpx.Response(200, content=archives[name])

        client_type = httpx.Client
        with (
            patch.object(mineru.settings, "mineru_api_token", "test-secret"),
            patch.object(mineru.settings, "mineru_api_base", "https://api.test/api/v4"),
            patch.object(mineru.settings, "mineru_model_version", "vlm"),
            patch.object(mineru.httpx, "Client", side_effect=lambda **kw: client_type(transport=httpx.MockTransport(handle), **kw)),
        ):
            outline = mineru.parse_mineru_pdf(
                self.source, document_id="doc-test", filename="教材.pdf", sha256="a"*64,
                scan_pages=40, executable="unused", timeout_seconds=180,
            )

        self.assertEqual([uploads[name] for name in sorted(uploads)],
                         [list(range(start, start + 100)) for start in range(0, 500, 100)])
        self.assertEqual(downloads[-1], "part-0001")
        self.assertEqual(outline["source"]["page_count"], 500)
        self.assertEqual(outline["chapters"][1]["page"], 201)
        raw = self.root / "mineru-vlm"
        markdown = (raw / "full.md").read_text(encoding="utf-8")
        self.assertEqual([line for line in markdown.splitlines() if line.startswith("PDF page ")],
                         [f"PDF page {index}" for index in range(1, 501)])
        content = json.loads((raw / "content-list.json").read_text(encoding="utf-8"))
        self.assertEqual([block["page_idx"] for block in content if block.get("text", "").startswith("PDF page ")],
                         list(range(500)))
        images = [block for block in content if block["type"] == "image"]
        self.assertEqual([block["page_idx"] for block in images], [0, 100, 200, 300, 400])
        for name, block in zip(sorted(uploads), images):
            image_path = f"parts/{name}/images/figure.png"
            self.assertIn(f"]({image_path})", markdown)
            self.assertIn(f'src="{image_path}"', markdown)
            self.assertEqual(block["img_path"], image_path)
            self.assertEqual((raw / image_path).read_bytes(), name.encode())
        task = json.loads((raw / "task.json").read_text(encoding="utf-8"))
        self.assertEqual([(part["page_start"], part["page_end"]) for part in task["parts"]],
                         [(1, 100), (101, 200), (201, 300), (301, 400), (401, 500)])

    def test_failed_part_does_not_publish_a_partial_book(self):
        self.write_pdf(101)
        sources = []

        def parse(path, **kwargs):
            sources.append(path)
            if path.stem == "part-0002":
                raise DocumentParseError("MinerU 文档解析失败")
            return b"first part", [], {"batch_id": "first"}

        with (
            patch.object(mineru.settings, "mineru_api_token", "test-secret"),
            patch.object(mineru.settings, "mineru_model_version", "vlm"),
            patch.object(mineru, "_parse_mineru_part", side_effect=parse),
            self.assertRaises(DocumentParseError),
        ):
            mineru.parse_mineru_pdf(
                self.source, document_id="doc-test", filename="教材.pdf", sha256="a"*64,
                scan_pages=40, executable="unused", timeout_seconds=180,
            )
        for filename in ("full.md", "content-list.json", "task.json"):
            self.assertFalse((self.root / "mineru-vlm" / filename).exists())
        self.assertEqual(len(sources), 2)
        self.assertTrue(all(not source.exists() for source in sources))

    def test_exactly_100_pages_uses_original_file(self):
        self.write_pdf(100)
        blocks = [{"type": "text", "page_idx": 0, "text": "目录\n1 数组 …… 2\n1.1 下标 …… 2"}]
        with (
            patch.object(mineru.settings, "mineru_api_token", "test-secret"),
            patch.object(mineru, "_parse_mineru_part", return_value=(b"text", blocks, {})) as parse,
        ):
            mineru.parse_mineru_pdf(
                self.source, document_id="doc-test", filename="教材.pdf", sha256="a"*64,
                scan_pages=40, executable="unused", timeout_seconds=180,
            )
        parse.assert_called_once()
        self.assertEqual(parse.call_args.args, (self.source,))
        self.assertEqual(parse.call_args.kwargs["page_count"], 100)

    def test_precision_upload_poll_download_and_page_mapping(self):
        blocks = [
            {"type": "text", "text": "目录", "page_idx": 0},
            {"type": "text", "text": "1 数组 …… 2\n1.1 下标 …… 2\n2 查找 …… 3\n2.1 二分 …… 3", "page_idx": 0},
            {"type": "text", "text": "正文", "page_idx": 1},
            {"type": "image", "page_idx": 2},
        ]
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("full.md", "# 目录\n教材正文")
            archive.writestr("test_content_list.json", json.dumps(blocks, ensure_ascii=False))
            # Unknown archive paths are never extracted.
            archive.writestr("../../escaped.json", "{}")
        polls = 0

        def handle(request):
            nonlocal polls
            if request.method == "POST":
                self.assertEqual(request.headers["authorization"], "Bearer test-secret")
                body = json.loads(request.content)
                self.assertEqual(body["model_version"], "vlm")
                self.assertEqual(body["files"][0]["data_id"], "doc-test")
                return httpx.Response(200, json={"code": 0, "data": {
                    "batch_id": "batch-test", "file_urls": ["https://storage.test/upload?signature=private"],
                }})
            if request.method == "PUT":
                self.assertNotIn("authorization", request.headers)
                self.assertEqual(request.content, self.source.read_bytes())
                return httpx.Response(200)
            if request.url.host == "storage.test":
                self.assertNotIn("authorization", request.headers)
                return httpx.Response(200, content=buffer.getvalue())
            polls += 1
            return httpx.Response(200, json={"code": 0, "data": {"extract_result": [{
                "state": "pending" if polls == 1 else "done",
                "full_zip_url": "https://storage.test/result?signature=private",
            }]}})

        client_type = httpx.Client
        with (
            patch.object(mineru.settings, "mineru_api_token", "test-secret"),
            patch.object(mineru.settings, "mineru_api_base", "https://api.test/api/v4"),
            patch.object(mineru.settings, "mineru_model_version", "vlm"),
            patch.object(mineru, "_pdf_page_count", return_value=3),
            patch.object(mineru.time, "sleep"),
            patch.object(mineru.httpx, "Client", side_effect=lambda **kw: client_type(transport=httpx.MockTransport(handle), **kw)),
        ):
            outline = mineru.parse_mineru_pdf(
                self.source, document_id="doc-test", filename="教材.pdf", sha256="a"*64,
                scan_pages=40, executable="unused", timeout_seconds=180,
            )
        self.assertEqual(outline["source"]["parser"], "mineru-vlm")
        self.assertEqual(outline["source"]["page_count"], 3)
        self.assertEqual([ch["id"] for ch in outline["chapters"]], ["chapter-1", "chapter-2"])
        self.assertEqual(outline["chapters"][1]["points"][0]["page"], 3)
        self.assertEqual(polls, 2)
        raw = self.root / "mineru-vlm"
        self.assertTrue((raw / "full.md").is_file())
        self.assertTrue((raw / "content-list.json").is_file())
        task = (raw / "task.json").read_text(encoding="utf-8")
        self.assertNotIn("test-secret", task)
        self.assertNotIn("signature", task)
        self.assertFalse((self.root / "escaped.json").exists())

    def test_archive_prefers_v1_content_list_when_v2_is_also_present(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("full.md", "# Book")
            archive.writestr(
                "book_content_list.json",
                json.dumps([{"type": "text", "page_idx": 0, "text": "v1"}]),
            )
            archive.writestr(
                "book_content_list_v2.json",
                json.dumps([[{"type": "text", "text": "v2"}]]),
            )
        output = self.root / "mineru"
        output.mkdir()
        markdown, content_bytes = mineru._read_artifacts(buffer.getvalue(), output)
        self.assertEqual(markdown, b"# Book")
        self.assertEqual(json.loads(content_bytes)[0]["text"], "v1")

    def test_native_toc_preserves_chapter_numbers_omitted_by_mineru(self):
        native_toc = "⽬录\n1 数组  2\n1.1 下标 …… 2\n2 查找  3\n2.1 二分 …… 3"
        blocks = [{"type": "text", "page_idx": 0,
                   "text": "⽬录\n1 数组 2\n1.1 下标 2\n查找 3\n2.1 二分 3"}]
        with (
            patch.object(mineru.settings, "mineru_api_token", "test-secret"),
            patch.object(mineru, "_parse_mineru_part", return_value=(b"text", blocks, {})),
            patch("pypdf._page.PageObject.extract_text", return_value=native_toc),
        ):
            outline = mineru.parse_mineru_pdf(
                self.source, document_id="doc-test", filename="教材.pdf", sha256="a"*64,
                scan_pages=40, executable="unused", timeout_seconds=180,
            )
        self.assertEqual([chapter["number"] for chapter in outline["chapters"]], ["1", "2"])
        self.assertEqual(outline["chapters"][1]["title"], "查找")
        self.assertEqual(outline["chapters"][1]["points"][0]["number"], "2.1")

    def test_missing_token_fails_without_sending_a_request(self):
        with patch.object(mineru.settings, "mineru_api_token", ""), patch.object(mineru.httpx, "Client") as client:
            with self.assertRaises(DocumentParserUnavailableError):
                mineru.parse_mineru_pdf(self.source, document_id="doc-test", filename="x.pdf", sha256="a"*64,
                                       scan_pages=40, executable="unused", timeout_seconds=180)
            client.assert_not_called()

    def test_api_authentication_error_does_not_echo_response_body(self):
        response = httpx.Response(401, text="echoed-test-secret", request=httpx.Request("GET", "https://api.test"))
        with self.assertRaises(DocumentParserUnavailableError) as error:
            mineru._api_data(response)
        self.assertNotIn("echoed-test-secret", str(error.exception))

    def test_content_list_requires_valid_original_page_indices(self):
        for page in (-1, 2, True, None):
            with self.subTest(page=page), self.assertRaises(DocumentParseError):
                mineru.content_list_to_pages([{"type": "text", "page_idx": page, "text": "目录"}], 2)

    def test_content_list_accepts_wrapped_content_text(self):
        pages = mineru.content_list_to_pages(
            {
                "content": [
                    {"page_idx": 0, "content": "目录"},
                    {
                        "page_idx": 1,
                        "type": "text",
                        "content": [{"text": "第1章"}, {"content": "基础"}],
                    },
                ]
            },
            2,
        )
        self.assertEqual(pages, ["目录", "第1章基础"])

    def test_changing_selected_parser_does_not_reuse_local_outline(self):
        store = DocumentStore(self.root / "library")
        upload = store.create_upload(io.BytesIO(b"%PDF-source"), filename="x.pdf", content_type="application/pdf")
        calls = []

        def parse(path, *, document_id, filename, sha256, **kwargs):
            name = "local-pdftotext" if not calls else "mineru-vlm"
            calls.append(name)
            return {"schema_version":"textbook-outline/1.0", "document_id":document_id, "title":"测试",
                    "source":{"filename":filename,"sha256":sha256,"parser":name,"page_count":1,"toc_pages":1},
                    "chapters":[{"id":"chapter-1","number":"1","title":"测试","page":1,"order":0,
                                 "points":[{"id":"point-1-1","number":"1.1","title":"知识点","page":1,"order":0,"origin":"textbook"}]}]}

        store.parse(upload["id"], parser=parse, parser_name="local-pdftotext")
        result = store.parse(upload["id"], parser=parse, parser_name="mineru-vlm")
        self.assertEqual(result["document"]["parser"], "mineru-vlm")
        store.parse(upload["id"], parser=parse, parser_name="mineru-vlm")
        self.assertEqual(calls, ["local-pdftotext", "mineru-vlm"])

    def test_mineru_rejects_mismatched_outline_without_content_evidence(self):
        store = DocumentStore(self.root / "library")
        upload = store.create_upload(
            io.BytesIO(b"%PDF-source"),
            filename="textbook.pdf",
            content_type="application/pdf",
        )
        markdown = """# Textbook

## 1. Chapter one

### 1.1 First point

Evidence for the first point.

### 1.2 Second point

Evidence for the second point.
"""

        def parse(path, *, document_id, filename, sha256, **_kwargs):
            raw = path.parent / "mineru-vlm"
            raw.mkdir(parents=True, exist_ok=True)
            (raw / "full.md").write_text(markdown, encoding="utf-8")
            return {
                "schema_version": "textbook-outline/1.0",
                "document_id": document_id,
                "title": "Textbook",
                "source": {
                    "filename": filename,
                    "sha256": sha256,
                    "parser": "mineru-vlm",
                    "page_count": 1,
                    "toc_pages": 1,
                },
                "chapters": [{
                    "id": "chapter-0",
                    "number": "0",
                    "title": "目录",
                    "page": 1,
                    "order": 0,
                    "points": [{
                        "id": "point-0-1",
                        "number": "0.1",
                        "title": "错误目录点",
                        "page": 1,
                        "order": 0,
                        "origin": "textbook",
                    }],
                }],
            }

        with self.assertRaises(DocumentValidationError):
            store.parse(upload["id"], parser=parse, parser_name="mineru-vlm")
        self.assertEqual(store.get(upload["id"])["status"], "failed")

    def test_explicit_mineru_mode_selects_cloud_parser(self):
        with (
            patch.object(api.settings, "document_parser", "mineru"),
            patch.object(api.settings, "mineru_model_version", "vlm"),
            patch.object(api, "get_document_store") as store,
        ):
            api._parse_selected_document("doc-test")
        self.assertIs(store.return_value.parse.call_args.kwargs["parser"], api.parse_mineru_pdf)
        self.assertEqual(store.return_value.parse.call_args.kwargs["parser_name"], "mineru-vlm")
