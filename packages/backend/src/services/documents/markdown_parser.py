"""Normalize a MinerU-style Markdown textbook into outline and material contracts.

The parser is deliberately deterministic and local.  It preserves the source
Markdown byte-for-byte in the document store, then records line-addressable
sections/chunks so later model calls can read only the evidence needed for one
knowledge point.  It does not attempt to enrich or rewrite the textbook.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
from typing import Any

from .store import DocumentParseError, OUTLINE_SCHEMA


MATERIAL_SCHEMA = "textbook-material/1.0"
MARKDOWN_PARSER_NAME = "markdown-import"
DEFAULT_CHUNK_CHARACTERS = 12_000

_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
_FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)")
_NUMBER_PREFIX_RE = re.compile(
    r"^(?:第\s*[0-9一二三四五六七八九十百千]+\s*[章节篇部]\s*|"
    r"[0-9]+(?:\.[0-9]+)*[.、)）:\s-]+)"
)
_ARABIC_HEADING_NUMBER_RE = re.compile(
    r"^\s*(?P<number>[0-9]+(?:\.[0-9]+)*)"
    r"(?:(?:[.、)）:：-]+[ \t]*)|[ \t]+)(?P<title>.+?)\s*$"
)
_CHINESE_CHAPTER_NUMBER_RE = re.compile(
    r"^\s*第\s*(?P<number>[0-9一二三四五六七八九十百千]+)"
    r"\s*[章节篇部]\s*(?P<title>.*?)\s*$"
)
_CHINESE_DIGITS = {
    "零": 0,
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_CHINESE_UNITS = {"十": 10, "百": 100, "千": 1000}
_FRONT_MATTER_TITLES = {"目录", "阅读指南", "前言", "序言"}


@dataclass(frozen=True, slots=True)
class _Heading:
    level: int
    title: str
    line: int
    number: tuple[int, ...] | None


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _clean_title(value: str) -> str:
    title = re.sub(r"\s+", " ", value).strip()
    cleaned = _NUMBER_PREFIX_RE.sub("", title).strip()
    return cleaned or title


def _chinese_integer(value: str) -> int | None:
    if value.isdigit():
        return int(value)
    if not value or any(
        character not in _CHINESE_DIGITS and character not in _CHINESE_UNITS
        for character in value
    ):
        return None
    if all(character in _CHINESE_DIGITS for character in value):
        return int("".join(str(_CHINESE_DIGITS[character]) for character in value))

    total = 0
    digit = 0
    for character in value:
        if character in _CHINESE_DIGITS:
            digit = _CHINESE_DIGITS[character]
            continue
        unit = _CHINESE_UNITS[character]
        total += (digit or 1) * unit
        digit = 0
    return total + digit


def _heading_number(value: str) -> tuple[int, ...] | None:
    arabic = _ARABIC_HEADING_NUMBER_RE.match(value)
    if arabic:
        return tuple(int(part) for part in arabic.group("number").split("."))
    chinese = _CHINESE_CHAPTER_NUMBER_RE.match(value)
    if chinese:
        number = _chinese_integer(chinese.group("number"))
        if number is not None:
            return (number,)
    return None


def _headings(lines: list[str]) -> list[_Heading]:
    headings: list[_Heading] = []
    fence: str | None = None
    for line_number, line in enumerate(lines, start=1):
        fence_match = _FENCE_RE.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence is None:
                fence = marker[0]
            elif marker[0] == fence:
                fence = None
            continue
        if fence is not None:
            continue
        match = _HEADING_RE.match(line)
        if match:
            raw_title = match.group(2)
            title = _clean_title(raw_title)
            if title:
                headings.append(
                    _Heading(
                        len(match.group(1)),
                        title,
                        line_number,
                        _heading_number(raw_title),
                    )
                )
    return headings


def _heading_subtree_end(headings: list[_Heading], start: int) -> int:
    current = headings[start]
    for index in range(start + 1, len(headings)):
        if headings[index].level <= current.level:
            return index
    return len(headings)


def _numbered_chapter_headings(headings: list[_Heading]) -> list[_Heading]:
    """Return the strongest contiguous 1, 2, ... chapter run, if present."""

    best: list[_Heading] = []
    best_score = (0, 0)
    for level in sorted({heading.level for heading in headings}):
        candidates = [
            (index, heading)
            for index, heading in enumerate(headings)
            if heading.level == level
            and heading.number is not None
            and len(heading.number) == 1
        ]
        for candidate_index, (_, heading) in enumerate(candidates):
            if heading.number != (1,):
                continue
            run = [heading]
            expected = 2
            for _, next_heading in candidates[candidate_index + 1 :]:
                if next_heading.number == (expected,):
                    run.append(next_heading)
                    expected += 1
                elif next_heading.number and next_heading.number[0] >= expected:
                    break

            point_count = 0
            for chapter in run:
                chapter_index = headings.index(chapter)
                chapter_end = _heading_subtree_end(headings, chapter_index)
                point_count += sum(
                    child.number is not None
                    and len(child.number) == 2
                    and child.number[0] == chapter.number[0]
                    and child.level > chapter.level
                    for child in headings[chapter_index + 1 : chapter_end]
                )
            score = (point_count, len(run))
            if point_count and score > best_score:
                best = run
                best_score = score
    return best


def _document_and_chapter_level(
    headings: list[_Heading], filename: str
) -> tuple[str, int, int | None, list[_Heading] | None]:
    numbered_chapters = _numbered_chapter_headings(headings)
    if numbered_chapters:
        first_chapter = numbered_chapters[0]
        first = headings[0]
        if (
            first.line < first_chapter.line
            and first.number is None
            and first.title not in _FRONT_MATTER_TITLES
        ):
            return first.title, first_chapter.level, first.line, numbered_chapters
        return (
            Path(filename).stem.strip() or "Markdown 教材",
            first_chapter.level,
            None,
            numbered_chapters,
        )

    minimum = min(heading.level for heading in headings)
    at_minimum = [heading for heading in headings if heading.level == minimum]
    first = headings[0]
    deeper_levels = sorted({heading.level for heading in headings if heading.level > minimum})

    # A single top-level heading followed by deeper headings is the usual
    # MinerU export shape: book title, chapter headings, section headings.
    if len(at_minimum) == 1 and first.level == minimum and deeper_levels:
        return first.title, deeper_levels[0], first.line, None
    return Path(filename).stem.strip() or "Markdown 教材", minimum, None, None


def _slice_text(lines: list[str], start: int, end: int) -> str:
    content = "\n".join(lines[start - 1 : end])
    return content + ("\n" if end < len(lines) else "")


def _asset_refs(value: str) -> list[str]:
    refs: list[str] = []
    for match in _IMAGE_RE.finditer(value):
        ref = (match.group(1) or match.group(2) or "").strip()
        if ref and ref not in refs:
            refs.append(ref)
    return refs


def _section_records(
    lines: list[str], headings: list[_Heading], document_title_line: int | None
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    path_stack: list[tuple[int, str]] = []
    usable = [heading for heading in headings if heading.line != document_title_line]
    for index, heading in enumerate(usable):
        while path_stack and path_stack[-1][0] >= heading.level:
            path_stack.pop()
        path_stack.append((heading.level, heading.title))
        next_line = usable[index + 1].line if index + 1 < len(usable) else len(lines) + 1
        line_end = max(heading.line, next_line - 1)
        content = _slice_text(lines, heading.line, line_end)
        records.append(
            {
                "id": f"block-{index + 1:06d}",
                "order": index,
                "type": "section",
                "title": heading.title,
                "heading_level": heading.level,
                "heading_path": [title for _, title in path_stack],
                "line_start": heading.line,
                "line_end": line_end,
                "page": None,
                "asset_refs": _asset_refs(content),
                "sha256": _sha256_text(content),
            }
        )
    return records


def _chunk_records(
    lines: list[str], sections: list[dict[str, Any]], max_characters: int
) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for section in sections:
        start = int(section["line_start"])
        end = int(section["line_end"])
        part_start = start
        current_characters = 0
        for line_number in range(start, end + 1):
            line_size = len(lines[line_number - 1]) + 1
            if current_characters and current_characters + line_size > max_characters:
                chunks.append(
                    _make_chunk(lines, section, part_start, line_number - 1, len(chunks))
                )
                part_start = line_number
                current_characters = 0
            current_characters += line_size
        chunks.append(_make_chunk(lines, section, part_start, end, len(chunks)))
    return chunks


def _make_chunk(
    lines: list[str], section: dict[str, Any], start: int, end: int, index: int
) -> dict[str, Any]:
    content = _slice_text(lines, start, end)
    return {
        "id": f"chunk-{index + 1:06d}",
        "order": index,
        "section_ids": [section["id"]],
        "heading_path": list(section["heading_path"]),
        "line_start": start,
        "line_end": end,
        "page": section["page"],
        "asset_refs": _asset_refs(content),
        "sha256": _sha256_text(content),
    }


def _outline_from_sections(
    sections: list[dict[str, Any]], *, document_id: str, filename: str,
    sha256: str, title: str, chapter_level: int, parser_name: str,
    headings: list[_Heading], numbered_chapters: list[_Heading] | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    sections_by_line = {int(section["line_start"]): section for section in sections}
    if numbered_chapters:
        chapter_sections = [
            sections_by_line[heading.line]
            for heading in numbered_chapters
            if heading.line in sections_by_line
        ]
    else:
        chapter_sections = [
            section for section in sections if section["heading_level"] == chapter_level
        ]
    if not chapter_sections:
        raise DocumentParseError("Markdown 中没有可识别的章节标题")

    headings_by_line = {heading.line: heading for heading in headings}
    section_position = {section["id"]: index for index, section in enumerate(sections)}
    point_sources: list[dict[str, Any]] = []
    chapters: list[dict[str, Any]] = []
    for chapter_index, chapter_section in enumerate(chapter_sections):
        chapter_heading = headings_by_line[int(chapter_section["line_start"])]
        chapter_number = (
            str(chapter_heading.number[0])
            if numbered_chapters and chapter_heading.number is not None
            else str(chapter_index + 1)
        )
        start = section_position[chapter_section["id"]]
        end = len(sections)
        for section_index in range(start + 1, len(sections)):
            if int(sections[section_index]["heading_level"]) <= int(
                chapter_section["heading_level"]
            ):
                end = section_index
                break
        descendants = [
            section for section in sections[start + 1 : end]
            if section["heading_level"] > chapter_level
        ]
        numbered_points = [
            section
            for section in descendants
            if (
                (heading := headings_by_line[int(section["line_start"])]).number
                is not None
                and len(heading.number) == 2
                and heading.number[0] == int(chapter_number)
            )
        ]
        if numbered_points:
            point_level = min(
                int(section["heading_level"]) for section in numbered_points
            )
            point_sections = [
                section
                for section in numbered_points
                if int(section["heading_level"]) == point_level
            ]
        elif descendants:
            point_level = min(int(section["heading_level"]) for section in descendants)
            point_sections = [
                section
                for section in descendants
                if int(section["heading_level"]) == point_level
            ]
        else:
            point_sections = [chapter_section]

        points: list[dict[str, Any]] = []
        for point_index, point_section in enumerate(point_sections):
            point_heading = headings_by_line[int(point_section["line_start"])]
            point_number = (
                ".".join(str(part) for part in point_heading.number)
                if point_section is not chapter_section
                and point_heading.number is not None
                and len(point_heading.number) == 2
                and point_heading.number[0] == int(chapter_number)
                else (
                    chapter_number
                    if point_section is chapter_section
                    else f"{chapter_number}.{point_index + 1}"
                )
            )
            point_id = f"point-{point_number.replace('.', '-')}"
            point_start = section_position[point_section["id"]]
            point_end = (
                section_position[point_sections[point_index + 1]["id"]]
                if point_index + 1 < len(point_sections)
                else end
            )
            block_ids = [
                section["id"] for section in sections[point_start:point_end]
            ]
            # Preserve chapter-level introductory prose as evidence for the
            # first knowledge point instead of leaving it unreachable.
            if point_section is not chapter_section and point_index == 0:
                block_ids = [
                    section["id"] for section in sections[start:point_start]
                ] + block_ids
            points.append(
                {
                    "id": point_id,
                    "number": point_number,
                    "title": point_section["title"],
                    "page": point_section["page"],
                    "order": point_index,
                    "origin": "textbook",
                    "source_refs": block_ids,
                }
            )
            point_sources.append(
                {"point_id": point_id, "section_ids": block_ids, "chunk_ids": []}
            )
        chapters.append(
            {
                "id": f"chapter-{chapter_number}",
                "number": chapter_number,
                "title": chapter_section["title"],
                "page": chapter_section["page"],
                "order": chapter_index,
                "points": points,
            }
        )

    outline = {
        "schema_version": OUTLINE_SCHEMA,
        "document_id": document_id,
        "title": title,
        "source": {
            "filename": filename,
            "sha256": sha256,
            "page_count": None,
            "parser": parser_name,
            "toc_pages": None,
        },
        "chapters": chapters,
    }
    return outline, point_sources


def build_markdown_artifacts(
    markdown: str,
    *,
    document_id: str,
    filename: str,
    sha256: str,
    parser_name: str = MARKDOWN_PARSER_NAME,
    max_chunk_characters: int = DEFAULT_CHUNK_CHARACTERS,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return a two-level outline plus line-addressable textbook material."""

    if not isinstance(markdown, str) or not markdown.strip():
        raise DocumentParseError("Markdown 教材不能为空")
    if "\x00" in markdown:
        raise DocumentParseError("Markdown 教材包含无效的 NUL 字符")
    if max_chunk_characters < 1000:
        raise ValueError("max_chunk_characters must be at least 1000")

    normalized = markdown.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    headings = _headings(lines)
    if not headings:
        raise DocumentParseError("Markdown 中没有可识别的 ATX 标题（# 标题）")
    title, chapter_level, title_line, numbered_chapters = (
        _document_and_chapter_level(headings, filename)
    )
    sections = _section_records(lines, headings, title_line)
    if not sections:
        raise DocumentParseError("Markdown 中没有可作为教材结构的章节")
    chunks = _chunk_records(lines, sections, max_chunk_characters)
    outline, point_sources = _outline_from_sections(
        sections,
        document_id=document_id,
        filename=filename,
        sha256=sha256,
        title=title,
        chapter_level=chapter_level,
        parser_name=parser_name,
        headings=headings,
        numbered_chapters=numbered_chapters,
    )
    chunks_by_section: dict[str, list[str]] = {}
    for chunk in chunks:
        for section_id in chunk["section_ids"]:
            chunks_by_section.setdefault(section_id, []).append(chunk["id"])
    for point_source in point_sources:
        point_source["chunk_ids"] = [
            chunk_id
            for section_id in point_source["section_ids"]
            for chunk_id in chunks_by_section.get(section_id, [])
        ]

    material = {
        "schema_version": MATERIAL_SCHEMA,
        "document_id": document_id,
        "source": {
            "format": "markdown",
            "filename": filename,
            "sha256": sha256,
            "parser": parser_name,
        },
        "markdown": {
            "path": "full.md",
            "sha256": _sha256_text(normalized),
            "line_count": len(lines),
            "character_count": len(normalized),
        },
        "sections": sections,
        "chunks": chunks,
        "point_sources": point_sources,
    }
    return outline, material


def parse_markdown_document(
    path: Path,
    *,
    document_id: str,
    filename: str,
    sha256: str,
    scan_pages: int,
    executable: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    """DocumentStore parser callback for an already-uploaded Markdown file."""

    del scan_pages, executable, timeout_seconds
    try:
        markdown = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        raise DocumentParseError("Markdown 教材必须是可读取的 UTF-8 文本") from exc
    normalized = markdown.replace("\r\n", "\n").replace("\r", "\n")
    outline, material = build_markdown_artifacts(
        normalized,
        document_id=document_id,
        filename=filename,
        sha256=sha256,
    )
    return {"outline": outline, "material": material, "markdown": normalized}
