"""Regression tests for MinerU-to-textbook structure candidates.

These tests deliberately model the shapes seen in the real 241-page textbook:
Chinese chapter markers, OCR's ``3章`` variant, repeated running headers, and
appendix/answer material.  They never call MinerU or an LLM and never mutate
the raw Markdown fixture.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path
import unittest

from src.services.documents.structure_candidates import (
    build_mineru_structure_candidate,
    merge_structure_proposal,
    StructureCandidateError,
    validate_structure_candidate,
)


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "mineru" / "structure_cases"
CONTENT_LIST_PATH = FIXTURE_ROOT / "seven_chapter_content_list.json"
MARKDOWN_PATH = FIXTURE_ROOT / "seven_chapter_full.md"


class StructureCandidateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.content = json.loads(CONTENT_LIST_PATH.read_text(encoding="utf-8"))
        cls.markdown = MARKDOWN_PATH.read_text(encoding="utf-8")

    def test_recovers_seven_chapters_from_mixed_mineru_headings(self):
        candidate = build_mineru_structure_candidate(
            self.content,
            self.markdown,
            page_count=241,
        )

        self.assertEqual(candidate["schema_version"], "structure-candidate/1.0")
        self.assertEqual(
            [chapter["number"] for chapter in candidate["chapters"]],
            [str(number) for number in range(1, 8)],
        )
        self.assertEqual(
            [chapter["title"] for chapter in candidate["chapters"]],
            [
                "数字逻辑概述",
                "布尔代数和逻辑化简",
                "组合逻辑电路",
                "触发器",
                "时序逻辑电路",
                "逻辑门电路",
                "半导体存储器与可编程器件",
            ],
        )

    def test_deduplicates_running_headers_and_keeps_monotonic_ranges(self):
        candidate = build_mineru_structure_candidate(
            self.content,
            self.markdown,
            page_count=241,
        )
        starts = [chapter["page_start"] for chapter in candidate["chapters"]]
        ends = [chapter["page_end"] for chapter in candidate["chapters"]]

        self.assertEqual(starts, sorted(set(starts)))
        self.assertTrue(all(start <= end for start, end in zip(starts, ends)))
        self.assertTrue(all(left < right for left, right in zip(ends, starts[1:])))
        self.assertEqual(candidate["diagnostics"]["chapter_numbers"], [str(i) for i in range(1, 8)])

    def test_classifies_appendix_answers_and_references_as_auxiliary(self):
        candidate = build_mineru_structure_candidate(
            self.content,
            self.markdown,
            page_count=241,
        )
        auxiliary = candidate["auxiliary_sections"]
        self.assertTrue(auxiliary)
        auxiliary_text = " ".join(
            f"{item.get('kind', '')} {item.get('title', '')}" for item in auxiliary
        )
        self.assertIn("附录", auxiliary_text)
        self.assertIn("答案", auxiliary_text)
        self.assertIn("参考文献", auxiliary_text)
        self.assertNotIn("附录A", [chapter["title"] for chapter in candidate["chapters"]])

    def test_candidate_references_only_original_pages_and_text(self):
        candidate = build_mineru_structure_candidate(
            self.content,
            self.markdown,
            page_count=241,
        )
        validate_structure_candidate(candidate, self.content, self.markdown)
        original_text = {
            str(block.get("text", ""))
            for block in self.content
            if isinstance(block, dict)
        }
        for chapter in candidate["chapters"]:
            for reference in chapter["source_refs"]:
                self.assertIn(reference["text"], original_text)
                self.assertGreaterEqual(reference["page_idx"], 0)
                self.assertLess(reference["page_idx"], 241)

    def test_candidate_rejects_valid_text_with_wrong_page(self):
        candidate = build_mineru_structure_candidate(
            self.content,
            self.markdown,
            page_count=241,
        )
        candidate = deepcopy(candidate)
        reference = candidate["chapters"][0]["source_refs"][0]
        original_page = reference["page_idx"]
        reference["page_idx"] = original_page + 1
        with self.assertRaises(StructureCandidateError):
            validate_structure_candidate(candidate, self.content, self.markdown)

    def test_raw_markdown_fixture_is_not_modified(self):
        before = MARKDOWN_PATH.read_bytes()
        digest = hashlib.sha256(before).hexdigest()

        build_mineru_structure_candidate(
            self.content,
            self.markdown,
            page_count=241,
        )

        after = MARKDOWN_PATH.read_bytes()
        self.assertEqual(after, before)
        self.assertEqual(hashlib.sha256(after).hexdigest(), digest)

    def test_llm_proposal_can_only_refine_evidence_backed_candidates(self):
        candidate = build_mineru_structure_candidate(
            self.content,
            self.markdown,
            page_count=241,
        )
        proposal = {
            "schema_version": "structure-proposal/1.0",
            "chapters": [
                {
                    "number": chapter["number"],
                    "title": chapter["title"],
                    "page_start": chapter["page_start"],
                    "page_end": chapter["page_end"],
                    "source_refs": chapter["source_refs"],
                    "confidence": 0.99,
                }
                for chapter in candidate["chapters"]
            ],
            "auxiliary_sections": candidate["auxiliary_sections"],
            "warnings": [],
        }
        refined = merge_structure_proposal(
            candidate,
            proposal,
            self.content,
            page_count=241,
        )
        self.assertTrue(refined["diagnostics"]["llm_refined"])
        self.assertFalse(refined["diagnostics"]["needs_review"])

        invalid = deepcopy(proposal)
        invalid["chapters"][0]["source_refs"] = [
            {"page_idx": 0, "text": "not in MinerU"}
        ]
        with self.assertRaises(StructureCandidateError):
            merge_structure_proposal(candidate, invalid, self.content, page_count=241)

        unsupported_title = deepcopy(proposal)
        unsupported_title["chapters"][0]["title"] = "a"
        with self.assertRaises(StructureCandidateError):
            merge_structure_proposal(
                candidate, unsupported_title, self.content, page_count=241
            )

    def test_llm_proposal_cannot_clear_deterministic_warnings(self):
        candidate = build_mineru_structure_candidate(
            self.content,
            self.markdown,
            page_count=241,
        )
        candidate = deepcopy(candidate)
        candidate["warnings"] = ["chapter number gap requires review"]
        candidate["diagnostics"]["needs_review"] = True
        proposal = {
            "schema_version": "structure-proposal/1.0",
            "chapters": [
                {
                    "number": chapter["number"],
                    "title": chapter["title"],
                    "page_start": chapter["page_start"],
                    "page_end": chapter["page_end"],
                    "source_refs": chapter["source_refs"],
                    "confidence": 0.99,
                }
                for chapter in candidate["chapters"]
            ],
            "auxiliary_sections": [],
            "warnings": [],
        }
        refined = merge_structure_proposal(
            candidate,
            proposal,
            self.content,
            page_count=241,
        )
        self.assertIn("chapter number gap requires review", refined["warnings"])
        self.assertTrue(refined["diagnostics"]["needs_review"])

    def test_handles_content_blocks_without_explicit_header_type(self):
        content = [
            {
                "type": "text",
                "page_idx": 1,
                "text": (
                    "目录\n第1章 基础逻辑 …… 3\n第2章 进阶逻辑 …… 5"
                ),
            },
            {"type": "text", "page_idx": 3, "text": "第1章 基础逻辑"},
            {"type": "text", "page_idx": 4, "text": "1.1 基本概念"},
            {"type": "text", "page_idx": 5, "text": "第2章 进阶逻辑"},
            {"type": "text", "page_idx": 5, "text": "2.1 组合规则"},
        ]
        markdown = (
            "# Book\n\n"
            "## 基础逻辑\n\n### 1.1 基本概念\n\n正文\n\n"
            "## 进阶逻辑\n\n### 2.1 组合规则\n\n正文\n"
        )
        candidate = build_mineru_structure_candidate(content, markdown, page_count=6)
        self.assertEqual([item["number"] for item in candidate["chapters"]], ["1", "2"])
        self.assertEqual([item["page_start"] for item in candidate["chapters"]], [4, 6])

    def test_ignores_layout_records_without_page_indices(self):
        content = [
            {"type": "image", "img_path": "images/figure.png"},
            {"type": "table", "content": "<table>"},
            {"type": "text", "page_idx": 0, "text": "目录\n第1章 基础 …… 2"},
            {"type": "text", "page_idx": 1, "text": "第1章 基础"},
        ]
        markdown = "# 教材\n\n## 第1章 基础\n\n正文\n"

        candidate = build_mineru_structure_candidate(content, markdown, page_count=2)

        self.assertEqual([chapter["number"] for chapter in candidate["chapters"]], ["1"])

    def test_unwraps_nested_content_list_envelopes(self):
        content = {
            "data": {
                "content_list": [
                    {"type": "text", "page_idx": 0, "text": "目录\n第1章 基础 …… 2"},
                    {"type": "text", "page_idx": 1, "text": "第1章 基础"},
                ]
            }
        }
        markdown = "# 教材\n\n## 第1章 基础\n\n正文\n"

        candidate = build_mineru_structure_candidate(content, markdown, page_count=2)

        self.assertEqual([chapter["number"] for chapter in candidate["chapters"]], ["1"])

    def test_ignores_chapter_references_in_front_matter_and_body_summaries(self):
        """A textbook overview must not move later chapter boundaries backwards.

        This is reduced from the database textbook that exposed the production
        failure: chapter 1 starts after a multi-page TOC, chapter 2 has a bare
        opener followed by a running header, and the surrounding prose names
        chapters 2--6 and 8--9.
        """

        content = [
            {
                "type": "text",
                "page_idx": 0,
                "text": "目录\n第1章 绪论 …… 3\n第2章 关系数据库 …… 5\n第3章 SQL …… 8",
            },
            {"type": "text", "page_idx": 1, "text": "目录"},
            {"type": "text", "page_idx": 3, "text": "第1章 绪论"},
            {
                "type": "text",
                "page_idx": 4,
                "text": "本书第2章和第3章将集中讨论相关问题。",
            },
            {"type": "text", "page_idx": 5, "text": "第2章"},
            {"type": "text", "page_idx": 5, "text": "关系数据库"},
            {"type": "header", "page_idx": 6, "text": "第2章 关系数据库"},
            {"type": "text", "page_idx": 7, "text": "第3章 SQL"},
            {"type": "header", "page_idx": 8, "text": "第3章 SQL"},
        ]
        markdown = "# 教材\n\n## 第1章 绪论\n\n## 第2章 关系数据库\n\n## 第3章 SQL\n"

        candidate = build_mineru_structure_candidate(content, markdown, page_count=10)

        self.assertEqual(
            [chapter["number"] for chapter in candidate["chapters"]],
            ["1", "2", "3"],
        )
        self.assertEqual(
            [chapter["page_start"] for chapter in candidate["chapters"]],
            [4, 6, 8],
        )
        self.assertEqual(candidate["diagnostics"]["toc_page_end"], 1)

    def test_infers_unlabeled_toc_from_printed_page_suffixes(self):
        """Some OCR exports omit the literal 目录 heading entirely."""

        content = [
            {"type": "text", "page_idx": 0, "text": "1 章 网络基础 …… 3"},
            {"type": "text", "page_idx": 1, "text": "2 章 传输协议 …… 25"},
            {"type": "text", "page_idx": 2, "text": "3 章 应用层 …… 48"},
            {"type": "text", "page_idx": 4, "text": "第1章 网络基础"},
            {"type": "header", "page_idx": 5, "text": "第1章"},
            {"type": "text", "page_idx": 8, "text": "第2章 传输协议"},
            {"type": "header", "page_idx": 9, "text": "第2章"},
            {"type": "text", "page_idx": 12, "text": "第3章 应用层"},
            {"type": "header", "page_idx": 13, "text": "第3章"},
        ]
        markdown = (
            "# 教材\n\n## 第1章 网络基础\n\n"
            "## 第2章 传输协议\n\n## 第3章 应用层\n"
        )

        candidate = build_mineru_structure_candidate(content, markdown, page_count=15)

        self.assertEqual(candidate["diagnostics"]["toc_page_start"], 0)
        self.assertEqual(candidate["diagnostics"]["toc_page_end"], 2)
        self.assertEqual(
            [chapter["page_start"] for chapter in candidate["chapters"]],
            [5, 9, 13],
        )
        self.assertFalse(candidate["warnings"])

    def test_keeps_multi_page_toc_before_explicit_body_heading(self):
        """A one-marker-per-page TOC must not become a chapter boundary.

        This mirrors the computer-network scan: the TOC occupies several
        continuation pages, while the first real chapter is a level-2 text
        block after the TOC.  Counting chapter markers per page alone used to
        select the second TOC page as chapter 2's start.
        """

        content = [
            {"type": "text", "page_idx": 0, "text": "目录"},
            {
                "type": "text",
                "page_idx": 1,
                "text": "第1章 网络基础 …… 3\n1.1 基础 …… 4",
            },
            {
                "type": "text",
                "page_idx": 2,
                "text": "2 章 传输协议 …… 25\n2.1 TCP …… 26",
            },
            {
                "type": "text",
                "page_idx": 3,
                "text": "3 章 应用层 …… 48\n3.1 HTTP …… 49",
            },
            {"type": "text", "text_level": 2, "page_idx": 4, "text": "第1章 网络基础"},
            {"type": "header", "page_idx": 5, "text": "第1章 网络基础"},
            {"type": "text", "text_level": 2, "page_idx": 6, "text": "第2章 传输协议"},
            {"type": "header", "page_idx": 7, "text": "第2章 传输协议"},
            {"type": "text", "text_level": 2, "page_idx": 8, "text": "第3章 应用层"},
            {"type": "header", "page_idx": 9, "text": "第3章 应用层"},
        ]
        markdown = (
            "# 教材\n\n## 第1章 网络基础\n\n"
            "## 第2章 传输协议\n\n## 第3章 应用层\n"
        )

        candidate = build_mineru_structure_candidate(content, markdown, page_count=12)

        self.assertEqual(candidate["diagnostics"]["toc_page_end"], 3)
        self.assertEqual(
            [chapter["page_start"] for chapter in candidate["chapters"]],
            [5, 7, 9],
        )
        self.assertFalse(candidate["warnings"])


if __name__ == "__main__":
    unittest.main()
