"""Evidence-first structure candidates for MinerU textbook outputs.

The MinerU Markdown export is intentionally treated as an immutable source
document.  This module only reads the export and produces a small, auditable
candidate structure.  It does not call an LLM and never rewrites ``full.md``.
"""

from __future__ import annotations

from collections import defaultdict
import hashlib
import json
import re
import unicodedata
from typing import Any, Iterable


STRUCTURE_CANDIDATE_SCHEMA = "structure-candidate/1.0"

__all__ = [
    "STRUCTURE_CANDIDATE_SCHEMA",
    "StructureCandidateError",
    "build_mineru_structure_candidate",
    "extract_chapter_candidates",
    "merge_structure_proposal",
    "validate_structure_candidate",
]

_TOC_RE = re.compile(r"^\s*目\s*录\s*$")
_CHAPTER_RE = re.compile(
    r"(?<![\w\d])(?:第\s*)?(?P<number>\d{1,3}|[〇零一二三四五六七八九十百千万]+)\s*章"
)
_AUXILIARY_RE = re.compile(
    r"(?P<title>附\s*录\s*[A-Za-zＡ-Ｚａ-ｚ0-9０-９]*[^\n]*|"
    r"习\s*题\s*(?:和)?\s*自\s*测\s*题\s*答\s*案[^\n]*|"
    r"自\s*测\s*题\s*答\s*案[^\n]*|"
    r"习\s*题\s*答\s*案[^\n]*|"
    r"参\s*考\s*文\s*献[^\n]*|"
    r"索\s*引[^\n]*)"
)
_PAGE_SUFFIX_RE = re.compile(r"(?:[.·…]{2,}|\s{2,})\s*(?P<page>\d{1,4})\s*$")
_TRAILING_PAGE_RE = re.compile(r"\s+(?P<page>\d{1,4})\s*$")
_LEADING_MARK_RE = re.compile(r"^[\s:：.、\-—–]+|[\s:：.、\-—–]+$")
_CONTENT_LIST_KEYS = ("content_list", "content", "items", "data", "result")

_CHINESE_DIGITS = {
    "〇": 0,
    "零": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_CHINESE_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}


class StructureCandidateError(ValueError):
    """The candidate structure is malformed or cannot be trusted."""


def _unwrap_content_list(content: Any) -> Any:
    """Unwrap nested MinerU response envelopes without trusting depth forever."""

    value = content
    for _ in range(5):
        if isinstance(value, list):
            return value
        if not isinstance(value, dict):
            break
        next_value = next(
            (
                value.get(key)
                for key in _CONTENT_LIST_KEYS
                if isinstance(value.get(key), (list, dict))
            ),
            None,
        )
        if next_value is None or next_value is value:
            break
        value = next_value
    return value


def _normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = value.replace("\u3000", " ")
    return "\n".join(
        re.sub(r"[ \t]+", " ", line).strip() for line in value.split("\n")
    )


def _content_sha256(content: Any) -> str:
    try:
        payload = json.dumps(
            content, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    except (TypeError, ValueError):
        return ""
    return hashlib.sha256(payload).hexdigest()


def _number_value(value: str) -> int | None:
    value = value.strip()
    if value.isdigit():
        number = int(value)
        return number if number > 0 else None
    if not value or any(
        char not in _CHINESE_DIGITS and char not in _CHINESE_UNITS for char in value
    ):
        return None
    total = 0
    section = 0
    number = 0
    for char in value:
        if char in _CHINESE_DIGITS:
            number = _CHINESE_DIGITS[char]
            continue
        unit = _CHINESE_UNITS[char]
        if unit == 10000:
            section += number
            total += section * unit
            section = 0
            number = 0
        else:
            if number == 0:
                number = 1
            section += number * unit
            number = 0
    result = total + section + number
    return result if result > 0 else None


def _as_blocks(content: Any) -> list[dict[str, Any]]:
    """Normalize MinerU Content List V1 and common wrapper responses."""

    value = _unwrap_content_list(content)
    if not isinstance(value, list):
        raise StructureCandidateError("MinerU content-list 必须是数组")
    blocks: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            continue
        # Non-text layout records (images, tables, equations) are retained in
        # the raw MinerU evidence but cannot create chapter candidates.  A few
        # exporter versions omit page_idx on those records, so skip them before
        # enforcing the textual page contract.
        block_type = str(raw.get("type") or "text")
        if block_type not in {"text", "header", "ref_text"}:
            continue
        page = raw.get("page_idx")
        if isinstance(page, bool) or not isinstance(page, int) or page < 0:
            raise StructureCandidateError(f"MinerU 内容块 {index} 缺少有效 page_idx")
        text = raw.get("text")
        if not isinstance(text, str) or not text.strip():
            content_value = raw.get("content")
            if isinstance(content_value, str):
                text = content_value
            elif isinstance(content_value, list):
                parts: list[str] = []
                for item in content_value:
                    if isinstance(item, str):
                        parts.append(item)
                    elif isinstance(item, dict):
                        item_text = item.get("text") or item.get("content")
                        if isinstance(item_text, str):
                            parts.append(item_text)
                text = "".join(parts)
        if not isinstance(text, str) or not text.strip():
            continue
        blocks.append(
            {
                "index": index,
                "page_idx": page,
                "type": block_type,
                "text": text,
                "normalized": _normalize_text(text),
                "text_level": raw.get("text_level"),
            }
        )
    return blocks


def _split_candidate_lines_with_context(text: str) -> Iterable[tuple[str, int]]:
    """Yield candidate lines and the marker count from their source line."""

    for raw_line in text.splitlines() or [text]:
        line = raw_line.strip()
        if not line:
            continue
        matches = list(_CHAPTER_RE.finditer(line))
        if len(matches) <= 1:
            yield line, len(matches)
            continue
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(line)
            piece = line[match.start():end].strip()
            if piece:
                yield piece, len(matches)


def _split_candidate_lines(text: str) -> Iterable[str]:
    """Yield lines, splitting compact OCR paragraphs at chapter markers."""

    for line, _marker_count in _split_candidate_lines_with_context(text):
        yield line


def _clean_title(tail: str) -> tuple[str, int | None]:
    tail = tail.strip()
    page: int | None = None
    page_match = _PAGE_SUFFIX_RE.search(tail)
    if page_match:
        page = int(page_match.group("page"))
        tail = tail[: page_match.start()]
    else:
        page_match = _TRAILING_PAGE_RE.search(tail)
        if page_match and (" " in tail[: page_match.start()] or "\t" in tail[: page_match.start()]):
            page = int(page_match.group("page"))
            tail = tail[: page_match.start()]
    tail = _LEADING_MARK_RE.sub("", tail)
    tail = re.sub(r"^[:：、.\-—–]+", "", tail).strip()
    tail = re.sub(r"\s+", " ", tail).strip(" .·…\t")
    return tail, page


def _looks_like_chapter_heading(line: str, match: re.Match[str], title: str) -> bool:
    """Return whether a chapter marker is likely a section opener.

    OCR content lists contain many perfectly valid references such as
    ``本书第2～6章……``.  Treating every regex match as a boundary makes the
    first occurrence of a chapter number jump backwards into a paragraph.
    A heading must start the line and either be a bare marker or have a short,
    punctuation-free title.  The caller separately uses the block type and
    text level as additional evidence for repeated running headers.
    """

    if match.start() != 0:
        return False
    if _CHAPTER_RE.fullmatch(line.strip()):
        return True
    title = title.strip()
    if not title or len(title) > 80:
        return False
    # Chapter summaries and prose references nearly always contain sentence
    # punctuation; a genuine title in the scanned books does not.
    return not any(char in title for char in "，,。；;：:！!？?（）()[]【】")


def _initial_toc_end(
    blocks: list[dict[str, Any]], toc_start: int | None
) -> int | None:
    """Find the contiguous TOC run at the beginning of a content list.

    A later chapter may contain an introductory paragraph mentioning several
    ``第 N 章`` strings.  Looking for the last multi-marker page globally (the
    old behavior) therefore swallows real body pages.  Restrict the search to
    the initial contiguous run following the first ``目录`` heading.
    """

    if toc_start is None:
        return None
    by_page: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for block in blocks:
        by_page[block["page_idx"]].append(block)

    # A long TOC may contain one chapter marker on each continuation page.
    # If MinerU also exposes a level-1/2 chapter opener, use that as the
    # boundary instead of allowing the final TOC row to become a body start.
    # Do not use ``type=header`` here: running headers are often emitted on
    # every page and can occur after an untyped first chapter opener.
    explicit_body_pages: list[int] = []
    for page, page_blocks in by_page.items():
        if page <= toc_start:
            continue
        for block in page_blocks:
            level = block.get("text_level")
            if not (
                isinstance(level, int)
                and not isinstance(level, bool)
                and level <= 2
            ):
                continue
            for line in block["normalized"].splitlines():
                matches = list(_CHAPTER_RE.finditer(line))
                if len(matches) != 1:
                    continue
                match = matches[0]
                title, printed_page = _clean_title(line[match.end() :])
                # A chapter marker followed by a printed page is a TOC row,
                # even if OCR assigned it a heading level. Only a marker with
                # no page suffix can terminate the front-matter run.
                if printed_page is not None:
                    continue
                if _looks_like_chapter_heading(line, match, title):
                    explicit_body_pages.append(page)
                    break
            if explicit_body_pages and explicit_body_pages[-1] == page:
                break
    if explicit_body_pages:
        return min(explicit_body_pages) - 1

    page_markers: dict[int, int] = {}
    page_has_toc: dict[int, bool] = {}
    for page, page_blocks in by_page.items():
        page_markers[page] = sum(
            len(list(_CHAPTER_RE.finditer(line)))
            for block in page_blocks
            for line in block["normalized"].splitlines()
        )
        page_has_toc[page] = any(
            _TOC_RE.fullmatch(line)
            for block in page_blocks
            for line in block["normalized"].splitlines()
        )

    end = toc_start
    previous_marker_count = page_markers.get(toc_start, 0)
    page = toc_start + 1
    while page in by_page:
        marker_count = page_markers.get(page, 0)
        # A TOC page normally has several chapter entries.  Permit a final
        # one-entry page only when it directly follows such a page; this keeps
        # split OCR blocks from prematurely ending the TOC while still
        # stopping at the first ordinary body page.
        is_toc_page = (
            page_has_toc.get(page, False)
            or marker_count >= 2
            or (marker_count >= 1 and previous_marker_count >= 2)
        )
        if not is_toc_page:
            break
        end = page
        previous_marker_count = marker_count
        page += 1
    return end


def _infer_toc_bounds_without_label(
    blocks: list[dict[str, Any]],
) -> tuple[int | None, int | None]:
    """Infer a front-matter TOC range when MinerU omitted ``目录``.

    Some scanned books (including the computer-network sample) contain a
    perfectly usable table of contents, but MinerU labels every row as plain
    text and does not preserve the heading word.  Such rows still have two
    strong signals: a chapter marker and a printed-page suffix (``…… 51``).
    Require a short run of those rows before treating them as a TOC; this
    avoids classifying an isolated body sentence or a later citation as the
    beginning of the document outline.
    """

    by_page: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for block in blocks:
        by_page[block["page_idx"]].append(block)
    if not by_page:
        return None, None

    printed_chapter_counts: dict[int, int] = {}
    for page, page_blocks in by_page.items():
        count = 0
        for block in page_blocks:
            for raw_line in block["normalized"].splitlines():
                line = raw_line.strip()
                matches = list(_CHAPTER_RE.finditer(line))
                for index, match in enumerate(matches):
                    next_start = (
                        matches[index + 1].start()
                        if index + 1 < len(matches)
                        else len(line)
                    )
                    _title, printed_page = _clean_title(
                        line[match.end() : next_start]
                    )
                    if printed_page is not None:
                        count += 1
        if count:
            printed_chapter_counts[page] = count

    candidate_pages = sorted(printed_chapter_counts)
    if not candidate_pages:
        return None, None

    # A real TOC has multiple chapter rows close together.  The eight-page
    # window accommodates OCR exports that split one row per PDF page.
    toc_start: int | None = None
    for page in candidate_pages:
        nearby = [item for item in candidate_pages if page <= item < page + 8]
        if len(nearby) >= 2:
            toc_start = page
            break
    if toc_start is None:
        return None, None

    toc_end = toc_start
    previous = toc_start
    for page in candidate_pages:
        if page <= toc_start:
            continue
        # Keep the initial physical run.  A missing content block/page marks
        # the end rather than allowing a later chapter's printed reference to
        # extend the inferred TOC indefinitely.
        if page != previous + 1:
            break
        toc_end = page
        previous = page
    return toc_start, toc_end


def _chapter_occurrences(
    blocks: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int | None, int | None]:
    toc_pages = sorted(
        block["page_idx"]
        for block in blocks
        if any(_TOC_RE.fullmatch(line) for line in block["normalized"].splitlines())
    )
    toc_start = toc_pages[0] if toc_pages else None

    # First isolate the initial TOC run.  The previous implementation searched
    # for a bare ``第 N 章`` marker anywhere after the TOC and consequently
    # treated a later chapter's prose/summary page as the TOC boundary.  That
    # made the real chapter-1 heading disappear and let paragraph references
    # determine chapter starts.
    if toc_start is None:
        toc_start, toc_end = _infer_toc_bounds_without_label(blocks)
    else:
        toc_end = _initial_toc_end(blocks, toc_start)

    occurrences: list[dict[str, Any]] = []
    for block in blocks:
        text = block["normalized"]
        if not text:
            continue
        line_match_count = sum(
            len(list(_CHAPTER_RE.finditer(line)))
            for line in text.splitlines()
        )
        is_summary = toc_start is not None and block["page_idx"] < toc_start and line_match_count >= 2
        if is_summary:
            kind = "summary"
        elif toc_start is not None and block["page_idx"] >= toc_start:
            is_toc = toc_end is None or block["page_idx"] <= toc_end
            kind = "toc" if is_toc else ("header" if block["type"] == "header" else "body")
        else:
            is_toc = False
            kind = "header" if block["type"] == "header" else "body"
        for line, source_marker_count in _split_candidate_lines_with_context(text):
            matches = list(_CHAPTER_RE.finditer(line))
            for match_index, match in enumerate(matches):
                number = _number_value(match.group("number"))
                if number is None:
                    continue
                next_start = (
                    matches[match_index + 1].start()
                    if match_index + 1 < len(matches)
                    else len(line)
                )
                tail = line[match.end():next_start]
                title, printed_page = _clean_title(tail)
                # ``is_heading`` is deliberately an internal evidence flag;
                # it is not persisted in source references.  It lets the
                # builder distinguish a chapter opener from a sentence such
                # as “本书第2～6章……”.
                # A line containing multiple chapter markers is normally a
                # prose summary or a TOC row (``第2章…第6章``), even when the
                # split piece left by ``_split_candidate_lines`` happens to
                # have a short, punctuation-free tail.
                is_heading = (
                    source_marker_count == 1
                    and len(matches) == 1
                    and _looks_like_chapter_heading(
                        line, match, title
                    )
                )
                occurrences.append(
                    {
                        "number": str(number),
                        "title": title,
                        "page_idx": block["page_idx"],
                        "kind": kind,
                        "is_heading": is_heading,
                        "printed_page": printed_page,
                        "source_ref": {
                            "page_idx": block["page_idx"],
                            "text": block["text"],
                            "kind": kind,
                        },
                    }
                )
    return occurrences, toc_start, toc_end


def extract_chapter_candidates(
    content: Any, page_count: int | None = None
) -> list[dict[str, Any]]:
    """Extract raw chapter candidates without changing source content.

    The returned entries intentionally include duplicates so callers can
    inspect repeated running headers.  Use
    :func:`build_mineru_structure_candidate` for a deduplicated structure.
    """

    del page_count
    blocks = _as_blocks(content)
    occurrences, _, _ = _chapter_occurrences(blocks)
    return occurrences


def _markdown_title_candidates(markdown: str | None) -> list[tuple[str, str]]:
    if not isinstance(markdown, str):
        return []
    output: list[tuple[str, str]] = []
    for line in markdown.splitlines():
        match = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if not match:
            continue
        title = re.sub(r"\s+", " ", match.group(1)).strip()
        chapter_match = _CHAPTER_RE.search(title)
        if chapter_match:
            number = _number_value(chapter_match.group("number"))
            if number is not None:
                cleaned, _ = _clean_title(title[chapter_match.end():])
                if cleaned:
                    output.append((str(number), cleaned))
    return output


def _markdown_heading_titles(markdown: str | None) -> list[str]:
    if not isinstance(markdown, str):
        return []
    return [
        re.sub(r"\s+", " ", match.group(1)).strip()
        for line in markdown.splitlines()
        if (match := re.match(r"^#{1,6}\s+(.+?)\s*$", line))
    ]


def _auxiliary_sections(
    blocks: list[dict[str, Any]], toc_start: int | None, toc_end: int | None
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[tuple[str, int, str]] = set()
    for block in blocks:
        page = block["page_idx"]
        if toc_start is not None and page < toc_start:
            continue
        if toc_end is not None and page > toc_end:
            continue
        for raw_line in _split_candidate_lines(block["normalized"]):
            match = _AUXILIARY_RE.search(raw_line)
            if not match:
                continue
            title, printed_page = _clean_title(match.group("title"))
            title = title or match.group("title").strip()
            kind_text = title.replace(" ", "")
            if kind_text.startswith("附录"):
                kind = "appendix"
            elif "参考文献" in kind_text:
                kind = "references"
            elif "索引" in kind_text:
                kind = "index"
            else:
                kind = "answer_key"
            key = (kind, page, title)
            if key in seen:
                continue
            seen.add(key)
            output.append(
                {
                    "kind": kind,
                    "title": title,
                    "page_start": page + 1,
                    "page_end": page + 1,
                    "printed_page": printed_page,
                    "source_refs": [
                        {"page_idx": page, "text": block["text"], "kind": "toc"}
                    ],
                }
            )
    return output


def build_mineru_structure_candidate(
    content: Any,
    markdown: str | None = None,
    *,
    page_count: int | None = None,
) -> dict[str, Any]:
    """Build an evidence-backed chapter candidate from a MinerU Content List.

    ``page_start``/``page_end`` are one-based physical PDF pages.  The raw
    zero-based MinerU locations remain available in ``page_idx_start`` and
    ``page_idx_end`` and in every ``source_ref``.  The function is
    deterministic; a later LLM step may propose a refinement, but it cannot
    change the evidence references or raw files through this API.
    """

    blocks = _as_blocks(content)
    if not blocks:
        raise StructureCandidateError("MinerU content-list 没有可分析的文本块")
    if page_count is None:
        page_count = max(block["page_idx"] for block in blocks) + 1
    if isinstance(page_count, bool) or not isinstance(page_count, int) or page_count <= 0:
        raise StructureCandidateError("page_count 必须是正整数")
    if any(block["page_idx"] >= page_count for block in blocks):
        raise StructureCandidateError("content-list page_idx 超出原 PDF 页数")

    occurrences, toc_start, toc_end = _chapter_occurrences(blocks)
    by_number: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in occurrences:
        by_number[item["number"]].append(item)
    markdown_by_number: dict[str, list[str]] = defaultdict(list)
    for number, title in _markdown_title_candidates(markdown):
        markdown_by_number[number].append(title)
    markdown_heading_titles = _markdown_heading_titles(markdown)

    chapters: list[dict[str, Any]] = []
    warnings: list[str] = []
    body_pages: dict[str, int] = {}
    for number, items in by_number.items():
        # Prefer an explicit chapter-heading occurrence over arbitrary body
        # paragraphs.  A paragraph can mention several future chapters and
        # would otherwise move their boundaries back to an earlier page.
        heading_items = [
            item
            for item in items
            if item.get("is_heading")
            and (toc_end is None or item["page_idx"] > toc_end)
        ]
        body_items = [
            item
            for item in items
            if (
                item.get("is_heading")
                and (toc_end is None or item["page_idx"] > toc_end)
            )
            or item["kind"] == "header"
            or (
                item["kind"] == "body"
                and (toc_end is None or item["page_idx"] > toc_end)
            )
        ]
        if heading_items:
            body_pages[number] = min(item["page_idx"] for item in heading_items)
        else:
            # Existing MinerU fixtures often expose only repeated running
            # headers.  Keep those as a conservative fallback, and only then
            # use a non-heading body occurrence.
            header_items = [item for item in body_items if item["kind"] == "header"]
            fallback_items = header_items or body_items
            if fallback_items:
                body_pages[number] = min(item["page_idx"] for item in fallback_items)

    numbers = sorted(int(number) for number in by_number)
    if numbers:
        chapter_numbers = [
            str(number) for number in range(1, max(numbers) + 1) if str(number) in by_number
        ]
    else:
        chapter_numbers = []
    if chapter_numbers != [str(index + 1) for index in range(len(chapter_numbers))]:
        warnings.append("章节编号不是从 1 开始的连续序列")
    body_order = [
        number
        for number, _page in sorted(body_pages.items(), key=lambda item: item[1])
    ]
    if body_order and body_order != chapter_numbers:
        warnings.append("正文中的章节顺序与章节编号不一致")

    for number in chapter_numbers:
        items = by_number[number]
        toc_items = [
            item for item in items if item["kind"] == "toc" and item["title"]
        ]
        explicit_body_items = [
            item
            for item in items
            if item.get("is_heading")
            and (toc_end is None or item["page_idx"] > toc_end)
            and item["title"]
        ]
        header_items = [
            item for item in items if item["kind"] == "header" and item["title"]
        ]
        body_items = [
            item
            for item in items
            if (
                item.get("is_heading")
                and (toc_end is None or item["page_idx"] > toc_end)
            )
            or item["kind"] == "header"
            or (
                item["kind"] == "body"
                and (toc_end is None or item["page_idx"] > toc_end)
            )
        ]
        # A body paragraph can start with “第 N 章 …” while discussing a
        # later topic. Prefer an explicit heading (or the TOC/header evidence)
        # before falling back to arbitrary body text so a single reference
        # cannot rename an entire chapter.
        title_items = toc_items or explicit_body_items or header_items or body_items or items
        title = title_items[0]["title"] if title_items else ""
        if not title and markdown_by_number[number]:
            title = markdown_by_number[number][0]
        if not title:
            warnings.append(f"第 {number} 章缺少可验证标题")
            title = f"第 {number} 章"
        if markdown_by_number:
            markdown_titles_for_number = markdown_by_number.get(number, [])
            if not markdown_titles_for_number:
                compact_title = _compact_text(title)
                if not any(
                    compact_title in _compact_text(markdown_title)
                    or _compact_text(markdown_title) in compact_title
                    for markdown_title in markdown_heading_titles
                    if compact_title and _compact_text(markdown_title)
                ):
                    warnings.append(f"第 {number} 章未在 Markdown 标题中找到对应标题")
            elif not any(
                _compact_text(title) in _compact_text(markdown_title)
                or _compact_text(markdown_title) in _compact_text(title)
                for markdown_title in markdown_titles_for_number
            ):
                warnings.append(f"第 {number} 章的目录标题与 Markdown 标题不一致")

        start_idx = body_pages.get(number)
        if start_idx is None:
            start_idx = min(item["page_idx"] for item in items)
            warnings.append(f"第 {number} 章没有正文页眉，章节边界需要复核")
        next_starts = [
            page
            for other, page in body_pages.items()
            if int(other) > int(number) and page > start_idx
        ]
        end_idx = min(next_starts) - 1 if next_starts else page_count - 1

        refs: list[dict[str, Any]] = []
        selected = toc_items[:1] + [
            item for item in body_items if item.get("title")
        ][:2]
        for item in selected:
            ref = item["source_ref"]
            if ref not in refs:
                refs.append(ref)
        if not refs:
            refs.append(items[0]["source_ref"])

        confidence = 0.95 if toc_items and body_items else 0.82 if toc_items else 0.68
        if not header_items:
            confidence -= 0.08
        chapters.append(
            {
                "number": number,
                "title": title,
                "page_start": start_idx + 1,
                "page_end": end_idx + 1,
                "page_idx_start": start_idx,
                "page_idx_end": end_idx,
                "printed_page": next(
                    (item["printed_page"] for item in toc_items if item["printed_page"]),
                    None,
                ),
                "source_refs": refs,
                "confidence": round(max(0.0, min(1.0, confidence)), 3),
            }
        )

    if len(chapters) < 1:
        warnings.append("未识别到可验证的章节候选")
    if numbers and len(chapters) != max(numbers):
        warnings.append("章节编号存在缺口，未自动补造缺失章节")

    auxiliary = _auxiliary_sections(blocks, toc_start, toc_end)
    diagnostics = {
        "toc_page_start": toc_start,
        "toc_page_end": toc_end,
        "chapter_numbers": [chapter["number"] for chapter in chapters],
        "raw_candidate_count": len(occurrences),
        "duplicate_candidate_count": max(0, len(occurrences) - len(chapters)),
        "needs_review": bool(warnings)
        or any(chapter["confidence"] < 0.8 for chapter in chapters),
    }
    if isinstance(markdown, str):
        normalized_markdown = markdown.replace("\r\n", "\n").replace("\r", "\n")
        diagnostics["markdown_sha256"] = hashlib.sha256(
            normalized_markdown.encode("utf-8")
        ).hexdigest()
        diagnostics["markdown_titles"] = [
            {"number": number, "title": title}
            for number, title in _markdown_title_candidates(markdown)
        ][:500]
    content_hash = _content_sha256(content)
    if content_hash:
        diagnostics["content_sha256"] = content_hash
    candidate = {
        "schema_version": STRUCTURE_CANDIDATE_SCHEMA,
        "chapters": chapters,
        "auxiliary_sections": auxiliary,
        "warnings": list(dict.fromkeys(warnings)),
        "diagnostics": diagnostics,
    }
    validate_structure_candidate(candidate, content, markdown, page_count=page_count)
    return candidate


def _compact_text(value: Any) -> str:
    """Normalize text for conservative title/evidence comparisons."""

    if not isinstance(value, str):
        return ""
    value = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\W_]+", "", value, flags=re.UNICODE)


def _proposal_ref_is_real(ref: Any, blocks: list[dict[str, Any]]) -> bool:
    if not isinstance(ref, dict):
        return False
    page = ref.get("page_idx")
    text = ref.get("text")
    if not isinstance(page, int) or page < 0 or not isinstance(text, str):
        return False
    return any(block["page_idx"] == page and block["text"] == text for block in blocks)


def merge_structure_proposal(
    candidate: dict[str, Any],
    proposal: dict[str, Any],
    content: Any,
    *,
    page_count: int | None = None,
) -> dict[str, Any]:
    """Merge a model proposal without allowing it to invent structure.

    Chapter numbers/order cannot change, every source reference must be copied
    verbatim from MinerU, and a proposed title must be supported by either the
    deterministic title or one of its cited source blocks. The raw content
    list and Markdown are never written by this function.
    """

    if not isinstance(proposal, dict) or proposal.get("schema_version") != "structure-proposal/1.0":
        raise StructureCandidateError("structure proposal schema_version is invalid")
    proposal_chapters = proposal.get("chapters")
    if not isinstance(proposal_chapters, list):
        raise StructureCandidateError("structure proposal chapters must be an array")

    validate_structure_candidate(candidate, content, page_count=page_count)
    if not isinstance(candidate.get("diagnostics"), dict):
        raise StructureCandidateError("structure candidate diagnostics must be an object")
    blocks = _as_blocks(content)
    base_chapters = candidate["chapters"]
    base_by_number = {str(item["number"]): item for item in base_chapters}
    proposed_by_number: dict[str, dict[str, Any]] = {}
    for item in proposal_chapters:
        if not isinstance(item, dict):
            raise StructureCandidateError("structure proposal chapter is invalid")
        number = str(item.get("number", ""))
        if number in proposed_by_number or number not in base_by_number:
            raise StructureCandidateError(
                "structure proposal may only refine existing chapter numbers"
            )
        proposed_by_number[number] = item
    if set(proposed_by_number) != set(base_by_number):
        raise StructureCandidateError(
            "structure proposal must preserve every deterministic chapter"
        )

    merged = {
        **candidate,
        "chapters": [dict(chapter) for chapter in base_chapters],
        "auxiliary_sections": list(candidate.get("auxiliary_sections", [])),
    }
    for chapter in merged["chapters"]:
        number = str(chapter["number"])
        item = proposed_by_number[number]
        title = item.get("title", chapter["title"])
        if not isinstance(title, str) or not title.strip():
            raise StructureCandidateError("structure proposal chapter title is empty")
        refs = item.get("source_refs", chapter["source_refs"])
        if not isinstance(refs, list) or not refs:
            raise StructureCandidateError("structure proposal chapter lacks evidence")
        if any(
            not isinstance(ref, dict)
            or not isinstance(ref.get("page_idx"), int)
            or not isinstance(ref.get("text"), str)
            or not _proposal_ref_is_real(ref, blocks)
            for ref in refs
        ):
            raise StructureCandidateError(
                "structure proposal cites text that is not present in MinerU output"
            )
        compact_title = _compact_text(title)
        markdown_titles = [
            item.get("title")
            for item in candidate.get("diagnostics", {}).get("markdown_titles", [])
            if isinstance(item, dict) and str(item.get("number")) == number
        ]
        supported_titles = [_compact_text(chapter["title"])] + [
            _compact_text(ref.get("text", "")) for ref in refs
        ] + [_compact_text(item) for item in markdown_titles]
        if not compact_title or not any(
            compact_title == supported
            or (
                len(compact_title) >= 3
                and (compact_title in supported or supported in compact_title)
            )
            for supported in supported_titles
            if supported
        ):
            raise StructureCandidateError(
                "structure proposal title is not supported by cited MinerU evidence"
            )
        start = item.get("page_start", chapter["page_start"])
        end = item.get("page_end", chapter["page_end"])
        if not isinstance(start, int) or not isinstance(end, int):
            raise StructureCandidateError("structure proposal page range is invalid")
        base_start = int(chapter["page_start"])
        base_end = int(chapter["page_end"])
        if start < base_start or end > base_end or end < start:
            raise StructureCandidateError(
                "structure proposal page range exceeds deterministic evidence"
            )
        chapter["title"] = title.strip()
        chapter["page_start"] = start
        chapter["page_end"] = end
        chapter["source_refs"] = refs
        confidence = item.get("confidence", chapter.get("confidence", 0.0))
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
            raise StructureCandidateError("structure proposal confidence is invalid")
        chapter["confidence"] = max(0.0, min(1.0, float(confidence)))

    # A proposal may explain or refine a warning, but it may not erase a
    # deterministic safety signal (for example a missing chapter number).
    # Keeping the base warnings guarantees that an LLM cannot turn an
    # incomplete candidate into an apparently approved outline merely by
    # returning an empty ``warnings`` array.
    merged["warnings"] = list(
        dict.fromkeys(
            [str(item) for item in candidate.get("warnings", []) if isinstance(item, str)]
            + [str(item) for item in proposal.get("warnings", []) if isinstance(item, str)]
        )
    )
    diagnostics = dict(candidate.get("diagnostics", {}))
    diagnostics["llm_refined"] = True
    diagnostics["needs_review"] = bool(merged["warnings"]) or any(
        float(chapter.get("confidence", 0.0)) < 0.8
        for chapter in merged["chapters"]
    )
    merged["diagnostics"] = diagnostics
    validate_structure_candidate(merged, content, page_count=page_count)
    return merged


def validate_structure_candidate(
    candidate: Any,
    content: Any,
    markdown: str | None = None,
    *,
    page_count: int | None = None,
) -> None:
    """Validate candidate identity and evidence without mutating any input."""

    blocks = _as_blocks(content)
    # Validate page/text pairs, not text alone, so a stale sidecar cannot
    # point a valid title at the wrong physical page.
    original_refs = {(block["page_idx"], block["text"]) for block in blocks}
    candidate_content_hash = (
        candidate.get("diagnostics", {}).get("content_sha256")
        if isinstance(candidate, dict)
        and isinstance(candidate.get("diagnostics"), dict)
        else None
    )
    if candidate_content_hash and candidate_content_hash != _content_sha256(content):
        raise StructureCandidateError(
            "structure candidate does not match the current MinerU content list"
        )
    if page_count is None:
        raw_page_count = max((block["page_idx"] for block in blocks), default=-1) + 1
        candidate_page_count = 0
        if isinstance(candidate, dict) and isinstance(candidate.get("chapters"), list):
            candidate_page_count = max(
                (
                    int(chapter.get("page_end", 0))
                    for chapter in candidate["chapters"]
                    if isinstance(chapter, dict)
                    and isinstance(chapter.get("page_end"), int)
                ),
                default=0,
            )
        page_count = max(raw_page_count, candidate_page_count)
    if not isinstance(candidate, dict) or candidate.get("schema_version") != STRUCTURE_CANDIDATE_SCHEMA:
        raise StructureCandidateError("结构候选 schema_version 无效")
    diagnostics = candidate.get("diagnostics", {})
    if isinstance(markdown, str) and isinstance(diagnostics, dict):
        expected_markdown_hash = diagnostics.get("markdown_sha256")
        if expected_markdown_hash:
            normalized_markdown = markdown.replace("\r\n", "\n").replace("\r", "\n")
            actual_markdown_hash = hashlib.sha256(
                normalized_markdown.encode("utf-8")
            ).hexdigest()
            if expected_markdown_hash != actual_markdown_hash:
                raise StructureCandidateError(
                    "structure candidate does not match the current raw Markdown"
                )
    chapters = candidate.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise StructureCandidateError("结构候选至少需要一个章节")
    previous_end = -1
    seen_numbers: set[str] = set()
    for index, chapter in enumerate(chapters):
        if not isinstance(chapter, dict):
            raise StructureCandidateError(f"结构候选章节 {index + 1} 无效")
        required = {
            "number",
            "title",
            "page_start",
            "page_end",
            "source_refs",
            "confidence",
        }
        if not required.issubset(chapter):
            raise StructureCandidateError(f"结构候选章节 {index + 1} 缺少字段")
        number = str(chapter["number"])
        if number in seen_numbers:
            raise StructureCandidateError(f"结构候选章节编号重复：{number}")
        seen_numbers.add(number)
        if not str(chapter["title"]).strip():
            raise StructureCandidateError(f"结构候选章节 {number} 标题为空")
        start = chapter["page_start"]
        end = chapter["page_end"]
        if (
            not isinstance(start, int)
            or not isinstance(end, int)
            or start < 1
            or end < start
            or end > page_count
        ):
            raise StructureCandidateError(f"结构候选章节 {number} 页范围无效")
        if start <= previous_end:
            raise StructureCandidateError(f"结构候选章节 {number} 页范围不单调")
        previous_end = end
        refs = chapter["source_refs"]
        if not isinstance(refs, list) or not refs:
            raise StructureCandidateError(f"结构候选章节 {number} 缺少来源证据")
        for ref in refs:
            if not isinstance(ref, dict):
                raise StructureCandidateError(f"结构候选章节 {number} 来源证据无效")
            page = ref.get("page_idx")
            text = ref.get("text")
            if not isinstance(page, int) or page < 0 or page >= page_count:
                raise StructureCandidateError(f"结构候选章节 {number} 来源页码无效")
            if not isinstance(text, str) or (page, text) not in original_refs:
                raise StructureCandidateError(f"结构候选章节 {number} 引用了不存在的原始文本")
        confidence = chapter["confidence"]
        if (
            not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or not 0 <= confidence <= 1
        ):
            raise StructureCandidateError(f"结构候选章节 {number} 置信度无效")

    auxiliary = candidate.get("auxiliary_sections", [])
    if not isinstance(auxiliary, list):
        raise StructureCandidateError("辅助材料候选必须是数组")
    for item in auxiliary:
        if not isinstance(item, dict) or not str(item.get("title") or "").strip():
            raise StructureCandidateError("辅助材料候选标题无效")
        for ref in item.get("source_refs", []):
            if (
                not isinstance(ref, dict)
                or not isinstance(ref.get("page_idx"), int)
                or (ref.get("page_idx"), ref.get("text")) not in original_refs
            ):
                raise StructureCandidateError("辅助材料候选引用了不存在的原始文本")
