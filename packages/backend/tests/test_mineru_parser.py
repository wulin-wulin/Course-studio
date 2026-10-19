import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import httpx

from src.api import documents as api
from src.services.documents import mineru_parser as mineru
from src.services.documents.store import (
    DocumentParseError, DocumentParserUnavailableError, DocumentStore,
)


class MinerUParserTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.pdf"
        self.source.write_bytes(b"%PDF-test-source")

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

    def test_explicit_mineru_mode_selects_cloud_parser(self):
        with (
            patch.object(api.settings, "document_parser", "mineru"),
            patch.object(api.settings, "mineru_model_version", "vlm"),
            patch.object(api, "get_document_store") as store,
        ):
            api._parse_selected_document("doc-test")
        self.assertIs(store.return_value.parse.call_args.kwargs["parser"], api.parse_mineru_pdf)
        self.assertEqual(store.return_value.parse.call_args.kwargs["parser_name"], "mineru-vlm")
