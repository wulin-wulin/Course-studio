"""Deterministic PDF/DOCX parser for curriculum guidance documents.

The parser intentionally extracts *guidance for adjusting a knowledge-point
list*.  It does not treat administrative syllabus prose as course content and
it never executes macros, external relationships, or instructions embedded in
the uploaded document.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
from typing import Any
import zipfile
from xml.etree import ElementTree as ET

from pypdf import PdfReader


REQUIREMENTS_SCHEMA = "curriculum-requirements/1.0"
PARSER_NAME = "curriculum-guidance/1.0"

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_W = f"{{{_W_NS}}}"
_MAX_DOCX_ENTRIES = 2_000
_MAX_DOCX_EXPANDED_BYTES = 64 * 1024 * 1024
_MAX_DOCX_MEMBER_BYTES = 24 * 1024 * 1024
_MAX_COMPRESSION_RATIO = 250
_SPACE_RE = re.compile(r"\s+")
_HOURS_RE = re.compile(r"(?P<hours>\d+(?:\.\d+)?)\s*学时")
_LEVEL_RE = re.compile(
    r"^(?P<level>了解|理解|掌握|应用|熟悉|认识|能够|具备|学会)\s*[：:]?\s*(?P<text>.*)$"
)
_UNIT_RE = re.compile(
    r"^(?:第\s*[一二三四五六七八九十百\d]+\s*章|"
    r"模块\s*[一二三四五六七八九十百\d]+|"
    r"(?:第)?\s*\d+\s*[.、]\s*(?!\d))"
)
_NUMBERED_TOPIC_RE = re.compile(r"^(?:\d+(?:\.\d+)+|[（(]?\d+[）)])\s*[.、]?\s*(?P<text>.+)$")
_BULLET_RE = re.compile(r"^[\s\u2022\u25cf\u25a0\uf06e\uf0b7·•●▪■\-–—]+")
_SECTION_HEADING_RE = re.compile(
    r"^(?:第[一二三四五六七八九十百\d]+部分|[一二三四五六七八九十百]+、)"
)
_ADMIN_RE = re.compile(
    r"(?:教材(?:与|及)?参考书|参考书目|教学媒体|媒体资源|网络课程(?:用于|平台)|"
    r"教学方式|教学方法|考核方式|成绩(?:构成|比例|评定)|学分|"
    r"面授|自学|辅导|作业提交|答辩安排|师资|适用专业|开课学期)"
)


class CurriculumParseError(RuntimeError):
    """The uploaded curriculum cannot be parsed into safe guidance."""


class CurriculumParserUnavailableError(CurriculumParseError):
    """A required local parser is unavailable."""


@dataclass(frozen=True, slots=True)
class SourceBlock:
    text: str
    source: dict[str, Any]
    kind: str = "paragraph"
    style: str = ""


def _clean(value: str) -> str:
    return _SPACE_RE.sub(" ", str(value or "")).strip()


def _pdf_page_count(path: Path) -> int:
    try:
        reader = PdfReader(str(path), strict=False)
        if reader.is_encrypted:
            try:
                unlocked = reader.decrypt("")
            except Exception as exc:  # pragma: no cover - pypdf variations
                raise CurriculumParseError("PDF 已加密，无法读取培养方案") from exc
            if not unlocked:
                raise CurriculumParseError("PDF 已加密，无法读取培养方案")
        count = len(reader.pages)
    except CurriculumParseError:
        raise
    except Exception as exc:
        raise CurriculumParseError("无法读取 PDF，文件可能已损坏") from exc
    if count <= 0:
        raise CurriculumParseError("PDF 不包含可读取页面")
    return count


def _extract_pdf_blocks(
    path: Path,
    *,
    executable: str,
    timeout_seconds: float,
) -> tuple[list[SourceBlock], str, int]:
    page_count = _pdf_page_count(path)
    command = shutil.which(executable)
    if command is None:
        raise CurriculumParserUnavailableError(
            "培养方案 PDF 解析器不可用：请安装 Poppler pdftotext"
        )
    args = [command, "-layout", "-enc", "UTF-8", str(path), "-"]
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise CurriculumParseError("培养方案 PDF 全文提取超时") from exc
    except OSError as exc:
        raise CurriculumParserUnavailableError("无法启动培养方案 PDF 解析器") from exc
    if result.returncode != 0:
        raise CurriculumParseError("PDF 解析器未能读取培养方案全文")
    try:
        text = result.stdout.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CurriculumParseError("培养方案 PDF 文本不是有效的 UTF-8") from exc
    if not text.strip():
        raise CurriculumParseError("PDF 没有可提取的文字；请先进行 OCR 或上传 DOCX")

    pages = text.split("\f")
    blocks: list[SourceBlock] = []
    markdown_parts: list[str] = []
    for page_number, page_text in enumerate(pages, start=1):
        if page_number > page_count and not page_text.strip():
            continue
        markdown_parts.append(f"<!-- curriculum-source: page={page_number} -->")
        markdown_parts.append(page_text.strip())
        for line_number, raw_line in enumerate(page_text.splitlines(), start=1):
            line = _clean(raw_line)
            if not line:
                continue
            blocks.append(
                SourceBlock(
                    text=line,
                    source={"type": "pdf", "page": page_number, "line": line_number},
                )
            )
    return blocks, "\n\n".join(part for part in markdown_parts if part).strip() + "\n", page_count


def _safe_docx_members(path: Path) -> dict[str, zipfile.ZipInfo]:
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise CurriculumParseError("DOCX 文件损坏或不是有效的 Word 文档") from exc
    try:
        infos = archive.infolist()
        if not infos or len(infos) > _MAX_DOCX_ENTRIES:
            raise CurriculumParseError("DOCX 压缩包条目数量异常")
        total = 0
        members: dict[str, zipfile.ZipInfo] = {}
        for info in infos:
            name = info.filename.replace("\\", "/")
            pure = PurePosixPath(name)
            if pure.is_absolute() or ".." in pure.parts or not name:
                raise CurriculumParseError("DOCX 包含不安全的内部路径")
            lowered = name.lower()
            if lowered.endswith("vbaproject.bin") or lowered.endswith(".exe"):
                raise CurriculumParseError("DOCX 包含不允许的宏或可执行内容")
            if info.flag_bits & 0x1:
                raise CurriculumParseError("DOCX 包含加密条目，无法安全解析")
            if info.file_size > _MAX_DOCX_MEMBER_BYTES:
                raise CurriculumParseError("DOCX 单个内部文件展开后过大")
            total += info.file_size
            if total > _MAX_DOCX_EXPANDED_BYTES:
                raise CurriculumParseError("DOCX 展开后体积过大")
            if info.compress_size > 0 and info.file_size / info.compress_size > _MAX_COMPRESSION_RATIO:
                raise CurriculumParseError("DOCX 压缩比例异常")
            members[name] = info
        for required in ("[Content_Types].xml", "word/document.xml"):
            if required not in members:
                raise CurriculumParseError("DOCX 缺少必要的 Word 文档结构")
        # Return metadata only. The caller reopens the archive so no handle is
        # kept alive beyond validation.
        return members
    finally:
        archive.close()


def validate_docx_archive(path: Path) -> None:
    members = _safe_docx_members(path)
    try:
        with zipfile.ZipFile(path) as archive:
            for name in members:
                if not name.lower().endswith(".rels"):
                    continue
                try:
                    root = ET.fromstring(archive.read(name))
                except (KeyError, ET.ParseError, OSError) as exc:
                    raise CurriculumParseError("DOCX 关系文件损坏") from exc
                for relationship in root.findall(f"{{{_REL_NS}}}Relationship"):
                    if str(relationship.attrib.get("TargetMode", "")).lower() == "external":
                        raise CurriculumParseError("DOCX 包含外部链接关系，已拒绝解析")
    except CurriculumParseError:
        raise
    except (OSError, zipfile.BadZipFile) as exc:
        raise CurriculumParseError("DOCX 文件损坏") from exc


def _paragraph_text(element: ET.Element) -> str:
    parts: list[str] = []
    for node in element.iter():
        if node.tag == f"{_W}t" and node.text:
            parts.append(node.text)
        elif node.tag == f"{_W}tab":
            parts.append("\t")
        elif node.tag in {f"{_W}br", f"{_W}cr"}:
            parts.append("\n")
    return _clean("".join(parts))


def _paragraph_style(element: ET.Element) -> str:
    props = element.find(f"{_W}pPr")
    style = props.find(f"{_W}pStyle") if props is not None else None
    if style is None:
        return ""
    return str(style.attrib.get(f"{_W}val") or "")


def _extract_docx_blocks(path: Path) -> tuple[list[SourceBlock], str, None]:
    validate_docx_archive(path)
    try:
        with zipfile.ZipFile(path) as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError) as exc:
        raise CurriculumParseError("DOCX 正文结构损坏") from exc
    body = root.find(f"{_W}body")
    if body is None:
        raise CurriculumParseError("DOCX 不包含可读取正文")

    blocks: list[SourceBlock] = []
    markdown: list[str] = []
    block_number = 0
    for child in list(body):
        if child.tag == f"{_W}p":
            text = _paragraph_text(child)
            if not text:
                continue
            block_number += 1
            style = _paragraph_style(child)
            blocks.append(
                SourceBlock(
                    text=text,
                    source={"type": "docx", "block": block_number},
                    style=style,
                )
            )
            if style.lower().startswith("heading") or "标题" in style:
                markdown.append(f"## {text}")
            else:
                markdown.append(text)
        elif child.tag == f"{_W}tbl":
            for row_number, row in enumerate(child.findall(f"{_W}tr"), start=1):
                cells: list[str] = []
                for cell in row.findall(f"{_W}tc"):
                    cell_parts = [
                        _paragraph_text(paragraph)
                        for paragraph in cell.findall(f".//{_W}p")
                    ]
                    cells.append(_clean(" / ".join(part for part in cell_parts if part)))
                if not any(cells):
                    continue
                block_number += 1
                row_text = " | ".join(cells)
                blocks.append(
                    SourceBlock(
                        text=row_text,
                        source={"type": "docx", "block": block_number, "table_row": row_number},
                        kind="table-row",
                    )
                )
                markdown.append(f"| {' | '.join(cells)} |")
    if not blocks:
        raise CurriculumParseError("DOCX 没有可读取的文字内容")
    rendered = "\n\n".join(markdown).strip() + "\n"
    return blocks, rendered, None


def _strip_marker(value: str) -> str:
    text = _BULLET_RE.sub("", _clean(value))
    match = _NUMBERED_TOPIC_RE.match(text)
    return _clean(match.group("text")) if match else text


def _heading_mode(text: str) -> str | None:
    compact = text.replace(" ", "")
    if re.search(r"知识要求|能力要求|素养要求", compact):
        return "requirements"
    if re.search(r"(?:课程|总体)?(?:教学)?目标", compact):
        return "goals"
    if "教学内容" in compact or compact in {"内容", "主要内容"}:
        return "content"
    if "教学要求" in compact or compact in {"要求", "学习要求"}:
        return "requirements"
    if "教学重点" in compact or compact == "重点":
        return "key"
    if "教学难点" in compact or compact == "难点":
        return "difficult"
    if len(compact) <= 32 and re.match(
        r"^(?:[【\[]?(?:实验|实训|实践)(?:内容|目标|要求|项目|安排)|"
        r"(?:实验|实训)\d+|第[一二三四五六七八九十\d]+(?:个)?(?:实验|实训))",
        compact,
    ):
        return "experiments"
    if _ADMIN_RE.search(compact):
        return "admin"
    if _SECTION_HEADING_RE.match(text):
        return "section"
    return None


def _is_unit_heading(block: SourceBlock) -> bool:
    text = block.text
    if len(text) > 120:
        return False
    compact = text.replace(" ", "")
    # Collection headings introduce the detailed units that follow; they are
    # not themselves knowledge units.  The generic ``章`` check below would
    # otherwise turn headings such as “五、各章节内容” into a phantom unit.
    if re.search(r"(?:各章节|章节)(?:内容|安排|简介|概览|总览)$", compact):
        return False
    if len(_HOURS_RE.findall(text)) > 1:
        # A row with separate lecture/experiment hour columns belongs to an
        # allocation table, not the detailed unit definition.
        return False
    if re.match(
        r"^(?:第\s*[一二三四五六七八九十百\d]+\s*章|"
        r"模块\s*[一二三四五六七八九十百\d]+)",
        text,
    ):
        return True
    if block.style.lower().startswith("heading") or "标题" in block.style:
        return bool(re.search(r"章|模块|单元|篇", text))
    # Plain numbered bullets occur throughout goals and requirements. Treat a
    # one-level number as a unit only when the syllabus also supplies hours.
    return bool(_UNIT_RE.match(text) and _HOURS_RE.search(text))


def _heading_level(style: str) -> int | None:
    match = re.search(r"(?:heading|标题)\s*([1-9]\d*)", style, re.IGNORECASE)
    return int(match.group(1)) if match else None


def _requirement_kind(text: str) -> str:
    if re.search(r"伦理|安全|责任|合规|治理|价值观", text):
        return "ethics"
    if re.search(r"实验|实训|实践|操作|编程|实现|构建|部署|调试", text):
        return "experiment"
    if re.search(r"能够|具备|应用|分析|设计|解决|评价|开发|完成", text):
        return "skill"
    return "knowledge"


def _level_fields(text: str) -> tuple[str, str, str]:
    candidate = _strip_marker(text)
    match = _LEVEL_RE.match(candidate)
    if not match:
        return "unspecified", "", candidate
    label = match.group("level")
    normalized = {
        "了解": "awareness",
        "认识": "awareness",
        "理解": "understanding",
        "熟悉": "understanding",
        "掌握": "mastery",
        "应用": "application",
        "能够": "application",
        "具备": "application",
        "学会": "application",
    }[label]
    body = _clean(match.group("text")) or candidate
    return normalized, label, body


def _priority_for_level(level: str) -> str:
    return {
        "application": "core",
        "mastery": "core",
        "understanding": "supporting",
        "awareness": "awareness",
    }.get(level, "unspecified")


def _is_requirement_candidate(text: str) -> bool:
    """Keep statements that can actually change a knowledge-point plan."""

    return bool(
        _LEVEL_RE.match(_strip_marker(text))
        or re.search(
            r"掌握|理解|了解|熟悉|认识|能够|具备|学会|应用|分析|设计|"
            r"实现|构建|解释|描述|比较|评价|解决|完成|识别",
            text,
        )
    )


def _is_level_legend(text: str) -> bool:
    """Return true for generic proficiency-scale explanations."""

    normalized = re.sub(
        r"^(?:[、，,]\s*|[（(]?\d+[）).、]\s*)+",
        "",
        _clean(text),
    )
    if re.fullmatch(
        r"(?:了解|理解|掌握|应用)(?:(?:、|，|,|和|及)(?:了解|理解|掌握|应用))*[。.]?",
        normalized,
    ):
        return True
    return bool(
        re.search(r"正确判别有关概念和方法", normalized)
        or re.search(r"正确表达有关概念和方法(?:的含义)?", normalized)
        or re.search(r"在理解的?基础上(?:加以)?灵活应用", normalized)
    )


def _title_from_blocks(blocks: list[SourceBlock], filename: str) -> str:
    for block in blocks[:30]:
        text = block.text.strip()
        if 2 <= len(text) <= 100 and re.search(r"课程|教学大纲|培养方案|课程体系", text):
            quoted = re.search(r"《([^》]{2,100})》", text)
            return quoted.group(1).strip() if quoted else text.strip()
    return Path(filename).stem


def build_requirements(
    blocks: list[SourceBlock],
    *,
    document_id: str,
    filename: str,
    content_type: str,
    sha256: str,
    page_count: int | None,
) -> dict[str, Any]:
    title = _title_from_blocks(blocks, filename)
    goals: list[dict[str, Any]] = []
    prerequisites: list[dict[str, Any]] = []
    units: list[dict[str, Any]] = []
    requirements: list[dict[str, Any]] = []
    experiments: list[dict[str, Any]] = []
    warnings: list[str] = []
    current_unit: dict[str, Any] | None = None
    mode: str | None = None
    fallback_guidance: list[tuple[dict[str, Any], str, SourceBlock]] = []

    def add_topic(unit: dict[str, Any], text: str, block: SourceBlock) -> None:
        body = _strip_marker(text)
        if not body or len(body) < 2 or _ADMIN_RE.search(body):
            return
        if any(item.get("text") == body for item in unit["topics"]):
            return
        topic_id = f"topic-{sum(len(item['topics']) for item in units) + 1:03d}"
        unit["topics"].append(
            {"id": topic_id, "text": body, "source": dict(block.source)}
        )

    def add_focus(kind: str, text: str, block: SourceBlock) -> None:
        if current_unit is None:
            return
        body = _strip_marker(text)
        if not body or len(body) < 2 or _ADMIN_RE.search(body):
            return
        field = "key_points" if kind == "key" else "difficult_points"
        if body not in current_unit[field]:
            current_unit[field].append(body)
            fallback_guidance.append((current_unit, body, block))

    def add_requirement(text: str, block: SourceBlock) -> str | None:
        if _is_level_legend(text):
            return None
        level, level_label, body = _level_fields(text)
        if not body or len(body) < 2 or _ADMIN_RE.search(body) or _is_level_legend(body):
            return None
        req_id = f"requirement-{len(requirements) + 1:03d}"
        requirement = {
            "id": req_id,
            "text": body,
            "level": level,
            "level_label": level_label,
            "kind": _requirement_kind(body),
            "priority": _priority_for_level(level),
            "source": dict(block.source),
        }
        if current_unit is not None:
            requirement["unit_id"] = current_unit["id"]
            current_unit["requirement_ids"].append(req_id)
        requirements.append(requirement)
        return req_id

    for block in blocks:
        text = block.text
        compact = text.replace(" ", "")
        if re.search(r"先修课程|前置课程", compact):
            value = re.split(r"[：:]", text, maxsplit=1)
            body = _clean(value[1] if len(value) > 1 else text)
            if body and body not in {"无", "无要求"}:
                prerequisites.append({"text": body, "source": dict(block.source)})
            continue

        strong_unit_marker = bool(
            re.search(r"章|模块|单元|篇|学时", text)
            or block.style.lower().startswith("heading")
        )
        if _is_unit_heading(block) and (
            mode not in {"requirements", "goals", "key", "difficult", "experiments"}
            or strong_unit_marker
        ):
            unit_id = f"unit-{len(units) + 1:03d}"
            hours_match = _HOURS_RE.search(text)
            current_unit = {
                "id": unit_id,
                "title": text,
                "order": len(units),
                "topics": [],
                "requirement_ids": [],
                "key_points": [],
                "difficult_points": [],
                "source": dict(block.source),
            }
            if hours_match:
                current_unit["hours"] = float(hours_match.group("hours"))
            units.append(current_unit)
            mode = None
            continue

        next_mode = _heading_mode(text)
        if next_mode is not None:
            mode = next_mode
            # Inline headings such as "教学重点：..." carry useful content.
            pieces = re.split(r"[：:]", text, maxsplit=1)
            if len(pieces) > 1 and _clean(pieces[1]):
                inline = _clean(pieces[1])
                if mode == "key" and current_unit is not None:
                    add_focus("key", inline, block)
                elif mode == "difficult" and current_unit is not None:
                    add_focus("difficult", inline, block)
                elif mode == "requirements" and _is_requirement_candidate(inline):
                    add_requirement(inline, block)
                elif mode == "goals" and not _ADMIN_RE.search(inline):
                    goals.append({"text": inline, "source": dict(block.source)})
                elif mode == "content" and current_unit is not None:
                    add_topic(current_unit, inline, block)
                elif mode == "experiments":
                    experiment = {
                        "id": f"experiment-{len(experiments) + 1:03d}",
                        "text": inline,
                        "source": dict(block.source),
                    }
                    if current_unit is not None:
                        experiment["unit_id"] = current_unit["id"]
                    experiments.append(experiment)
            continue

        stripped = _strip_marker(text)
        if not stripped or len(stripped) < 2:
            continue
        # Detailed DOCX syllabi commonly use Heading4 for a lecture title
        # after “教学重点/难点”.  It starts content again; without this reset,
        # every subsequent bullet would be misclassified as a difficult point.
        heading_level = _heading_level(block.style)
        if current_unit is not None and heading_level is not None and heading_level <= 2:
            mode = "section"
            continue
        if current_unit is not None and heading_level is not None and heading_level >= 3:
            mode = "content"
            add_topic(current_unit, stripped, block)
            continue
        level_match = _LEVEL_RE.match(stripped)
        if level_match and mode not in {"content", "key", "difficult"}:
            add_requirement(stripped, block)
            continue

        if mode == "goals":
            if not _ADMIN_RE.search(stripped):
                goals.append({"text": stripped, "source": dict(block.source)})
        elif mode == "content" and current_unit is not None:
            add_topic(current_unit, stripped, block)
        elif mode == "requirements" and _is_requirement_candidate(stripped):
            add_requirement(stripped, block)
        elif mode == "key" and current_unit is not None and not _ADMIN_RE.search(stripped):
            add_focus("key", stripped, block)
        elif mode == "difficult" and current_unit is not None and not _ADMIN_RE.search(stripped):
            add_focus("difficult", stripped, block)
        elif mode == "experiments":
            experiment_id = f"experiment-{len(experiments) + 1:03d}"
            experiment = {
                "id": experiment_id,
                "text": stripped,
                "source": dict(block.source),
            }
            if current_unit is not None:
                experiment["unit_id"] = current_unit["id"]
            experiments.append(experiment)
        elif (
            mode is None
            and current_unit is not None
            and "list" in block.style.lower()
        ):
            # Some concise syllabi place their topic bullets immediately
            # below a module heading without an explicit “教学内容” label.
            add_topic(current_unit, stripped, block)

    # Hour-allocation tables often repeat every chapter before the detailed
    # teaching section. They carry no topics or requirements and must not
    # become duplicate knowledge clusters.
    substantive_unit_ids = {
        unit["id"]
        for unit in units
        if unit["topics"]
        or unit["requirement_ids"]
        or unit["key_points"]
        or unit["difficult_points"]
    }
    substantive_unit_ids.update(
        str(item.get("unit_id"))
        for item in experiments
        if item.get("unit_id")
    )
    if substantive_unit_ids:
        units = [unit for unit in units if unit["id"] in substantive_unit_ids]
        for order, unit in enumerate(units):
            unit["order"] = order

    # Many concise syllabi list topics but omit an explicit "教学要求" label.
    # Preserve those topics as coverage input without pretending they are
    # levelled requirements.
    if not requirements:
        seen_fallback: set[tuple[str, str]] = set()
        for unit in units:
            for topic in unit["topics"]:
                key = (unit["id"], topic["text"])
                if key in seen_fallback:
                    continue
                seen_fallback.add(key)
                current_unit = unit
                synthetic_block = SourceBlock(topic["text"], topic["source"])
                add_requirement(topic["text"], synthetic_block)
        for unit, text, source_block in fallback_guidance:
            if unit not in units or (unit["id"], text) in seen_fallback:
                continue
            seen_fallback.add((unit["id"], text))
            current_unit = unit
            add_requirement(text, source_block)
        if not requirements:
            current_unit = None
            for goal in goals:
                add_requirement(
                    str(goal.get("text") or ""),
                    SourceBlock(
                        str(goal.get("text") or ""),
                        dict(goal.get("source") or {}),
                    ),
                )
        if requirements:
            warnings.append(
                "未识别到明确教学要求；已将教学内容、重点难点或课程目标作为未分级覆盖要求"
            )
    if not units:
        warnings.append("未识别到章节或模块；融合阶段应结合全文人工确认")
    if not requirements and not goals:
        raise CurriculumParseError("未能从文档中识别课程目标、教学内容或教学要求")

    return {
        "schema_version": REQUIREMENTS_SCHEMA,
        "document_id": document_id,
        "document_type": "curriculum-or-syllabus",
        "title": title,
        "source": {
            "filename": filename,
            "content_type": content_type,
            "sha256": sha256,
            "parser": PARSER_NAME,
            **({"page_count": page_count} if page_count is not None else {}),
        },
        "course_goals": goals,
        "prerequisites": prerequisites,
        "content_units": units,
        "requirements": requirements,
        "experiments": experiments,
        "warnings": warnings,
        "summary": {
            "goal_count": len(goals),
            "unit_count": len(units),
            "topic_count": sum(len(unit["topics"]) for unit in units),
            "requirement_count": len(requirements),
            "experiment_count": len(experiments),
        },
    }


def parse_curriculum_document(
    path: Path,
    *,
    document_id: str,
    filename: str,
    content_type: str,
    sha256: str,
    pdftotext_executable: str,
    timeout_seconds: float,
) -> tuple[dict[str, Any], str]:
    if content_type == "application/pdf":
        blocks, markdown, page_count = _extract_pdf_blocks(
            path,
            executable=pdftotext_executable,
            timeout_seconds=timeout_seconds,
        )
    elif content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        blocks, markdown, page_count = _extract_docx_blocks(path)
    else:  # Defensive: upload validation should reject this first.
        raise CurriculumParseError("不支持的培养方案文件类型")
    requirements = build_requirements(
        blocks,
        document_id=document_id,
        filename=filename,
        content_type=content_type,
        sha256=sha256,
        page_count=page_count,
    )
    return requirements, markdown


__all__ = [
    "CurriculumParseError",
    "CurriculumParserUnavailableError",
    "PARSER_NAME",
    "REQUIREMENTS_SCHEMA",
    "SourceBlock",
    "build_requirements",
    "parse_curriculum_document",
    "validate_docx_archive",
]
