"""Local PDF table-of-contents parser backed by Poppler's pdftotext."""

from __future__ import annotations

from pathlib import Path
import re
import shutil
import subprocess
from typing import Any

from pypdf import PdfReader

from .store import (
    LOCAL_PARSER_NAME,
    OUTLINE_SCHEMA,
    DocumentParseError,
    DocumentParserUnavailableError,
)


_TOC_HEADING_RE = re.compile(r"^\s*目\s*录\s*$")
_ENTRY_RE = re.compile(
    r"^\s*(?P<number>\d+(?:\.\d+)*)\s+"
    r"(?P<title>.*?\S)"
    r"(?P<leader>(?:\s*[.·…]\s*){2,}|\s{2,})"
    r"(?P<page>\d+)\s*$"
)
# Some books put front matter (for example, ``前言`` or ``安装``) in the
# table of contents without assigning it a numeric chapter.  Keep the same
# dotted-leader requirement as numbered entries so ordinary prose and page
# headers are not mistaken for TOC rows.  The caller rejects lines beginning
# with a digit before using this fallback, so malformed numbered rows are not
# silently reclassified as unnumbered entries.
_UNNUMBERED_ENTRY_RE = re.compile(
    r"^\s*(?P<title>.*?\S)"
    r"(?P<leader>(?:\s*[.·…]\s*){2,}|\s{2,})"
    r"(?P<page>\d+)\s*$"
)
_SPACE_RE = re.compile(r"\s+")
_TRAILING_PAGE_RE = re.compile(r"(?P<page>\d+)\s*$")
_STANDALONE_PAGE_RE = re.compile(r"^(?P<indent>\s*)(?P<page>\d{1,3})\s*$")
_UNNUMBERED_CHAPTER_NUMBER = "0"
_UNNUMBERED_CHAPTER_ID = "chapter-0"
_UNNUMBERED_CHAPTER_TITLE = "未编号目录项"


def _pdf_page_count(path: Path) -> int:
    try:
        reader = PdfReader(str(path), strict=False)
        if reader.is_encrypted:
            try:
                unlocked = reader.decrypt("")
            except Exception as exc:
                raise DocumentParseError("PDF 已加密，无法读取目录") from exc
            if not unlocked:
                raise DocumentParseError("PDF 已加密，无法读取目录")
        page_count = len(reader.pages)
    except DocumentParseError:
        raise
    except Exception as exc:
        raise DocumentParseError("无法读取 PDF 页数，文件可能已损坏") from exc
    if page_count <= 0:
        raise DocumentParseError("PDF 不包含可读取页面")
    return page_count


def _extract_toc_text(
    path: Path,
    *,
    executable: str,
    scan_pages: int,
    timeout_seconds: float,
) -> str:
    command = shutil.which(executable)
    if command is None:
        raise DocumentParserUnavailableError(
            "本地 PDF 解析器不可用：请安装 Poppler pdftotext"
        )
    args = [
        command,
        "-f",
        "1",
        "-l",
        str(scan_pages),
        "-layout",
        "-enc",
        "UTF-8",
        str(path),
        "-",
    ]
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise DocumentParseError("PDF 目录提取超时") from exc
    except OSError as exc:
        raise DocumentParserUnavailableError("无法启动本地 PDF 解析器") from exc
    if result.returncode != 0:
        raise DocumentParseError("本地 PDF 解析器未能读取该文件")
    try:
        text = result.stdout.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise DocumentParseError("PDF 目录文本不是有效的 UTF-8") from exc
    if not text.strip():
        raise DocumentParseError("PDF 前几页没有可提取的文本目录")
    return text


def _parse_entry(line: str) -> tuple[str, str, int] | None:
    match = _ENTRY_RE.match(line)
    if match is None:
        return None
    number = match.group("number")
    title = _SPACE_RE.sub(" ", match.group("title")).strip(" .·…\t")
    if not title:
        return None
    try:
        page = int(match.group("page"))
    except ValueError:
        return None
    if page <= 0:
        return None
    return number, title, page


def _parse_unnumbered_entry(line: str) -> tuple[None, str, int] | None:
    """Parse a TOC row that has a title and page but no chapter number."""

    # A numbered row that failed _ENTRY_RE must not be treated as a front
    # matter row.  This also reserves ``0`` for the synthetic chapter below.
    if re.match(r"^\s*\d", line):
        return None
    match = _UNNUMBERED_ENTRY_RE.match(line)
    if match is None:
        return None
    title = _SPACE_RE.sub(" ", match.group("title")).strip(" .·…\t")
    if not title:
        return None
    # A book may repeat the TOC heading itself as a dotted row on trailing
    # index pages (for example ``目录 ........ 3``).  It is a navigation
    # heading, not a front-matter chapter, and must not become a synthetic
    # ``chapter-0`` knowledge point.  Compare the normalized title with the
    # same heading matcher used to locate the first TOC page.
    if _TOC_HEADING_RE.fullmatch(title):
        return None
    try:
        page = int(match.group("page"))
    except ValueError:
        return None
    if page <= 0:
        return None
    return None, title, page


def _parse_toc_line(line: str) -> tuple[str | None, str, int] | None:
    return _parse_entry(line) or _parse_unnumbered_entry(line)


def _next_entry_page(lines: list[str], start: int) -> int | None:
    for line in lines[start:]:
        entry = _parse_toc_line(line)
        if entry is not None:
            return entry[2]
    return None


def _page_entries(page_text: str) -> list[tuple[str | None, str, int]]:
    """Parse one TOC page, repairing a page number wrapped onto the next line.

    Poppler occasionally emits a page such as ``68`` as ``6`` followed by a
    right-aligned ``8`` on the next line.  A repair is accepted only when the
    two fragments occupy the same text column and the joined page restores
    nondecreasing TOC page order.  This avoids consuming an unrelated printed
    page footer.
    """

    lines = page_text.splitlines()
    entries: list[tuple[str | None, str, int]] = []
    previous_page: int | None = None
    line_index = 0
    while line_index < len(lines):
        line = lines[line_index]
        entry = _parse_toc_line(line)
        continuation = (
            _STANDALONE_PAGE_RE.fullmatch(lines[line_index + 1])
            if line_index + 1 < len(lines)
            else None
        )
        consumed_continuation = False

        if continuation is not None:
            continuation_text = continuation.group("page")
            if entry is None:
                # A row whose complete page moved to the next line cannot be
                # parsed until the continuation is appended.  Dotted leaders
                # remain mandatory through _parse_toc_line.
                candidate = _parse_toc_line(f"{line.rstrip()} {continuation_text}")
                if candidate is not None:
                    next_page = _next_entry_page(lines, line_index + 2)
                    candidate_page = candidate[2]
                    if (
                        (previous_page is None or candidate_page >= previous_page)
                        and (next_page is None or candidate_page <= next_page)
                    ):
                        entry = candidate
                        consumed_continuation = True
            elif previous_page is not None and entry[2] < previous_page:
                trailing_page = _TRAILING_PAGE_RE.search(line)
                if trailing_page is not None:
                    current_column = trailing_page.start("page")
                    continuation_column = len(continuation.group("indent"))
                    if abs(current_column - continuation_column) <= 2:
                        joined_page = int(f"{trailing_page.group('page')}{continuation_text}")
                        next_page = _next_entry_page(lines, line_index + 2)
                        if (
                            joined_page >= previous_page
                            and (next_page is None or joined_page <= next_page)
                        ):
                            entry = (entry[0], entry[1], joined_page)
                            consumed_continuation = True

        if entry is not None:
            entries.append(entry)
            previous_page = entry[2]
        line_index += 2 if consumed_continuation else 1
    return entries


def parse_toc_text(text: str) -> list[dict[str, Any]]:
    """Parse TOC entries and flatten all descendants into chapter points.

    Numbered chapters retain their source numbers.  Unnumbered rows are kept
    in a reserved synthetic ``chapter-0`` inserted at the first such row; the
    rows become ``0.1``, ``0.2`` ... textbook points in source order.  This
    keeps the v1 two-level JSON contract while preventing front matter from
    disappearing silently.  If a book has unnumbered blocks both before and
    after numbered chapters, they share this bucket and retain their order
    within it.
    """

    pages = text.replace("\r\n", "\n").replace("\r", "\n").split("\f")
    toc_page_index: int | None = None
    for page_index, page_text in enumerate(pages):
        if any(_TOC_HEADING_RE.fullmatch(line) for line in page_text.splitlines()):
            toc_page_index = page_index
            break
    if toc_page_index is None:
        raise DocumentParseError("未在 PDF 前几页找到“目录”标题")

    entries: list[tuple[str | None, str, int]] = []
    saw_entries = False
    for page_text in pages[toc_page_index:]:
        page_entries = _page_entries(page_text)
        if page_entries:
            entries.extend(page_entries)
            saw_entries = True
        elif saw_entries:
            # TOC pages are consecutive. Stopping here prevents chapter-body
            # headings in the remainder of the scan window from becoming duplicates.
            break

    chapters: list[dict[str, Any]] = []
    chapters_by_number: dict[str, dict[str, Any]] = {}
    seen_numbers: set[str] = set()
    seen_unnumbered: set[tuple[str, int]] = set()
    unnumbered_chapter: dict[str, Any] | None = None
    for number, title, page in entries:
        if number is None:
            key = (title, page)
            if key in seen_unnumbered:
                continue
            seen_unnumbered.add(key)
            if unnumbered_chapter is None:
                # ``0`` is reserved for this compatibility bucket.  A real
                # source chapter numbered 0 would be ambiguous and is
                # rejected below rather than being silently re-parented.
                if "0" in chapters_by_number:
                    raise DocumentParseError(
                        "目录同时包含编号 0 和无编号条目，无法保持两层结构"
                    )
                unnumbered_chapter = {
                    "id": _UNNUMBERED_CHAPTER_ID,
                    "number": _UNNUMBERED_CHAPTER_NUMBER,
                    "title": _UNNUMBERED_CHAPTER_TITLE,
                    "page": page,
                    "order": len(chapters),
                    "points": [],
                }
                chapters.append(unnumbered_chapter)
            point_index = len(unnumbered_chapter["points"])
            unnumbered_chapter["points"].append(
                {
                    "id": f"point-0-{point_index + 1}",
                    "number": f"0.{point_index + 1}",
                    "title": title,
                    "page": page,
                    "order": point_index,
                    "origin": "textbook",
                }
            )
            continue
        if number in seen_numbers:
            continue
        seen_numbers.add(number)
        parts = number.split(".")
        if len(parts) == 1:
            chapter = {
                "id": f"chapter-{number}",
                "number": number,
                "title": title,
                "page": page,
                "order": len(chapters),
                "points": [],
            }
            chapters.append(chapter)
            chapters_by_number[number] = chapter
            continue
        chapter = chapters_by_number.get(parts[0])
        if chapter is None:
            continue
        chapter["points"].append(
            {
                "id": f"point-{number.replace('.', '-')}",
                "number": number,
                "title": title,
                "page": page,
                "order": len(chapter["points"]),
                "origin": "textbook",
            }
        )

    if not chapters:
        raise DocumentParseError("目录中没有识别到章节或无编号目录项")
    if not any(chapter["points"] for chapter in chapters):
        raise DocumentParseError("目录中没有识别到编号知识点")
    # Some textbooks have a numbered introduction without numbered
    # subsections. Keep that chapter in the two-level contract by treating the
    # chapter itself as its single textbook point. This preserves the visible
    # outline instead of silently dropping a chapter at the root.
    for chapter in chapters:
        if chapter["points"]:
            continue
        chapter["points"].append(
            {
                "id": f"point-{chapter['number']}",
                "number": chapter["number"],
                "title": chapter["title"],
                "page": chapter["page"],
                "order": 0,
                "origin": "textbook",
            }
        )
    return chapters


def _title_from_filename(filename: str) -> str:
    name = Path(filename).name.strip()
    if name.lower().endswith(".pdf"):
        name = name[:-4].rstrip()
    return name or "未命名教材"


def parse_pdf_outline(
    path: Path,
    *,
    document_id: str,
    filename: str,
    sha256: str,
    scan_pages: int,
    executable: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    """Extract a deterministic two-level chapter/knowledge-point outline."""

    page_count = _pdf_page_count(path)
    pages_to_scan = min(max(1, int(scan_pages)), page_count)
    text = _extract_toc_text(
        path,
        executable=executable,
        scan_pages=pages_to_scan,
        timeout_seconds=timeout_seconds,
    )
    chapters = parse_toc_text(text)
    return {
        "schema_version": OUTLINE_SCHEMA,
        "document_id": document_id,
        "title": _title_from_filename(filename),
        "source": {
            "filename": filename,
            "sha256": sha256,
            "page_count": page_count,
            "parser": LOCAL_PARSER_NAME,
            "toc_pages": pages_to_scan,
        },
        "chapters": chapters,
    }
