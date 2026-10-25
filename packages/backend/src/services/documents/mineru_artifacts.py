"""Build canonical textbook artifacts from an evidence-checked MinerU pass.

MinerU's native table of contents and the Markdown heading levels are both
useful, but neither is authoritative on its own.  This module joins them by
chapter evidence and then reuses the existing line-addressable Markdown
material format.  It never edits the raw MinerU files.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from .markdown_parser import _headings, build_markdown_artifacts
from .store import DocumentParseError, OUTLINE_SCHEMA


def _compact(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    value = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\W_]+", "", value, flags=re.UNICODE)


def _heading_score(chapter: dict[str, Any], heading: Any, raw_line: str) -> int:
    number = str(chapter.get("number", ""))
    title = _compact(chapter.get("title", ""))
    heading_title = _compact(getattr(heading, "title", ""))
    if not title or not heading_title:
        return -1
    score = 0
    if heading_title == title:
        score = 100
    elif title in heading_title or heading_title in title:
        score = 85
    # Chapter 4 in the observed export has only a 4.1 heading; the TOC title
    # is still the stronger chapter title, so use the numbered first section
    # as a conservative fallback.
    heading_number = getattr(heading, "number", None)
    if isinstance(heading_number, tuple) and len(heading_number) >= 2:
        if str(heading_number[0]) == number and heading_number[1] == 1:
            score = max(score, 70)
    if re.search(rf"第\s*{re.escape(number)}\s*[章节篇部]", raw_line):
        score = max(score, 72)
    # Repeated bare chapter titles in answer keys/indexes often carry a
    # one-number parser annotation (``(4)``/``第4章``).  Prefer the body
    # heading (or its N.1 marker) over that later duplicate.
    if isinstance(heading_number, tuple) and len(heading_number) == 1:
        score -= 40
    return score


def _find_chapter_sections(
    markdown: str,
    candidate: dict[str, Any],
    sections: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], Any, int]]:
    lines = markdown.splitlines()
    headings = _headings(lines)
    section_by_line = {int(section["line_start"]): section for section in sections}
    # Once the Markdown reaches an appendix/index, repeated ``第 N 章``
    # answer headings must not be mistaken for the real chapter boundary.
    auxiliary_line = min(
        (
            int(heading.line)
            for heading in headings
            if _is_auxiliary_boundary_title(str(getattr(heading, "title", "")))
        ),
        default=len(lines) + 1,
    )
    matched: list[tuple[dict[str, Any], Any, int]] = []
    used_lines: set[int] = set()
    previous_line = 0
    for chapter in candidate["chapters"]:
        options: list[tuple[int, int, Any, dict[str, Any]]] = []
        for heading in headings:
            line = int(heading.line)
            if line <= previous_line or line in used_lines or line >= auxiliary_line:
                continue
            section = section_by_line.get(line)
            if section is None:
                continue
            raw_line = lines[line - 1] if 0 < line <= len(lines) else ""
            score = _heading_score(chapter, heading, raw_line)
            if score >= 70:
                options.append((score, line, heading, section))
        if not options:
            raise DocumentParseError(
                f"MinerU Markdown cannot locate chapter {chapter.get('number')}"
            )
        # Preserve document order. A later appendix can contain an exact copy
        # of a chapter title, while the first evidence-backed heading is the
        # real chapter boundary.
        _, line, heading, section = min(options, key=lambda item: item[1])
        matched.append((chapter, heading, sections.index(section)))
        used_lines.add(line)
        previous_line = line
    return matched


def _is_auxiliary_title(title: str) -> bool:
    compact = _compact(title)
    markers = (
        "附录",
        "习题答案",
        "自测题答案",
        "参考文献",
        "索引",
        "答案",
        "常用逻辑门",
        "芯片型号",
    )
    return any(marker in compact for marker in markers)


def _is_auxiliary_boundary_title(title: str) -> bool:
    """Identify the start of appendix/reference material, not cross-links.

    Main-text headings such as ``习题（答案见附录 D）`` mention an answer but
    are still part of the chapter. Only a heading that starts an auxiliary
    section may terminate the chapter search window.
    """

    compact = _compact(title)
    if "答案见附录" in compact or "答案见" in compact:
        return False
    return compact.startswith(
        (
            "附录",
            "习题答案",
            "自测题答案",
            "参考文献",
            "索引",
            "常用逻辑门",
            "芯片型号",
        )
    )


def build_mineru_markdown_artifacts(
    markdown: str,
    candidate: dict[str, Any],
    *,
    document_id: str,
    filename: str,
    sha256: str,
    parser_name: str,
    page_count: int,
    toc_pages: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return a canonical outline/material pair for a MinerU document.

    The chapter list and chapter titles come from the validated MinerU
    candidate. Point titles and line evidence come from the immutable Markdown
    export.  A mismatch is a hard parse error; the old behavior of silently
    replacing the native outline with an unrelated Markdown outline is not
    allowed.
    """

    derived_outline, material = build_markdown_artifacts(
        markdown,
        document_id=document_id,
        filename=filename,
        sha256=sha256,
        parser_name=parser_name,
    )
    sections = material["sections"]
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    headings = _headings(lines)
    headings_by_line = {int(heading.line): heading for heading in headings}
    matched = _find_chapter_sections(markdown, candidate, sections)
    auxiliary_lines = [
        int(heading.line)
        for heading in headings
        if _is_auxiliary_boundary_title(str(getattr(heading, "title", "")))
    ]
    main_section_end = len(sections)
    if auxiliary_lines:
        first_auxiliary_line = min(auxiliary_lines)
        main_section_end = next(
            (
                index
                for index, section in enumerate(sections)
                if int(section["line_start"]) >= first_auxiliary_line
            ),
            len(sections),
        )

    chapter_records: list[dict[str, Any]] = []
    point_sources: list[dict[str, Any]] = []
    chunks_by_section: dict[str, list[str]] = {}
    for chunk in material["chunks"]:
        for section_id in chunk["section_ids"]:
            chunks_by_section.setdefault(section_id, []).append(chunk["id"])

    for index, (candidate_chapter, heading, section_index) in enumerate(matched):
        next_section_index = (
            matched[index + 1][2]
            if index + 1 < len(matched)
            else main_section_end
        )
        chapter_number = str(candidate_chapter["number"])
        chapter_section = sections[section_index]
        chapter_heading_level = int(heading.level)
        segment = sections[section_index:next_section_index]

        numbered_points: list[dict[str, Any]] = []
        chapter_number_tuple = getattr(heading, "number", None)
        if (
            isinstance(chapter_number_tuple, tuple)
            and len(chapter_number_tuple) == 2
            and str(chapter_number_tuple[0]) == chapter_number
            and int(chapter_number_tuple[1]) == 1
        ):
            # Some MinerU exports omit a separate ``## Chapter N`` heading and
            # begin directly at ``N.1``.  That heading is a textbook point,
            # not disposable chapter metadata.
            numbered_points.append(chapter_section)
        for section in segment[1:]:
            section_heading = headings_by_line.get(int(section["line_start"]))
            number = getattr(section_heading, "number", None)
            if (
                isinstance(number, tuple)
                and len(number) == 2
                and str(number[0]) == chapter_number
            ):
                numbered_points.append(section)
        points_sections = numbered_points
        if not points_sections:
            descendants = [
                section
                for section in segment[1:]
                if int(section["heading_level"]) > chapter_heading_level
                and not _is_auxiliary_title(str(section["title"]))
            ]
            if descendants:
                point_level = min(int(section["heading_level"]) for section in descendants)
                points_sections = [
                    section
                    for section in descendants
                    if int(section["heading_level"]) == point_level
                ]
        if not points_sections:
            points_sections = [chapter_section]

        points: list[dict[str, Any]] = []
        seen_numbers: set[str] = set()
        for point_index, point_section in enumerate(points_sections):
            point_heading = headings_by_line.get(int(point_section["line_start"]))
            point_number_tuple = getattr(point_heading, "number", None)
            if (
                isinstance(point_number_tuple, tuple)
                and len(point_number_tuple) == 2
                and str(point_number_tuple[0]) == chapter_number
            ):
                point_number = ".".join(str(part) for part in point_number_tuple)
            elif point_section is chapter_section:
                point_number = chapter_number
            else:
                point_number = f"{chapter_number}.{point_index + 1}"
            if point_number in seen_numbers:
                raise DocumentParseError(
                    f"MinerU Markdown has duplicate point number {point_number}"
                )
            seen_numbers.add(point_number)

            point_start = sections.index(point_section)
            point_end = (
                sections.index(points_sections[point_index + 1])
                if point_index + 1 < len(points_sections)
                else next_section_index
            )
            section_ids = [
                str(section["id"]) for section in sections[point_start:point_end]
            ]
            # Introductory prose between the chapter heading and its first
            # numbered section belongs to the first point's evidence.
            if point_section is not chapter_section and point_index == 0:
                section_ids = [
                    str(section["id"])
                    for section in sections[section_index:point_start]
                ] + section_ids
            section_ids = list(dict.fromkeys(section_ids))
            point_id = f"point-{point_number.replace('.', '-') }"
            points.append(
                {
                    "id": point_id,
                    "number": point_number,
                    "title": str(point_section["title"]),
                    "page": None,
                    "order": point_index,
                    "origin": "textbook",
                    "source_refs": section_ids,
                }
            )
            chunk_ids = list(
                dict.fromkeys(
                    chunk_id
                    for section_id in section_ids
                    for chunk_id in chunks_by_section.get(section_id, [])
                )
            )
            point_sources.append(
                {
                    "point_id": point_id,
                    "section_ids": section_ids,
                    "chunk_ids": chunk_ids,
                }
            )

        chapter_records.append(
            {
                "id": f"chapter-{chapter_number}",
                "number": chapter_number,
                "title": str(candidate_chapter["title"]),
                "page": int(candidate_chapter["page_start"]),
                "order": index,
                "points": points,
            }
        )

    material["point_sources"] = point_sources
    outline = {
        "schema_version": OUTLINE_SCHEMA,
        "document_id": document_id,
        "title": str(derived_outline["title"]),
        "source": {
            "filename": filename,
            "sha256": sha256,
            "page_count": int(page_count),
            "parser": parser_name,
            "toc_pages": int(toc_pages),
        },
        "chapters": chapter_records,
    }
    return outline, material


__all__ = ["build_mineru_markdown_artifacts"]
