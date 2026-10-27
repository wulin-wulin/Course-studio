"""Safe JSON storage for CKDS-compatible course packages.

Course content is deliberately stored as ordinary JSON, with optional compiled
animation assets. This service is the single writer for the canonical package
directory and provides three safeguards:

* paths are constrained to the course JSON contract plus three fixed,
  integrity-checked files under ``<course-id>/animations``;
* all candidates are parsed and validated before they reach the canonical tree;
* writes use temporary files plus ``os.replace`` while holding a process lock.

OpenCode itself writes a per-conversation staging copy.  ``commit_workspace``
validates that copy and synchronises it only if the canonical tree has not
changed since the workspace was created.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import threading
import uuid
from typing import Any, Iterable

from ...config import settings


_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_ANIMATION_TYPE_RE = re.compile(r"^[a-z][A-Za-z0-9]*$")
_COMPONENT_RE = re.compile(r"^[A-Z][A-Za-z0-9]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_JSON_BYTES = 8 * 1024 * 1024
_ANIMATION_RUNTIME_SCHEMA = "course-animation-runtime/1.0"
_ANIMATION_ASSET_FILES = frozenset({"manifest.json", "runtime.js", "runtime.css"})
_TEXTBOOK_CONTENT_SCHEMA = "textbook-content/2.0"
_TEXTBOOK_ADAPTATION_LEVELS = frozenset(
    {"faithful", "balanced", "teaching-first"}
)
_TEXTBOOK_LEARNING_DEPTHS = frozenset({"core", "support", "advanced"})
_TEXTBOOK_BLOCK_KINDS = frozenset(
    {
        "definition",
        "explanation",
        "mechanism",
        "procedure",
        "formula",
        "example",
        "worked-example",
        "comparison",
        "application",
        "code",
        "table",
        "figure",
        "warning",
        "misconception",
        "exercise",
        "summary",
        "note",
        "other",
    }
)
_COURSE_CATALOG_SCHEMA = "course-catalog/1.0"
_COURSE_CATALOG_FILE = "course-catalog.json"
_DEFAULT_CATALOG_GROUP_ID = "my-courses"
_MAX_CATALOG_GROUPS = 200
_MAX_CATALOG_GROUP_NAME = 80
_LEGACY_POINT_CONTENT_FIELDS = frozenset(
    {
        "coreIdea",
        "principles",
        "formula",
        "comparisons",
        "applications",
        "aliases",
        "intuition",
        "misconceptions",
        "history",
        "yearIntroduced",
        "prosCons",
        "qa",
        "visualType",
        "visualSuggestion",
    }
)
_POINT_META_FIELDS = (
    "id",
    "title",
    "clusterId",
    "shortSummary",
    "difficulty",
    "importance",
    "keyTerms",
    "pos",
    "scale",
)
_DEFAULT_COLORS = (
    ("#2f9e7e", "#dff7ed", "#175c49"),
    ("#d97706", "#fff0cf", "#7a3d02"),
    ("#7c5cff", "#ece8ff", "#4430a6"),
    ("#2563eb", "#dbeafe", "#1e3a8a"),
    ("#be185d", "#fce7f3", "#831843"),
)


def _is_textbook_content_point(point: Any) -> bool:
    return (
        isinstance(point, dict)
        and isinstance(point.get("content"), dict)
        and point["content"].get("schema_version") == _TEXTBOOK_CONTENT_SCHEMA
    )


def _validate_textbook_source_spans(
    value: Any,
    label: str,
    *,
    require_non_empty: bool,
) -> list[str]:
    """Validate the complete sourceSpan contract used by textbook-content/2.0."""

    errors: list[str] = []
    if not isinstance(value, list):
        return [f"{label} 必须是数组"]
    if require_non_empty and not value:
        errors.append(f"{label} 至少需要一个来源定位")

    required_keys = {
        "materialId",
        "blockIds",
        "headingPath",
        "lineStart",
        "lineEnd",
        "assetRefs",
        "excerptSha256",
    }
    allowed_keys = required_keys | {"page"}
    for index, span in enumerate(value):
        span_label = f"{label}[{index}]"
        if not isinstance(span, dict):
            errors.append(f"{span_label} 必须是对象")
            continue

        missing = sorted(required_keys - set(span))
        extra = sorted(set(span) - allowed_keys)
        if missing:
            errors.append(f"{span_label} 缺少字段：{', '.join(missing)}")
        if extra:
            errors.append(f"{span_label} 包含未知字段：{', '.join(extra)}")

        material_id = span.get("materialId")
        if not isinstance(material_id, str) or not material_id.strip():
            errors.append(f"{span_label}.materialId 必须是非空字符串")

        for field_name, minimum in (("blockIds", 1), ("headingPath", 1), ("assetRefs", 0)):
            items = span.get(field_name)
            if (
                not isinstance(items, list)
                or len(items) < minimum
                or any(not isinstance(item, str) or not item.strip() for item in items)
            ):
                requirement = (
                    f"至少包含 {minimum} 项非空字符串的数组"
                    if minimum
                    else "非空字符串数组"
                )
                errors.append(f"{span_label}.{field_name} 必须是{requirement}")
                continue
            if field_name in {"blockIds", "assetRefs"} and len(set(items)) != len(items):
                errors.append(f"{span_label}.{field_name} 不允许重复项")

        line_start = span.get("lineStart")
        line_end = span.get("lineEnd")
        if not isinstance(line_start, int) or isinstance(line_start, bool) or line_start < 1:
            errors.append(f"{span_label}.lineStart 必须是正整数")
        if (
            not isinstance(line_end, int)
            or isinstance(line_end, bool)
            or line_end < 1
            or not isinstance(line_start, int)
            or isinstance(line_start, bool)
            or line_end < line_start
        ):
            errors.append(f"{span_label}.lineEnd 必须是不小于 lineStart 的正整数")

        if "page" in span:
            page = span.get("page")
            if not isinstance(page, int) or isinstance(page, bool) or page < 1:
                errors.append(f"{span_label}.page 必须是正整数")

        excerpt_sha256 = span.get("excerptSha256")
        if not isinstance(excerpt_sha256, str) or not _SHA256_RE.fullmatch(excerpt_sha256):
            errors.append(f"{span_label}.excerptSha256 必须是小写 SHA-256")

    return errors


def _is_markdown_escaped(value: str, index: int) -> bool:
    backslashes = 0
    cursor = index - 1
    while cursor >= 0 and value[cursor] == "\\":
        backslashes += 1
        cursor -= 1
    return backslashes % 2 == 1


def _markdown_lines(value: str) -> Iterable[tuple[int, int, str]]:
    """Yield CRLF, LF, and CR lines with their original offsets."""

    start = 0
    while start < len(value):
        end = start
        while end < len(value) and value[end] not in {"\r", "\n"}:
            end += 1
        if end < len(value):
            end += 1
            if value[end - 1] == "\r" and end < len(value) and value[end] == "\n":
                end += 1
        yield start, end, value[start:end]
        start = end


def _markdown_fence_run(line: str) -> tuple[str, str] | None:
    body = line
    if body.endswith("\r\n"):
        body = body[:-2]
    elif body.endswith(("\r", "\n")):
        body = body[:-1]
    match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", body)
    if not match:
        return None
    return match.group(1), match.group(2)


def _mask_markdown_code(value: str) -> str:
    """Mask CommonMark-style fenced and inline code at stable offsets."""

    masked = list(value)
    fence: str | None = None
    for start, end, line in _markdown_lines(value):
        run = _markdown_fence_run(line)
        marker, suffix = run if run else (None, None)
        closes_fence = bool(
            fence
            and marker
            and marker[0] == fence[0]
            and len(marker) >= len(fence)
            and suffix is not None
            and not suffix.strip(" \t")
        )
        opens_fence = bool(
            fence is None
            and marker
            and suffix is not None
            and (marker[0] == "~" or "`" not in suffix)
        )
        if fence is not None or opens_fence:
            for index in range(start, end):
                if masked[index] not in {"\n", "\r"}:
                    masked[index] = " "
        if opens_fence:
            fence = marker
        elif closes_fence:
            fence = None

    without_fences = "".join(masked)
    index = 0
    while index < len(without_fences):
        if without_fences[index] != "`" or _is_markdown_escaped(
            without_fences, index
        ):
            index += 1
            continue
        run_end = index + 1
        while run_end < len(without_fences) and without_fences[run_end] == "`":
            run_end += 1
        marker_length = run_end - index
        search = run_end
        close = -1
        while search < len(without_fences):
            candidate = without_fences.find("`", search)
            if candidate < 0:
                break
            close_end = candidate + 1
            while (
                close_end < len(without_fences)
                and without_fences[close_end] == "`"
            ):
                close_end += 1
            if close_end - candidate == marker_length:
                close = candidate
                break
            search = close_end
        if close < 0:
            index = run_end
            continue
        close_end = close + marker_length
        for cursor in range(index, close_end):
            if masked[cursor] not in {"\n", "\r"}:
                masked[cursor] = " "
        index = close_end
    return "".join(masked)


def _find_unescaped(value: str, needle: str, start: int) -> int:
    cursor = start
    while cursor < len(value):
        found = value.find(needle, cursor)
        if found < 0 or not _is_markdown_escaped(value, found):
            return found
        cursor = found + len(needle)
    return -1


def _mask_legacy_math(value: str, opening: str, closing: str) -> str:
    masked = list(value)
    cursor = 0
    while cursor < len(value):
        start = _find_unescaped(value, opening, cursor)
        if start < 0:
            break
        end = _find_unescaped(value, closing, start + len(opening))
        if end < 0:
            cursor = start + len(opening)
            continue
        for index in range(start, end + len(closing)):
            if masked[index] not in {"\n", "\r"}:
                masked[index] = " "
        cursor = end + len(closing)
    return "".join(masked)


def _mask_dollar_math(value: str) -> str:
    """Mask the equal-length dollar runs used by remark-math."""

    masked = list(value)
    cursor = 0
    while cursor < len(value):
        start = value.find("$", cursor)
        if start < 0:
            break
        run_end = start + 1
        while run_end < len(value) and value[run_end] == "$":
            run_end += 1
        marker_length = run_end - start
        if _is_markdown_escaped(value, start):
            cursor = run_end
            continue

        search = run_end
        close = -1
        while search < len(value):
            candidate = value.find("$", search)
            if candidate < 0:
                break
            close_end = candidate + 1
            while close_end < len(value) and value[close_end] == "$":
                close_end += 1
            if close_end - candidate == marker_length:
                close = candidate
                break
            search = close_end
        if close < 0:
            cursor = run_end
            continue
        close_end = close + marker_length
        for index in range(start, close_end):
            if masked[index] not in {"\n", "\r"}:
                masked[index] = " "
        cursor = close_end
    return "".join(masked)


def _markdown_prose(value: str) -> str:
    prose = _mask_markdown_code(value)
    # Keep legacy \(...\) and \[...\] readable while new generation uses
    # the canonical $...$ and $$...$$ delimiters.
    for opening, closing in ((r"\[", r"\]"), (r"\(", r"\)")):
        prose = _mask_legacy_math(prose, opening, closing)
    return _mask_dollar_math(prose)


def _validate_textbook_markdown(value: str, label: str) -> list[str]:
    errors: list[str] = []
    visible_text = _mask_markdown_code(value)
    if re.search(r"(?:\\r)?\\n(?:\\r)?\\n", visible_text):
        errors.append(f"{label} 不得用可见的字面量 \\n\\n 代替真实段落换行")
    if re.search(r"\\+[A-Za-z]+", _markdown_prose(value)):
        errors.append(f"{label} 的 LaTeX 命令必须放在数学分隔符内")
    return errors


def _validate_textbook_id_list(
    value: Any,
    label: str,
    *,
    require_non_empty: bool = True,
) -> tuple[list[str], list[str]]:
    """Validate a unique kebab-case reference list and return usable IDs."""

    errors: list[str] = []
    if not isinstance(value, list):
        return [f"{label} 必须是数组"], []
    if require_non_empty and not value:
        errors.append(f"{label} 至少需要一项")

    valid: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, str) or not _ID_RE.fullmatch(item):
            errors.append(f"{label}[{index}] 必须为 kebab-case")
            continue
        if item in seen:
            errors.append(f"{label} 不允许重复项：{item}")
            continue
        seen.add(item)
        valid.append(item)
    return errors, valid


def _validate_textbook_learning_design(
    value: Any,
    label: str,
    *,
    blocks: list[Any],
    block_index_by_id: dict[str, int],
) -> tuple[list[str], set[str], set[str]]:
    """Validate the optional outcome-first teaching plan for one point."""

    errors: list[str] = []
    outcome_ids: set[str] = set()
    module_ids: set[str] = set()
    if not isinstance(value, dict):
        return [f"{label} 必须是对象"], outcome_ids, module_ids

    required_keys = {
        "primaryPattern",
        "estimatedMinutes",
        "outcomes",
        "misconceptions",
        "modules",
        "completion",
    }
    allowed_keys = required_keys | {"adaptationLevel", "editorialPolicy"}
    missing = sorted(required_keys - set(value))
    extra = sorted(set(value) - allowed_keys)
    if missing:
        errors.append(f"{label} 缺少字段：{', '.join(missing)}")
    if extra:
        errors.append(f"{label} 包含未知字段：{', '.join(extra)}")

    primary_pattern = value.get("primaryPattern")
    if not isinstance(primary_pattern, str) or not primary_pattern.strip():
        errors.append(f"{label}.primaryPattern 必须是非空字符串")

    adaptation_level = value.get("adaptationLevel", "balanced")
    if adaptation_level not in _TEXTBOOK_ADAPTATION_LEVELS:
        errors.append(
            f"{label}.adaptationLevel 必须是 faithful/balanced/teaching-first"
        )
    if "editorialPolicy" in value and (
        not isinstance(value.get("editorialPolicy"), str)
        or not value["editorialPolicy"].strip()
    ):
        errors.append(f"{label}.editorialPolicy 必须是非空字符串")

    estimated_minutes = value.get("estimatedMinutes")
    if (
        not isinstance(estimated_minutes, int)
        or isinstance(estimated_minutes, bool)
        or estimated_minutes < 1
    ):
        errors.append(f"{label}.estimatedMinutes 必须是正整数")

    outcomes = value.get("outcomes")
    if not isinstance(outcomes, list) or not outcomes:
        errors.append(f"{label}.outcomes 必须是非空数组")
        outcomes = []
    for index, outcome in enumerate(outcomes):
        outcome_label = f"{label}.outcomes[{index}]"
        if not isinstance(outcome, dict):
            errors.append(f"{outcome_label} 必须是对象")
            continue
        missing_outcome = sorted({"id", "text"} - set(outcome))
        extra_outcome = sorted(set(outcome) - {"id", "text"})
        if missing_outcome:
            errors.append(f"{outcome_label} 缺少字段：{', '.join(missing_outcome)}")
        if extra_outcome:
            errors.append(f"{outcome_label} 包含未知字段：{', '.join(extra_outcome)}")
        outcome_id = outcome.get("id")
        if not isinstance(outcome_id, str) or not _ID_RE.fullmatch(outcome_id):
            errors.append(f"{outcome_label}.id 必须为 kebab-case")
        elif outcome_id in outcome_ids:
            errors.append(f"{outcome_label}.id 重复：{outcome_id}")
        else:
            outcome_ids.add(outcome_id)
        if not isinstance(outcome.get("text"), str) or not outcome["text"].strip():
            errors.append(f"{outcome_label}.text 必须是非空字符串")

    misconceptions = value.get("misconceptions")
    if not isinstance(misconceptions, list):
        errors.append(f"{label}.misconceptions 必须是字符串数组")
    else:
        seen_misconceptions: set[str] = set()
        for index, misconception in enumerate(misconceptions):
            if not isinstance(misconception, str) or not misconception.strip():
                errors.append(
                    f"{label}.misconceptions[{index}] 必须是非空字符串"
                )
            elif misconception in seen_misconceptions:
                errors.append(f"{label}.misconceptions 不允许重复项")
            else:
                seen_misconceptions.add(misconception)

    modules = value.get("modules")
    if not isinstance(modules, list) or not modules:
        errors.append(f"{label}.modules 必须是非空数组")
        modules = []
    covered_outcomes: set[str] = set()
    module_orders: set[int] = set()
    for index, module in enumerate(modules):
        module_label = f"{label}.modules[{index}]"
        if not isinstance(module, dict):
            errors.append(f"{module_label} 必须是对象")
            continue
        required_module_keys = {"id", "title", "outcomeRefs", "order"}
        allowed_module_keys = required_module_keys | {"role", "description"}
        missing_module = sorted(required_module_keys - set(module))
        extra_module = sorted(set(module) - allowed_module_keys)
        if missing_module:
            errors.append(f"{module_label} 缺少字段：{', '.join(missing_module)}")
        if extra_module:
            errors.append(f"{module_label} 包含未知字段：{', '.join(extra_module)}")
        module_id = module.get("id")
        if not isinstance(module_id, str) or not _ID_RE.fullmatch(module_id):
            errors.append(f"{module_label}.id 必须为 kebab-case")
        elif module_id in module_ids:
            errors.append(f"{module_label}.id 重复：{module_id}")
        else:
            module_ids.add(module_id)
        if not isinstance(module.get("title"), str) or not module["title"].strip():
            errors.append(f"{module_label}.title 必须是非空字符串")
        for optional_text in ("role", "description"):
            if optional_text in module and (
                not isinstance(module.get(optional_text), str)
                or not module[optional_text].strip()
            ):
                errors.append(f"{module_label}.{optional_text} 必须是非空字符串")
        order = module.get("order")
        if not isinstance(order, int) or isinstance(order, bool) or order < 0:
            errors.append(f"{module_label}.order 必须是非负整数")
        elif order in module_orders:
            errors.append(f"{module_label}.order 重复：{order}")
        else:
            module_orders.add(order)
        reference_errors, references = _validate_textbook_id_list(
            module.get("outcomeRefs"), f"{module_label}.outcomeRefs"
        )
        errors.extend(reference_errors)
        for outcome_id in references:
            if outcome_id not in outcome_ids:
                errors.append(
                    f"{module_label}.outcomeRefs 引用了不存在的学习目标：{outcome_id}"
                )
            else:
                covered_outcomes.add(outcome_id)

    for outcome_id in sorted(outcome_ids - covered_outcomes):
        errors.append(f"{label}.modules 未覆盖学习目标：{outcome_id}")

    completion = value.get("completion")
    completion_outcome_refs: set[str] = set()
    if not isinstance(completion, dict) or not completion:
        errors.append(f"{label}.completion 必须是非空对象")
    else:
        allowed_completion_keys = {
            "outcomeRefs",
            "method",
            "successCriteria",
            "exerciseBlockId",
            "summaryBlockId",
            "nextPointId",
        }
        extra_completion = sorted(set(completion) - allowed_completion_keys)
        if extra_completion:
            errors.append(
                f"{label}.completion 包含未知字段：{', '.join(extra_completion)}"
            )
        if "outcomeRefs" in completion:
            reference_errors, references = _validate_textbook_id_list(
                completion.get("outcomeRefs"),
                f"{label}.completion.outcomeRefs",
            )
            errors.extend(reference_errors)
            for outcome_id in references:
                if outcome_id not in outcome_ids:
                    errors.append(
                        f"{label}.completion.outcomeRefs 引用了不存在的学习目标：{outcome_id}"
                    )
                else:
                    completion_outcome_refs.add(outcome_id)
        for text_field in ("method", "nextPointId"):
            if text_field in completion and (
                not isinstance(completion.get(text_field), str)
                or not completion[text_field].strip()
            ):
                errors.append(f"{label}.completion.{text_field} 必须是非空字符串")
        if "nextPointId" in completion and isinstance(
            completion.get("nextPointId"), str
        ) and not _ID_RE.fullmatch(completion["nextPointId"]):
            errors.append(f"{label}.completion.nextPointId 必须为 kebab-case")
        if "successCriteria" in completion:
            criteria = completion.get("successCriteria")
            if (
                not isinstance(criteria, list)
                or not criteria
                or any(not isinstance(item, str) or not item.strip() for item in criteria)
            ):
                errors.append(
                    f"{label}.completion.successCriteria 必须是非空字符串数组"
                )
        for block_field in ("exerciseBlockId", "summaryBlockId"):
            if block_field not in completion:
                continue
            block_id = completion.get(block_field)
            if not isinstance(block_id, str) or not _ID_RE.fullmatch(block_id):
                errors.append(f"{label}.completion.{block_field} 必须为 kebab-case")
            elif block_id not in block_index_by_id:
                errors.append(
                    f"{label}.completion.{block_field} 引用了不存在的内容块：{block_id}"
                )
    if completion_outcome_refs:
        for outcome_id in sorted(outcome_ids - completion_outcome_refs):
            errors.append(f"{label}.completion 未覆盖学习目标：{outcome_id}")

    blocks_by_module: dict[str, int] = {module_id: 0 for module_id in module_ids}
    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            continue
        block_label = f"{label.rsplit('.', 1)[0]}.blocks[{index}]"
        module_id = block.get("moduleId")
        if not isinstance(module_id, str) or not _ID_RE.fullmatch(module_id):
            errors.append(f"{block_label}.moduleId 必须为 kebab-case")
        elif module_id not in module_ids:
            errors.append(f"{block_label}.moduleId 引用了不存在的教学模块：{module_id}")
        else:
            blocks_by_module[module_id] += 1
        if block.get("depth") not in _TEXTBOOK_LEARNING_DEPTHS:
            errors.append(f"{block_label}.depth 必须是 core/support/advanced")
    for module_id, block_count in blocks_by_module.items():
        if block_count == 0:
            errors.append(f"{label}.modules 中的模块没有内容块：{module_id}")

    return errors, outcome_ids, module_ids


def _validate_textbook_learning_assets(
    value: Any,
    label: str,
    *,
    outcome_ids: set[str],
    module_ids: set[str],
    blocks: list[Any],
    block_index_by_id: dict[str, int],
    grounded_by_id: dict[str, bool],
) -> list[str]:
    """Validate learner-facing assets without weakening source grounding."""

    errors: list[str] = []
    if not isinstance(value, list) or not value:
        return [f"{label} 必须是非空数组"]
    seen_ids: set[str] = set()
    block_by_id = {
        block.get("id"): block
        for block in blocks
        if isinstance(block, dict) and isinstance(block.get("id"), str)
    }
    for index, asset in enumerate(value):
        asset_label = f"{label}[{index}]"
        if not isinstance(asset, dict):
            errors.append(f"{asset_label} 必须是对象")
            continue
        required_keys = {
            "id",
            "type",
            "anchorBlockId",
            "outcomeRefs",
            "learningPurpose",
            "grounding",
            "fallback",
        }
        allowed_keys = required_keys | {
            "title",
            "moduleId",
            "depth",
            "animationType",
            "caption",
            "config",
        }
        missing = sorted(required_keys - set(asset))
        extra = sorted(set(asset) - allowed_keys)
        if missing:
            errors.append(f"{asset_label} 缺少字段：{', '.join(missing)}")
        if extra:
            errors.append(f"{asset_label} 包含未知字段：{', '.join(extra)}")

        asset_id = asset.get("id")
        if not isinstance(asset_id, str) or not _ID_RE.fullmatch(asset_id):
            errors.append(f"{asset_label}.id 必须为 kebab-case")
        elif asset_id in seen_ids:
            errors.append(f"{asset_label}.id 重复：{asset_id}")
        else:
            seen_ids.add(asset_id)
        asset_type = asset.get("type")
        if not isinstance(asset_type, str) or not _ID_RE.fullmatch(asset_type):
            errors.append(f"{asset_label}.type 必须为 kebab-case")
        for text_field in ("learningPurpose", "title", "animationType", "caption"):
            if text_field in asset and (
                not isinstance(asset.get(text_field), str)
                or not asset[text_field].strip()
            ):
                errors.append(f"{asset_label}.{text_field} 必须是非空字符串")

        anchor_id = asset.get("anchorBlockId")
        if not isinstance(anchor_id, str) or not _ID_RE.fullmatch(anchor_id):
            errors.append(f"{asset_label}.anchorBlockId 必须为 kebab-case")
            anchor_index = None
        elif anchor_id not in block_index_by_id:
            errors.append(
                f"{asset_label}.anchorBlockId 引用了不存在的内容块：{anchor_id}"
            )
            anchor_index = None
        else:
            anchor_index = block_index_by_id[anchor_id]

        reference_errors, references = _validate_textbook_id_list(
            asset.get("outcomeRefs"), f"{asset_label}.outcomeRefs"
        )
        errors.extend(reference_errors)
        for outcome_id in references:
            if outcome_id not in outcome_ids:
                errors.append(
                    f"{asset_label}.outcomeRefs 引用了不存在的学习目标：{outcome_id}"
                )

        if "moduleId" in asset:
            module_id = asset.get("moduleId")
            if not isinstance(module_id, str) or not _ID_RE.fullmatch(module_id):
                errors.append(f"{asset_label}.moduleId 必须为 kebab-case")
            elif module_id not in module_ids:
                errors.append(
                    f"{asset_label}.moduleId 引用了不存在的教学模块：{module_id}"
                )
            elif anchor_id in block_by_id and block_by_id[anchor_id].get(
                "moduleId"
            ) != module_id:
                errors.append(
                    f"{asset_label}.moduleId 必须与 anchorBlockId 所属模块一致"
                )
        if "depth" in asset and asset.get("depth") not in _TEXTBOOK_LEARNING_DEPTHS:
            errors.append(f"{asset_label}.depth 必须是 core/support/advanced")
        if "config" in asset and not isinstance(asset.get("config"), dict):
            errors.append(f"{asset_label}.config 必须是对象")

        grounding = asset.get("grounding")
        if not isinstance(grounding, dict):
            errors.append(f"{asset_label}.grounding 必须是对象")
        else:
            if set(grounding) != {"basedOnBlockIds"}:
                errors.append(
                    f"{asset_label}.grounding 必须严格包含 basedOnBlockIds"
                )
            grounding_errors, grounding_ids = _validate_textbook_id_list(
                grounding.get("basedOnBlockIds"),
                f"{asset_label}.grounding.basedOnBlockIds",
            )
            errors.extend(grounding_errors)
            for block_id in grounding_ids:
                if block_id not in block_index_by_id:
                    errors.append(
                        f"{asset_label}.grounding 引用了不存在的内容块：{block_id}"
                    )
                elif not grounded_by_id.get(block_id, False):
                    errors.append(
                        f"{asset_label}.grounding 的内容块不能追溯到教材：{block_id}"
                    )
                elif anchor_index is not None and block_index_by_id[block_id] > anchor_index:
                    errors.append(
                        f"{asset_label}.grounding 只能引用 anchorBlockId 之前或自身的内容块：{block_id}"
                    )

        fallback = asset.get("fallback")
        if not isinstance(fallback, dict) or not fallback:
            errors.append(f"{asset_label}.fallback 必须是非空对象")
        else:
            allowed_fallback_keys = {
                "type",
                "blockId",
                "markdown",
                "caption",
                "mode",
                "content",
            }
            extra_fallback = sorted(set(fallback) - allowed_fallback_keys)
            if extra_fallback:
                errors.append(
                    f"{asset_label}.fallback 包含未知字段：{', '.join(extra_fallback)}"
                )
            for text_field, text_value in fallback.items():
                if not isinstance(text_value, str) or not text_value.strip():
                    errors.append(
                        f"{asset_label}.fallback.{text_field} 必须是非空字符串"
                    )
            fallback_block_id = fallback.get("blockId")
            if isinstance(fallback_block_id, str) and fallback_block_id not in block_index_by_id:
                errors.append(
                    f"{asset_label}.fallback.blockId 引用了不存在的内容块：{fallback_block_id}"
                )
            if not ({"type", "mode"} & set(fallback)):
                errors.append(f"{asset_label}.fallback 必须声明 type 或 mode")
            if not ({"blockId", "markdown", "caption", "content"} & set(fallback)):
                errors.append(f"{asset_label}.fallback 必须提供可用的降级内容")
            if isinstance(fallback.get("markdown"), str):
                errors.extend(
                    _validate_textbook_markdown(
                        fallback["markdown"], f"{asset_label}.fallback.markdown"
                    )
                )
    return errors


def _validate_textbook_content_point(point: dict[str, Any], label: str) -> list[str]:
    """Validate the published representation of a textbook-content/2.0 point."""

    errors: list[str] = []
    legacy_fields = sorted(_LEGACY_POINT_CONTENT_FIELDS.intersection(point))
    if legacy_fields:
        errors.append(f"{label}: v2 正文不允许同时保存旧字段：{', '.join(legacy_fields)}")
    if point.get("origin") not in {"textbook", "llm-extension", "user"}:
        errors.append(f"{label}: origin 必须是 textbook/llm-extension/user")

    content = point.get("content")
    if not isinstance(content, dict):
        return [*errors, f"{label}: content 必须是对象"]
    required_content_keys = {"schema_version", "blocks"}
    allowed_content_keys = required_content_keys | {"learningDesign", "learningAssets"}
    missing_content_keys = sorted(required_content_keys - set(content))
    extra_content_keys = sorted(set(content) - allowed_content_keys)
    if missing_content_keys:
        errors.append(
            f"{label}: content 缺少字段：{', '.join(missing_content_keys)}"
        )
    if extra_content_keys:
        errors.append(
            f"{label}: content 包含未知字段：{', '.join(extra_content_keys)}"
        )
    if content.get("schema_version") != _TEXTBOOK_CONTENT_SCHEMA:
        errors.append(f"{label}: content.schema_version 必须是 {_TEXTBOOK_CONTENT_SCHEMA}")
    blocks = content.get("blocks")
    if not isinstance(blocks, list):
        return [*errors, f"{label}: content.blocks 必须是数组"]

    seen_ids: set[str] = set()
    block_index_by_id: dict[str, int] = {}
    grounded_by_id: dict[str, bool] = {}
    derived_source_spans: list[dict[str, Any]] = []
    seen_source_spans: set[str] = set()
    textbook_blocks = 0
    model_blocks = 0
    required_block_keys = {"id", "kind", "markdown", "provenance"}
    allowed_block_keys = required_block_keys | {"title", "moduleId", "depth"}
    for index, block in enumerate(blocks):
        block_label = f"{label}: content.blocks[{index}]"
        if not isinstance(block, dict):
            errors.append(f"{block_label} 必须是对象")
            continue
        missing_block_keys = sorted(required_block_keys - set(block))
        extra_block_keys = sorted(set(block) - allowed_block_keys)
        if missing_block_keys:
            errors.append(f"{block_label} 缺少字段：{', '.join(missing_block_keys)}")
        if extra_block_keys:
            errors.append(f"{block_label} 包含未知字段：{', '.join(extra_block_keys)}")
        block_id = block.get("id")
        if not isinstance(block_id, str) or not _ID_RE.fullmatch(block_id):
            errors.append(f"{block_label}.id 必须为 kebab-case")
        elif block_id in seen_ids:
            errors.append(f"{block_label}.id 重复：{block_id}")
        else:
            seen_ids.add(block_id)
            block_index_by_id[block_id] = index
        if block.get("kind") not in _TEXTBOOK_BLOCK_KINDS:
            errors.append(f"{block_label}.kind 不是允许的教材内容块类型")
        if "title" in block and (
            not isinstance(block.get("title"), str) or not block["title"].strip()
        ):
            errors.append(f"{block_label}.title 必须是非空字符串")
        if "moduleId" in block and (
            not isinstance(block.get("moduleId"), str)
            or not _ID_RE.fullmatch(block["moduleId"])
        ):
            errors.append(f"{block_label}.moduleId 必须为 kebab-case")
        if "depth" in block and block.get("depth") not in _TEXTBOOK_LEARNING_DEPTHS:
            errors.append(f"{block_label}.depth 必须是 core/support/advanced")
        if not isinstance(block.get("markdown"), str) or not block["markdown"].strip():
            errors.append(f"{block_label}.markdown 必须是非空字符串")
        else:
            errors.extend(
                _validate_textbook_markdown(block["markdown"], f"{block_label}.markdown")
            )
        provenance = block.get("provenance")
        if not isinstance(provenance, dict):
            errors.append(f"{block_label}.provenance 必须是对象")
            continue

        origin = provenance.get("origin")
        block_spans = provenance.get("sourceSpans")
        if isinstance(block_spans, list):
            for span in block_spans:
                if not isinstance(span, dict):
                    continue
                span_key = json.dumps(
                    span,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                if span_key not in seen_source_spans:
                    seen_source_spans.add(span_key)
                    derived_source_spans.append(span)
        if origin == "textbook":
            textbook_blocks += 1
            required_provenance_keys = {"origin", "representation", "sourceSpans"}
            missing = sorted(required_provenance_keys - set(provenance))
            extra = sorted(set(provenance) - required_provenance_keys)
            if missing:
                errors.append(f"{block_label}.provenance 缺少字段：{', '.join(missing)}")
            if extra:
                errors.append(f"{block_label}.provenance 包含未知字段：{', '.join(extra)}")
            if provenance.get("representation") not in {"quote", "paraphrase"}:
                errors.append(f"{block_label}.provenance.representation 必须是 quote/paraphrase")
            spans = provenance.get("sourceSpans")
            errors.extend(
                _validate_textbook_source_spans(
                    spans,
                    f"{block_label}.provenance.sourceSpans",
                    require_non_empty=True,
                )
            )
            if isinstance(block_id, str):
                grounded_by_id[block_id] = True
        elif origin == "model":
            model_blocks += 1
            required_provenance_keys = {"origin", "basedOnBlockIds"}
            allowed_provenance_keys = required_provenance_keys | {"sourceSpans"}
            missing = sorted(required_provenance_keys - set(provenance))
            extra = sorted(set(provenance) - allowed_provenance_keys)
            if missing:
                errors.append(f"{block_label}.provenance 缺少字段：{', '.join(missing)}")
            if extra:
                errors.append(f"{block_label}.provenance 包含未知字段：{', '.join(extra)}")
            based_on = provenance.get("basedOnBlockIds")
            grounded = False
            if (
                not isinstance(based_on, list)
                or not based_on
                or any(not isinstance(item, str) or not _ID_RE.fullmatch(item) for item in based_on)
                or len(set(based_on)) != len(based_on)
            ):
                errors.append(
                    f"{block_label}.provenance.basedOnBlockIds "
                    "必须是非空、不重复的 kebab-case 字符串数组"
                )
            else:
                references_are_valid = True
                referenced_indexes: list[int] = []
                for referenced_id in based_on:
                    if referenced_id not in seen_ids or referenced_id == block_id:
                        references_are_valid = False
                        errors.append(f"{block_label} 只能引用排在当前块之前的 block：{referenced_id}")
                    else:
                        referenced_indexes.append(block_index_by_id[referenced_id])
                        if grounded_by_id.get(referenced_id):
                            grounded = True
                if references_are_valid and referenced_indexes:
                    last_reference_index = max(referenced_indexes)
                    crosses_textbook_block = any(
                        isinstance(candidate, dict)
                        and isinstance(candidate.get("provenance"), dict)
                        and candidate["provenance"].get("origin") == "textbook"
                        for candidate in blocks[last_reference_index + 1 : index]
                    )
                    if crosses_textbook_block:
                        errors.append(
                            f"{block_label} 必须紧跟最后一个直接依据，不能跨过后续教材块"
                        )
            if not grounded:
                errors.append(f"{block_label} 必须追溯到至少一个教材块")
            if "sourceSpans" in provenance:
                errors.extend(
                    _validate_textbook_source_spans(
                        provenance.get("sourceSpans"),
                        f"{block_label}.provenance.sourceSpans",
                        require_non_empty=False,
                    )
                )
            if isinstance(block_id, str):
                grounded_by_id[block_id] = grounded
        else:
            errors.append(f"{block_label}.provenance.origin 必须是 textbook/model")

    if textbook_blocks < 1:
        errors.append(f"{label}: content.blocks 至少需要一个教材块")
    if model_blocks < 1:
        errors.append(f"{label}: content.blocks 至少需要一个模型补充块")

    outcome_ids: set[str] = set()
    module_ids: set[str] = set()
    if "learningDesign" in content:
        design_errors, outcome_ids, module_ids = _validate_textbook_learning_design(
            content.get("learningDesign"),
            f"{label}: content.learningDesign",
            blocks=blocks,
            block_index_by_id=block_index_by_id,
        )
        errors.extend(design_errors)
    elif any(
        isinstance(block, dict) and ({"moduleId", "depth"} & set(block))
        for block in blocks
    ):
        errors.append(
            f"{label}: content.blocks 的 moduleId/depth 需要 content.learningDesign"
        )

    if "learningAssets" in content:
        if "learningDesign" not in content:
            errors.append(
                f"{label}: content.learningAssets 需要 content.learningDesign"
            )
        errors.extend(
            _validate_textbook_learning_assets(
                content.get("learningAssets"),
                f"{label}: content.learningAssets",
                outcome_ids=outcome_ids,
                module_ids=module_ids,
                blocks=blocks,
                block_index_by_id=block_index_by_id,
                grounded_by_id=grounded_by_id,
            )
        )
    if "sourceSpans" in point and point["sourceSpans"] != derived_source_spans:
        errors.append(f"{label}: 顶层 sourceSpans 必须与 content.blocks 派生值一致")
    if "modelEnriched" in point and (
        not isinstance(point["modelEnriched"], bool)
        or point["modelEnriched"] != (model_blocks > 0)
    ):
        errors.append(f"{label}: 顶层 modelEnriched 必须与 content.blocks 派生值一致")
    return errors


class CourseDataError(RuntimeError):
    """The request cannot be safely represented as course data."""


class CourseNotFoundError(CourseDataError):
    """The requested course or knowledge point does not exist."""


class CourseConflictError(CourseDataError):
    """A staging workspace is based on stale canonical data."""


class CourseValidationError(CourseDataError):
    """A candidate package failed validation before a commit."""

    def __init__(self, errors: Iterable[str], warnings: Iterable[str] = ()):
        self.errors = list(errors)
        self.warnings = list(warnings)
        detail = "; ".join(self.errors[:4]) or "课程数据校验失败"
        super().__init__(detail)


@dataclass(slots=True)
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


@dataclass(frozen=True, slots=True)
class CourseWorkspace:
    """A staged copy of every course package for one agent conversation."""

    conversation_id: str
    path: Path
    base_fingerprint: str


def _safe_id(value: str, label: str) -> str:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise CourseDataError(f"{label} 必须是小写 kebab-case 标识符")
    return value


def _safe_conversation_id(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in value)
    return cleaned[:80] or "default"


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _deepcopy_json(value: Any) -> Any:
    """Copy JSON-compatible values without retaining caller-owned containers."""

    return json.loads(json.dumps(value, ensure_ascii=False))


class CourseStore:
    """Read, validate, mutate, and commit JSON course packages."""

    def __init__(self, root: Path | None = None, workspace_root: Path | None = None):
        self.root = (root or settings.course_data_dir).resolve()
        self.workspace_root = (workspace_root or settings.course_agent_workspace_dir).resolve()
        self._lock = threading.RLock()
        self.root.mkdir(parents=True, exist_ok=True)
        self.workspace_root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Safe paths and raw JSON I/O
    # ------------------------------------------------------------------

    def _within(self, root: Path, path: Path) -> Path:
        resolved_root = root.resolve()
        resolved_path = path.resolve()
        if not resolved_path.is_relative_to(resolved_root):
            raise CourseDataError("课程数据路径超出受限工作区")
        return resolved_path

    def _course_dir(self, course_id: str, *, root: Path | None = None, required: bool = True) -> Path:
        cid = _safe_id(course_id, "course_id")
        base = (root or self.root).resolve()
        path = self._within(base, base / cid)
        if required and (not path.is_dir() or path.is_symlink()):
            raise CourseNotFoundError(f"课程不存在：{cid}")
        return path

    def _point_path(
        self,
        course_id: str,
        point_id: str,
        *,
        root: Path | None = None,
        required: bool = True,
    ) -> Path:
        pid = _safe_id(point_id, "point_id")
        directory = self._course_dir(course_id, root=root, required=required)
        path = self._within(directory, directory / "points" / f"{pid}.json")
        if required and (not path.is_file() or path.is_symlink()):
            raise CourseNotFoundError(f"知识点不存在：{pid}")
        return path

    def _animation_dir(
        self,
        course_id: str,
        *,
        root: Path | None = None,
        required: bool = True,
    ) -> Path:
        directory = self._course_dir(course_id, root=root, required=required)
        path = self._within(directory, directory / "animations")
        if required and (not path.is_dir() or path.is_symlink()):
            raise CourseNotFoundError(f"课程没有可用动画：{course_id}")
        return path

    def _animation_asset_path(
        self,
        course_id: str,
        file_name: str,
        *,
        root: Path | None = None,
    ) -> Path:
        if file_name not in _ANIMATION_ASSET_FILES:
            raise CourseNotFoundError(f"动画资产不存在：{file_name}")
        directory = self._animation_dir(course_id, root=root)
        path = self._within(directory, directory / file_name)
        if not path.is_file() or path.is_symlink():
            raise CourseNotFoundError(f"动画资产不存在：{file_name}")
        return path

    def _read_json(self, path: Path, *, root: Path | None = None) -> dict[str, Any]:
        if root is not None:
            self._within(root, path)
        if not path.is_file() or path.is_symlink():
            raise CourseNotFoundError(f"数据文件不存在：{path.name}")
        if path.stat().st_size > _MAX_JSON_BYTES:
            raise CourseDataError(f"数据文件过大：{path.name}")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise CourseDataError(f"JSON 解析失败：{path.name}: {exc.msg}") from exc
        except OSError as exc:
            raise CourseDataError(f"无法读取数据文件：{path.name}: {exc}") from exc
        if not isinstance(value, dict):
            raise CourseDataError(f"JSON 根节点必须是对象：{path.name}")
        return value

    @staticmethod
    def _revision() -> str:
        return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]

    @staticmethod
    def _today() -> str:
        return datetime.now(UTC).date().isoformat()

    @staticmethod
    def _stored_revision(course: dict[str, Any], fallback: str) -> str:
        """Accept the imported numeric revision while emitting one stable type."""

        value = course.get("revision")
        if isinstance(value, str) and value:
            return value
        if isinstance(value, int) and not isinstance(value, bool):
            return str(value)
        return fallback

    # ------------------------------------------------------------------
    # Public read API
    # ------------------------------------------------------------------

    def list_courses(self) -> list[dict[str, Any]]:
        with self._lock:
            courses: list[dict[str, Any]] = []
            if not self.root.exists():
                return courses
            fallback_revision = self._fingerprint(self.root)
            for directory in sorted(self.root.iterdir(), key=lambda item: item.name):
                if not directory.is_dir() or directory.is_symlink() or not _ID_RE.fullmatch(directory.name):
                    continue
                try:
                    course = self._read_json(directory / "course.json", root=self.root)
                    index = self._read_json(directory / "index.json", root=self.root)
                except CourseDataError:
                    # A malformed package should not make unrelated courses disappear
                    # from the service entirely. It is exposed as invalid instead.
                    courses.append({"id": directory.name, "invalid": True})
                    continue
                courses.append({
                    "id": directory.name,
                    "title": course.get("title", directory.name),
                    "description": course.get("description", ""),
                    "language": course.get("language", "zh-CN"),
                    "revision": self._stored_revision(course, fallback_revision),
                    "clusters": len(index.get("clusters") or []),
                    "points": len(index.get("points") or []),
                    "placeholder": course.get("placeholder") is True,
                })
            return courses

    # ------------------------------------------------------------------
    # User-managed course catalogue
    # ------------------------------------------------------------------

    @property
    def _catalog_path(self) -> Path:
        """The catalogue is beside ``courses/``, never inside a course package."""

        return self.root.parent / _COURSE_CATALOG_FILE

    def _catalog_course_ids(self) -> list[str]:
        """Return package IDs without requiring every package to validate."""

        if not self.root.exists():
            return []
        identifiers: list[str] = []
        for item in self.root.iterdir():
            if item.is_symlink():
                raise CourseDataError(f"不允许符号链接：{item.name}")
            if item.is_dir() and _ID_RE.fullmatch(item.name):
                identifiers.append(item.name)
        return sorted(identifiers)

    def _read_catalog_raw(self) -> dict[str, Any] | None:
        path = self._catalog_path
        if not path.exists():
            return None
        if path.is_symlink() or not path.is_file():
            raise CourseDataError("课程目录配置文件无效")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CourseDataError(f"课程目录配置读取失败：{exc}") from exc
        if not isinstance(value, dict):
            raise CourseDataError("课程目录配置根节点必须是对象")
        return value

    @staticmethod
    def _catalog_group_name(value: Any) -> str:
        if not isinstance(value, str):
            raise CourseDataError("学科大类名称必须是字符串")
        name = value.strip()
        if not name:
            raise CourseDataError("学科大类名称不能为空")
        if len(name) > _MAX_CATALOG_GROUP_NAME:
            raise CourseDataError(f"学科大类名称不能超过 {_MAX_CATALOG_GROUP_NAME} 个字符")
        return name

    def _normalise_catalog(
        self,
        raw: dict[str, Any] | None,
        course_ids: list[str],
    ) -> tuple[dict[str, Any], bool]:
        """Validate, repair, and complete a catalogue snapshot.

        A missing file is intentionally different from an edited file: the
        first snapshot creates ``我的课程`` and puts every existing package in
        it.  Later snapshots keep empty groups and only place newly discovered
        packages in the default/first group.
        """

        available = set(course_ids)
        if raw is None:
            groups: list[dict[str, Any]] = [{
                "id": _DEFAULT_CATALOG_GROUP_ID,
                "name": "我的课程",
                "order": 0,
                "course_ids": list(course_ids),
                "edges": [],
                "layout": {"mode": "hybrid", "positions": {}},
            }]
            return {
                "schema_version": _COURSE_CATALOG_SCHEMA,
                "revision": self._revision(),
                "groups": groups,
            }, True

        if raw.get("schema_version", _COURSE_CATALOG_SCHEMA) != _COURSE_CATALOG_SCHEMA:
            raise CourseDataError("不支持的课程目录版本")
        raw_groups = raw.get("groups")
        if not isinstance(raw_groups, list):
            raise CourseDataError("课程目录 groups 必须是数组")
        if len(raw_groups) > _MAX_CATALOG_GROUPS:
            raise CourseDataError("学科大类数量超过上限")

        parsed: list[tuple[int, dict[str, Any]]] = []
        seen_ids: set[str] = set()
        for position, item in enumerate(raw_groups):
            if not isinstance(item, dict):
                raise CourseDataError("课程目录中的学科大类必须是对象")
            group_id = item.get("id")
            _safe_id(group_id, "group.id")
            if group_id in seen_ids:
                raise CourseDataError(f"学科大类 ID 重复：{group_id}")
            seen_ids.add(group_id)
            name = self._catalog_group_name(item.get("name"))
            order = item.get("order", position)
            if not isinstance(order, int) or isinstance(order, bool):
                order = position
            raw_course_ids = item.get("course_ids", [])
            if not isinstance(raw_course_ids, list):
                raise CourseDataError(f"学科大类 {group_id} 的课程列表必须是数组")
            clean_course_ids: list[str] = []
            for course_id in raw_course_ids:
                if not isinstance(course_id, str) or not _ID_RE.fullmatch(course_id):
                    raise CourseDataError(f"课程 ID 无效：{course_id}")
                if course_id in available and course_id not in clean_course_ids:
                    clean_course_ids.append(course_id)
            parsed.append((order, {
                "id": group_id,
                "name": name,
                "order": order,
                "course_ids": clean_course_ids,
                "edges": item.get("edges", []),
                "layout": item.get("layout"),
            }))

        parsed.sort(key=lambda entry: (entry[0], entry[1]["id"]))
        groups = [group for _, group in parsed]
        if not groups:
            groups = [{
                "id": _DEFAULT_CATALOG_GROUP_ID,
                "name": "我的课程",
                "order": 0,
                "course_ids": [],
                "edges": [],
                "layout": {"mode": "hybrid", "positions": {}},
            }]

        # A course has one owner.  The first occurrence wins, and newly
        # created packages go to the default group (or the first visible one
        # if the original default was deliberately removed).
        assigned: set[str] = set()
        for group in groups:
            unique_course_ids: list[str] = []
            for course_id in group["course_ids"]:
                if course_id in assigned:
                    continue
                assigned.add(course_id)
                unique_course_ids.append(course_id)
            group["course_ids"] = unique_course_ids
        target = next(
            (group for group in groups if group["id"] == _DEFAULT_CATALOG_GROUP_ID),
            groups[0],
        )
        target["course_ids"].extend(
            course_id for course_id in course_ids if course_id not in assigned
        )
        for order, group in enumerate(groups):
            group["order"] = order
            # External package removal or duplicate ownership can invalidate
            # endpoints. Drop those edges while preserving the remaining graph.
            edges = group["edges"]
            if not isinstance(edges, list):
                raise CourseDataError("学科大类的课程关系必须是数组")
            members = set(group["course_ids"])
            retained = []
            for edge in edges:
                if (
                    not isinstance(edge, dict)
                    or not isinstance(edge.get("fromId"), str)
                    or not isinstance(edge.get("toId"), str)
                ):
                    raise CourseDataError("每条课程关系必须包含 fromId 和 toId")
                if edge["fromId"] in members and edge["toId"] in members:
                    retained.append(edge)
            group["edges"] = self._validate_catalog_edges(retained, members)
            group["layout"] = self._validate_catalog_layout(group.get("layout"), members)

        revision = raw.get("revision")
        if not isinstance(revision, str) or not revision:
            revision = self._revision()
        candidate = {
            "schema_version": _COURSE_CATALOG_SCHEMA,
            "revision": revision,
            "groups": groups,
        }
        return candidate, candidate != raw

    def _write_catalog(self, catalog: dict[str, Any]) -> dict[str, Any]:
        catalog = _deepcopy_json(catalog)
        catalog["schema_version"] = _COURSE_CATALOG_SCHEMA
        catalog["revision"] = self._revision()
        path = self._catalog_path
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write(_json_bytes(catalog))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise CourseDataError(f"课程目录保存失败：{exc}") from exc
        return catalog

    def _catalog_for_mutation(self) -> dict[str, Any]:
        catalog, changed = self._normalise_catalog(
            self._read_catalog_raw(), self._catalog_course_ids()
        )
        return self._write_catalog(catalog) if changed else catalog

    def _sync_catalog_after_course_change(self, removed_course_id: str | None = None) -> None:
        """Keep the independent catalogue aligned with package creation/deletion.

        Catalogue metadata must never make a course package impossible to
        create or delete.  A malformed user-edited catalogue is therefore
        left for the catalogue endpoint to report and repair explicitly.
        """

        try:
            catalog = self._catalog_for_mutation()
            if removed_course_id is not None:
                for group in catalog["groups"]:
                    group["course_ids"] = [
                        course_id
                        for course_id in group["course_ids"]
                        if course_id != removed_course_id
                    ]
                    layout = group.get("layout")
                    if isinstance(layout, dict) and isinstance(layout.get("positions"), dict):
                        layout["positions"].pop(removed_course_id, None)
            self._write_catalog(catalog)
        except CourseDataError:
            return

    def list_catalog(self) -> dict[str, Any]:
        with self._lock:
            catalog, changed = self._normalise_catalog(
                self._read_catalog_raw(), self._catalog_course_ids()
            )
            if changed:
                catalog = self._write_catalog(catalog)
            return _deepcopy_json(catalog)

    @staticmethod
    def _validate_catalog_layout(
        layout: Any, members: set[str]
    ) -> dict[str, Any]:
        """Keep only finite, member-owned graph anchors."""
        if layout is None:
            return {"mode": "hybrid", "positions": {}}
        if not isinstance(layout, dict):
            raise CourseDataError("课程图谱布局必须是对象")
        raw_positions = layout.get("positions", {})
        if not isinstance(raw_positions, dict):
            raise CourseDataError("课程图谱布局 positions 必须是对象")
        clean: dict[str, dict[str, Any]] = {}
        for course_id, raw_position in raw_positions.items():
            if course_id not in members:
                continue
            if not isinstance(raw_position, dict):
                raise CourseDataError("课程图谱节点位置必须是对象")
            x, y = raw_position.get("x"), raw_position.get("y")
            if (
                isinstance(x, bool)
                or not isinstance(x, (int, float))
                or isinstance(y, bool)
                or not isinstance(y, (int, float))
                or not math.isfinite(float(x))
                or not math.isfinite(float(y))
                or abs(float(x)) > 100000
                or abs(float(y)) > 100000
            ):
                raise CourseDataError("课程图谱节点位置必须是有限数字")
            pinned = raw_position.get("pinned", True)
            if not isinstance(pinned, bool):
                raise CourseDataError("课程图谱节点 pinned 必须是布尔值")
            clean[course_id] = {
                "x": round(float(x), 3),
                "y": round(float(y), 3),
                "pinned": pinned,
            }
        return {"mode": "hybrid", "positions": clean}

    @staticmethod
    def _validate_catalog_edges(
        edges: list[dict[str, Any]], members: set[str]
    ) -> list[dict[str, str]]:
        adjacency: dict[str, list[str]] = {course_id: [] for course_id in members}
        indegree = {course_id: 0 for course_id in members}
        seen: set[tuple[str, str]] = set()
        clean: list[dict[str, str]] = []
        for edge in edges:
            if not isinstance(edge, dict):
                raise CourseDataError("每条课程关系必须是对象")
            source, target = edge.get("fromId"), edge.get("toId")
            if (
                not isinstance(source, str)
                or not isinstance(target, str)
                or source not in members
                or target not in members
            ):
                raise CourseDataError("课程关系的两端必须属于当前学科大类")
            if source == target:
                raise CourseDataError("课程不能与自身建立先后关系")
            if (source, target) in seen:
                raise CourseDataError("同一条课程先后关系不能重复")
            seen.add((source, target))
            adjacency[source].append(target)
            indegree[target] += 1
            clean.append({"fromId": source, "toId": target})
        ready = [course_id for course_id, degree in indegree.items() if degree == 0]
        visited = 0
        while ready:
            source = ready.pop()
            visited += 1
            for target in adjacency[source]:
                indegree[target] -= 1
                if indegree[target] == 0:
                    ready.append(target)
        if visited != len(members):
            raise CourseDataError("课程先后关系不能形成循环")
        return clean

    def read_catalog_group(self, group_id: str) -> dict[str, Any]:
        with self._lock:
            _safe_id(group_id, "group_id")
            catalog = self._catalog_for_mutation()
            group = next((item for item in catalog["groups"] if item["id"] == group_id), None)
            if group is None:
                raise CourseNotFoundError(f"学科大类不存在：{group_id}")
            return _deepcopy_json(group)

    def update_catalog_edges(self, group_id: str, edges: list[dict[str, Any]]) -> dict[str, Any]:
        with self._lock:
            _safe_id(group_id, "group_id")
            catalog = self._catalog_for_mutation()
            group = next((item for item in catalog["groups"] if item["id"] == group_id), None)
            if group is None:
                raise CourseNotFoundError(f"学科大类不存在：{group_id}")
            group["edges"] = self._validate_catalog_edges(edges, set(group["course_ids"]))
            self._write_catalog(catalog)
            return _deepcopy_json(group)

    def update_catalog_layout(
        self, group_id: str, positions: dict[str, dict[str, Any]]
    ) -> dict[str, Any]:
        with self._lock:
            _safe_id(group_id, "group_id")
            catalog = self._catalog_for_mutation()
            group = next((item for item in catalog["groups"] if item["id"] == group_id), None)
            if group is None:
                raise CourseNotFoundError(f"学科大类不存在：{group_id}")
            group["layout"] = self._validate_catalog_layout(
                {"mode": "hybrid", "positions": positions},
                set(group["course_ids"]),
            )
            self._write_catalog(catalog)
            return _deepcopy_json(group)

    def create_catalog_group(self, name: str) -> dict[str, Any]:
        with self._lock:
            catalog = self._catalog_for_mutation()
            clean_name = self._catalog_group_name(name)
            if len(catalog["groups"]) >= _MAX_CATALOG_GROUPS:
                raise CourseDataError("学科大类数量超过上限")
            group_id = f"group-{uuid.uuid4().hex[:10]}"
            group = {
                "id": group_id,
                "name": clean_name,
                "order": len(catalog["groups"]),
                "course_ids": [],
                "edges": [],
                "layout": {"mode": "hybrid", "positions": {}},
            }
            catalog["groups"].append(group)
            self._write_catalog(catalog)
            return _deepcopy_json(group)

    def update_catalog_group(self, group_id: str, name: str) -> dict[str, Any]:
        with self._lock:
            _safe_id(group_id, "group_id")
            catalog = self._catalog_for_mutation()
            group = next((item for item in catalog["groups"] if item["id"] == group_id), None)
            if group is None:
                raise CourseNotFoundError(f"学科大类不存在：{group_id}")
            group["name"] = self._catalog_group_name(name)
            self._write_catalog(catalog)
            return _deepcopy_json(group)

    def delete_catalog_group(self, group_id: str) -> None:
        with self._lock:
            _safe_id(group_id, "group_id")
            catalog = self._catalog_for_mutation()
            groups = catalog["groups"]
            group = next((item for item in groups if item["id"] == group_id), None)
            if group is None:
                raise CourseNotFoundError(f"学科大类不存在：{group_id}")
            if len(groups) == 1:
                raise CourseDataError("至少保留一个学科大类")
            if group["course_ids"]:
                raise CourseDataError("请先将该大类中的课程移入其他大类")
            catalog["groups"] = [item for item in groups if item["id"] != group_id]
            for order, item in enumerate(catalog["groups"]):
                item["order"] = order
            self._write_catalog(catalog)

    def assign_course_to_catalog_group(self, course_id: str, group_id: str) -> dict[str, Any]:
        with self._lock:
            _safe_id(course_id, "course_id")
            _safe_id(group_id, "group_id")
            if course_id not in self._catalog_course_ids():
                raise CourseNotFoundError(f"课程不存在：{course_id}")
            catalog = self._catalog_for_mutation()
            target = next((item for item in catalog["groups"] if item["id"] == group_id), None)
            if target is None:
                raise CourseNotFoundError(f"学科大类不存在：{group_id}")
            for group in catalog["groups"]:
                if group is target:
                    continue
                group["course_ids"] = [item for item in group["course_ids"] if item != course_id]
                group["edges"] = [
                    edge
                    for edge in group["edges"]
                    if course_id not in (edge["fromId"], edge["toId"])
                ]
                layout = group.get("layout") or {"mode": "hybrid", "positions": {}}
                if isinstance(layout, dict) and isinstance(layout.get("positions"), dict):
                    layout["positions"].pop(course_id, None)
            if course_id not in target["course_ids"]:
                target["course_ids"].append(course_id)
            self._write_catalog(catalog)
            return _deepcopy_json(catalog)

    def reorder_catalog_groups(self, group_ids: list[str]) -> dict[str, Any]:
        with self._lock:
            catalog = self._catalog_for_mutation()
            current_ids = [group["id"] for group in catalog["groups"]]
            if len(group_ids) != len(set(group_ids)) or set(group_ids) != set(current_ids):
                raise CourseDataError("排序列表必须完整包含每个学科大类且不能重复")
            by_id = {group["id"]: group for group in catalog["groups"]}
            catalog["groups"] = [by_id[group_id] for group_id in group_ids]
            for order, group in enumerate(catalog["groups"]):
                group["order"] = order
            self._write_catalog(catalog)
            return _deepcopy_json(catalog)

    def read_course(self, course_id: str) -> dict[str, Any]:
        with self._lock:
            directory = self._course_dir(course_id)
            course = self._read_json(directory / "course.json", root=self.root)
            return _deepcopy_json(course)

    def read_index(self, course_id: str) -> dict[str, Any]:
        with self._lock:
            directory = self._course_dir(course_id)
            index = self._read_json(directory / "index.json", root=self.root)
            # The source AI course predates CKDS and does not contain courseId.
            # Add it at read time so new consumers always receive a stable shape
            # without modifying the imported source merely by viewing it.
            index = _deepcopy_json(index)
            index.setdefault("schema_version", "1.0")
            index.setdefault("courseId", course_id)
            return index

    def read_point(self, course_id: str, point_id: str) -> dict[str, Any]:
        with self._lock:
            point = self._read_json(self._point_path(course_id, point_id), root=self.root)
            return _deepcopy_json(point)

    def read_animation_manifest(self, course_id: str) -> dict[str, Any]:
        with self._lock:
            _, _, points = self._load_course_objects(self.root, course_id)
            self._animation_dir(course_id, root=self.root)
            validation = self._validate_animation_package(self.root, course_id, points)
            if not validation.ok:
                raise CourseValidationError(validation.errors, validation.warnings)
            manifest = self._read_json(
                self._animation_asset_path(course_id, "manifest.json", root=self.root),
                root=self.root,
            )
            return _deepcopy_json(manifest)

    def read_animation_definition(self, course_id: str, animation_type: str) -> dict[str, Any]:
        if not isinstance(animation_type, str) or not _ANIMATION_TYPE_RE.fullmatch(animation_type):
            raise CourseNotFoundError(f"动画类型不存在：{animation_type}")
        manifest = self.read_animation_manifest(course_id)
        for animation in manifest.get("animations") or []:
            if isinstance(animation, dict) and animation.get("type") == animation_type:
                return _deepcopy_json(animation)
        raise CourseNotFoundError(f"动画类型不存在：{animation_type}")

    def read_animation_asset(self, course_id: str, file_name: str) -> bytes:
        if file_name not in {"runtime.js", "runtime.css"}:
            raise CourseNotFoundError(f"动画资产不存在：{file_name}")
        with self._lock:
            # Validate hashes before serving executable content. A partial or
            # externally modified package must fail closed instead of running.
            self.read_animation_manifest(course_id)
            path = self._animation_asset_path(course_id, file_name, root=self.root)
            if path.stat().st_size > _MAX_JSON_BYTES:
                raise CourseDataError(f"动画资产过大：{file_name}")
            return path.read_bytes()

    def revision(self, course_id: str) -> str:
        course = self.read_course(course_id)
        return self._stored_revision(course, self._fingerprint(self.root))

    # ------------------------------------------------------------------
    # Package validation
    # ------------------------------------------------------------------

    @staticmethod
    def _is_number(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool)

    @staticmethod
    def _is_pair(value: Any) -> bool:
        return (
            isinstance(value, list)
            and len(value) == 2
            and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)
        )

    def _validate_course_objects(
        self,
        course_id: str,
        course: dict[str, Any],
        index: dict[str, Any],
        points: dict[str, dict[str, Any]],
        *,
        strict_details: bool,
    ) -> ValidationResult:
        result = ValidationResult()
        prefix = f"课程 {course_id}"

        if course.get("id") != course_id:
            result.errors.append(f"{prefix}: course.json 的 id 必须等于目录名")
        if not isinstance(course.get("title"), str) or not course["title"].strip():
            result.errors.append(f"{prefix}: course.json 缺少非空 title")
        if "schema_version" in course and not isinstance(course["schema_version"], str):
            result.errors.append(f"{prefix}: schema_version 必须是字符串")

        if index.get("courseId") not in (None, course_id):
            result.errors.append(f"{prefix}: index.json 的 courseId 与目录名不一致")
        clusters = index.get("clusters")
        indexed_points = index.get("points")
        if not isinstance(clusters, list):
            result.errors.append(f"{prefix}: index.json.clusters 必须是数组")
            clusters = []
        if not isinstance(indexed_points, list):
            result.errors.append(f"{prefix}: index.json.points 必须是数组")
            indexed_points = []

        cluster_ids: set[str] = set()
        for item in clusters:
            if not isinstance(item, dict):
                result.errors.append(f"{prefix}: clusters 中存在非对象")
                continue
            cid = item.get("id")
            if not isinstance(cid, str) or not _ID_RE.fullmatch(cid):
                result.errors.append(f"{prefix}: 知识簇 id 必须为 kebab-case")
                continue
            if cid in cluster_ids:
                result.errors.append(f"{prefix}: 知识簇 id 重复：{cid}")
            cluster_ids.add(cid)
            if not isinstance(item.get("title"), str) or not item["title"].strip():
                result.errors.append(f"{prefix}: 知识簇 {cid} 缺少非空 title")
            for color_name in ("accent", "soft", "dark"):
                color = item.get(color_name)
                if color is not None and (not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color)):
                    result.errors.append(f"{prefix}: 知识簇 {cid}.{color_name} 必须是 #RRGGBB")
            if "labelPos" in item and not self._is_pair(item["labelPos"]):
                result.errors.append(f"{prefix}: 知识簇 {cid}.labelPos 必须是 [x, y]")
            if "polygon" in item:
                polygon = item["polygon"]
                if not isinstance(polygon, list) or any(not self._is_pair(vertex) for vertex in polygon):
                    result.errors.append(f"{prefix}: 知识簇 {cid}.polygon 必须是坐标数组")

        index_by_id: dict[str, dict[str, Any]] = {}
        for item in indexed_points:
            if not isinstance(item, dict):
                result.errors.append(f"{prefix}: points 中存在非对象")
                continue
            pid = item.get("id")
            if not isinstance(pid, str) or not _ID_RE.fullmatch(pid):
                result.errors.append(f"{prefix}: 知识点 id 必须为 kebab-case")
                continue
            if pid in index_by_id:
                result.errors.append(f"{prefix}: 知识点 id 重复：{pid}")
                continue
            index_by_id[pid] = item
            cluster_id = item.get("clusterId")
            if cluster_id not in cluster_ids:
                result.errors.append(f"{prefix}: 知识点 {pid} 引用了不存在的知识簇 {cluster_id}")
            if not isinstance(item.get("title"), str) or not item["title"].strip():
                result.errors.append(f"{prefix}: 知识点 {pid} 缺少非空 title")
            if not isinstance(item.get("shortSummary"), str):
                result.errors.append(f"{prefix}: 知识点 {pid}.shortSummary 必须是字符串")
            difficulty = item.get("difficulty")
            if difficulty not in {"基础", "中等", "进阶"}:
                result.errors.append(f"{prefix}: 知识点 {pid}.difficulty 必须是 基础/中等/进阶")
            importance = item.get("importance")
            if not self._is_number(importance) or not 0 <= float(importance) <= 1:
                result.errors.append(f"{prefix}: 知识点 {pid}.importance 必须在 0 到 1 之间")
            key_terms = item.get("keyTerms")
            if not isinstance(key_terms, list) or any(not isinstance(term, str) for term in key_terms):
                result.errors.append(f"{prefix}: 知识点 {pid}.keyTerms 必须是字符串数组")
            if not self._is_pair(item.get("pos")):
                result.errors.append(f"{prefix}: 知识点 {pid}.pos 必须是 [x, y]")
            scale = item.get("scale")
            if not self._is_number(scale) or float(scale) <= 0:
                result.errors.append(f"{prefix}: 知识点 {pid}.scale 必须大于 0")

        point_ids = set(points)
        indexed_ids = set(index_by_id)
        canonical_next_by_id: dict[str, str | None] | None = None
        sequences = index.get("sequences")
        if sequences is not None:
            if not isinstance(sequences, dict) or set(sequences) != {"cluster", "point"}:
                result.errors.append(
                    f"{prefix}: index.json.sequences 必须严格包含 cluster 和 point"
                )
            else:
                cluster_sequence_valid = self._validate_sequence_edges(
                    sequences.get("cluster"),
                    cluster_ids,
                    f"{prefix}: 知识簇顺序",
                    result,
                )
                point_sequence_valid = self._validate_sequence_edges(
                    sequences.get("point"),
                    indexed_ids,
                    f"{prefix}: 知识点顺序",
                    result,
                )
                if cluster_sequence_valid and point_sequence_valid:
                    canonical_point_order = self._canonical_point_order(
                        clusters,
                        indexed_points,
                        sequences,
                    )
                    canonical_next_by_id = {
                        point_id: (
                            canonical_point_order[position + 1]
                            if position + 1 < len(canonical_point_order)
                            else None
                        )
                        for position, point_id in enumerate(canonical_point_order)
                    }
        for missing in sorted(indexed_ids - point_ids):
            result.errors.append(f"{prefix}: index 中的知识点缺少详情文件：{missing}")
        for extra in sorted(point_ids - indexed_ids):
            result.errors.append(f"{prefix}: points 目录存在未索引详情文件：{extra}")

        for pid in sorted(indexed_ids & point_ids):
            detail = points[pid]
            if detail.get("id") != pid:
                result.errors.append(f"{prefix}: points/{pid}.json 的 id 不匹配")
            for field_name in _POINT_META_FIELDS:
                if detail.get(field_name) != index_by_id[pid].get(field_name):
                    message = f"{prefix}: 知识点 {pid} 的 {field_name} 未与 index 同步"
                    # The imported AI Principles package contains a small number
                    # of historical metadata mismatches. Keep it readable while
                    # exposing them to validation; new REST writes always use
                    # strict validation and cannot introduce new mismatches.
                    if strict_details:
                        result.errors.append(message)
                    else:
                        result.warnings.append(message)

            prerequisites = detail.get("prerequisites")
            if prerequisites is None:
                message = f"{prefix}: 知识点 {pid} 缺少 prerequisites（建议写 []）"
                (result.errors if strict_details else result.warnings).append(message)
            elif not isinstance(prerequisites, list) or any(not isinstance(item, str) for item in prerequisites):
                result.errors.append(f"{prefix}: 知识点 {pid}.prerequisites 必须是字符串数组")
            else:
                if len(set(prerequisites)) != len(prerequisites):
                    result.errors.append(f"{prefix}: 知识点 {pid}.prerequisites 不可重复")
                if pid in prerequisites:
                    result.errors.append(f"{prefix}: 知识点 {pid} 不可依赖自身")
                for prerequisite in prerequisites:
                    if prerequisite not in indexed_ids:
                        message = f"{prefix}: 知识点 {pid} 的前置引用不存在：{prerequisite}"
                        (result.errors if strict_details else result.warnings).append(message)

            # ``strict_details=False`` exists so historical courses with
            # incomplete legacy fields remain readable.  A point that carries
            # the versioned ``content`` envelope is different: its declared
            # contract must never be reduced to a best-effort warning merely
            # because the caller is using the legacy-compatible validation
            # mode.  Checking for the key (rather than only a valid schema
            # value) also reports a damaged or downgraded v2 envelope.
            if "content" in detail:
                result.errors.extend(
                    _validate_textbook_content_point(detail, f"{prefix}: 知识点 {pid}")
                )
                content = detail.get("content")
                learning_design = (
                    content.get("learningDesign")
                    if isinstance(content, dict)
                    else None
                )
                completion = (
                    learning_design.get("completion")
                    if isinstance(learning_design, dict)
                    else None
                )
                next_point_id = (
                    completion.get("nextPointId")
                    if isinstance(completion, dict)
                    and "nextPointId" in completion
                    else None
                )
                if (
                    isinstance(next_point_id, str)
                    and _ID_RE.fullmatch(next_point_id)
                ):
                    if next_point_id not in indexed_ids:
                        result.errors.append(
                            f"{prefix}: 知识点 {pid}.content.learningDesign.completion."
                            f"nextPointId 引用了本课程不存在的知识点：{next_point_id}"
                        )
                    elif canonical_next_by_id is not None and pid in canonical_next_by_id:
                        expected_next = canonical_next_by_id[pid]
                        if expected_next is None:
                            result.errors.append(
                                f"{prefix}: 知识点 {pid} 位于规范学习顺序末尾，"
                                "不应声明 content.learningDesign.completion.nextPointId"
                            )
                        elif next_point_id != expected_next:
                            result.errors.append(
                                f"{prefix}: 知识点 {pid}.content.learningDesign.completion."
                                "nextPointId 必须指向规范学习顺序中的直接下一点 "
                                f"{expected_next}，实际为 {next_point_id}"
                            )
            elif strict_details:
                if not isinstance(detail.get("coreIdea"), str) or not detail["coreIdea"].strip():
                    result.errors.append(f"{prefix}: 知识点 {pid} 缺少非空 coreIdea")
                for content_field in ("principles", "applications"):
                    value = detail.get(content_field)
                    if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item.strip() for item in value):
                        result.errors.append(f"{prefix}: 知识点 {pid}.{content_field} 必须是非空字符串数组")

        return result

    @staticmethod
    def _validate_sequence_edges(
        value: Any,
        known_ids: set[str],
        label: str,
        result: ValidationResult,
    ) -> bool:
        """Validate optional directed reading-order edges independently of prerequisites."""

        if not isinstance(value, list):
            result.errors.append(f"{label}必须是数组")
            return False
        valid = True
        edges: set[tuple[str, str]] = set()
        adjacency: dict[str, list[str]] = {item: [] for item in known_ids}
        for index, edge in enumerate(value):
            if not isinstance(edge, dict) or set(edge) != {"fromId", "toId"}:
                result.errors.append(
                    f"{label}[{index}] 必须严格包含 fromId/toId"
                )
                valid = False
                continue
            source = edge.get("fromId")
            target = edge.get("toId")
            if not isinstance(source, str) or not isinstance(target, str):
                result.errors.append(
                    f"{label}[{index}] 的 fromId/toId 必须是字符串"
                )
                valid = False
                continue
            if source not in known_ids or target not in known_ids:
                result.errors.append(f"{label}[{index}] 包含悬空引用")
                valid = False
                continue
            if source == target:
                result.errors.append(f"{label}[{index}] 不允许自环")
                valid = False
                continue
            pair = (source, target)
            if pair in edges:
                result.errors.append(f"{label}[{index}] 与已有顺序边重复")
                valid = False
                continue
            edges.add(pair)
            adjacency[source].append(target)

        state: dict[str, int] = {item: 0 for item in known_ids}

        def visit(node: str) -> bool:
            state[node] = 1
            for target in adjacency[node]:
                if state[target] == 1:
                    return True
                if state[target] == 0 and visit(target):
                    return True
            state[node] = 2
            return False

        if any(state[node] == 0 and visit(node) for node in sorted(known_ids)):
            result.errors.append(f"{label}不能形成环")
            valid = False
        return valid

    @staticmethod
    def _stable_topological_order(
        ids: list[str],
        edges: list[dict[str, Any]],
    ) -> list[str]:
        """Mirror the reader's deterministic topological order with source-order ties."""

        known_ids = set(ids)
        position = {item: index for index, item in enumerate(ids)}
        adjacency: dict[str, list[str]] = {item: [] for item in ids}
        indegree: dict[str, int] = {item: 0 for item in ids}
        for edge in edges:
            source = edge["fromId"]
            target = edge["toId"]
            if source not in known_ids or target not in known_ids:
                continue
            adjacency[source].append(target)
            indegree[target] += 1

        ready = [item for item in ids if indegree[item] == 0]
        ordered: list[str] = []
        while ready:
            ready.sort(key=position.__getitem__)
            current = ready.pop(0)
            ordered.append(current)
            for target in adjacency[current]:
                indegree[target] -= 1
                if indegree[target] == 0:
                    ready.append(target)
        return ordered

    @classmethod
    def _canonical_point_order(
        cls,
        clusters: list[Any],
        indexed_points: list[Any],
        sequences: dict[str, Any],
    ) -> list[str]:
        """Linearise canonical cluster/point sequences exactly as the reader does."""

        cluster_ids: list[str] = []
        seen_cluster_ids: set[str] = set()
        for cluster in clusters:
            cluster_id = cluster.get("id") if isinstance(cluster, dict) else None
            if isinstance(cluster_id, str) and cluster_id not in seen_cluster_ids:
                seen_cluster_ids.add(cluster_id)
                cluster_ids.append(cluster_id)
        cluster_order = cls._stable_topological_order(
            cluster_ids,
            sequences["cluster"],
        )

        points_by_cluster: dict[str, list[str]] = {
            cluster_id: [] for cluster_id in cluster_ids
        }
        source_point_ids: list[str] = []
        seen_point_ids: set[str] = set()
        for point in indexed_points:
            if not isinstance(point, dict):
                continue
            point_id = point.get("id")
            if not isinstance(point_id, str) or point_id in seen_point_ids:
                continue
            seen_point_ids.add(point_id)
            source_point_ids.append(point_id)
            cluster_id = point.get("clusterId")
            if cluster_id in points_by_cluster:
                points_by_cluster[cluster_id].append(point_id)

        ordered: list[str] = []
        point_edges = sequences["point"]
        for cluster_id in cluster_order:
            cluster_point_ids = points_by_cluster[cluster_id]
            cluster_point_set = set(cluster_point_ids)
            cluster_edges = [
                edge
                for edge in point_edges
                if edge["fromId"] in cluster_point_set
                and edge["toId"] in cluster_point_set
            ]
            ordered.extend(
                cls._stable_topological_order(cluster_point_ids, cluster_edges)
            )

        ordered_ids = set(ordered)
        ordered.extend(
            point_id
            for point_id in source_point_ids
            if point_id not in ordered_ids
        )
        return ordered

    def _load_course_objects(self, root: Path, course_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, dict[str, Any]]]:
        directory = self._course_dir(course_id, root=root)
        course = self._read_json(directory / "course.json", root=root)
        index = self._read_json(directory / "index.json", root=root)
        points_dir = directory / "points"
        points: dict[str, dict[str, Any]] = {}
        if points_dir.exists():
            if not points_dir.is_dir() or points_dir.is_symlink():
                raise CourseDataError(f"课程 {course_id}: points 必须是目录")
            for path in sorted(points_dir.glob("*.json"), key=lambda item: item.name):
                if path.is_symlink():
                    raise CourseDataError(f"课程 {course_id}: 不允许符号链接 {path.name}")
                point_id = path.stem
                if not _ID_RE.fullmatch(point_id):
                    raise CourseDataError(f"课程 {course_id}: 非法知识点文件名 {path.name}")
                points[point_id] = self._read_json(path, root=root)
        return course, index, points

    def _validate_animation_package(
        self,
        root: Path,
        course_id: str,
        points: dict[str, dict[str, Any]],
    ) -> ValidationResult:
        """Validate an optional, already-compiled sandbox animation bundle."""

        result = ValidationResult()
        course_directory = self._course_dir(course_id, root=root)
        animation_directory = course_directory / "animations"
        if not animation_directory.exists():
            return result
        if not animation_directory.is_dir() or animation_directory.is_symlink():
            result.errors.append(f"课程 {course_id}: animations 必须是普通目录")
            return result

        found: set[str] = set()
        for candidate in animation_directory.iterdir():
            if candidate.is_symlink() or not candidate.is_file():
                result.errors.append(f"课程 {course_id}: animations 不允许目录或符号链接 {candidate.name}")
                continue
            found.add(candidate.name)
        missing = sorted(_ANIMATION_ASSET_FILES - found)
        unexpected = sorted(found - _ANIMATION_ASSET_FILES)
        if missing:
            result.errors.append(f"课程 {course_id}: 动画包缺少 {', '.join(missing)}")
        if unexpected:
            result.errors.append(f"课程 {course_id}: 动画包包含未授权文件 {', '.join(unexpected)}")
        if missing or unexpected:
            return result

        try:
            manifest = self._read_json(animation_directory / "manifest.json", root=root)
        except CourseDataError as exc:
            result.errors.append(f"课程 {course_id}: 动画清单无效：{exc}")
            return result
        if manifest.get("schema_version") != _ANIMATION_RUNTIME_SCHEMA:
            result.errors.append(
                f"课程 {course_id}: 动画清单 schema_version 必须是 {_ANIMATION_RUNTIME_SCHEMA}"
            )
        if manifest.get("format") != "sandboxed-iframe":
            result.errors.append(f"课程 {course_id}: 动画包只能使用 sandboxed-iframe 格式")

        animations = manifest.get("animations")
        if not isinstance(animations, list) or not animations:
            result.errors.append(f"课程 {course_id}: 动画清单 animations 必须是非空数组")
            animations = []
        known_types: set[str] = set()
        bound_points: dict[str, str] = {}
        for animation in animations:
            if not isinstance(animation, dict):
                result.errors.append(f"课程 {course_id}: 动画清单中存在非对象项")
                continue
            animation_type = animation.get("type")
            component = animation.get("component")
            if not isinstance(animation_type, str) or not _ANIMATION_TYPE_RE.fullmatch(animation_type):
                result.errors.append(f"课程 {course_id}: 非法 animationType {animation_type}")
                continue
            if animation_type in known_types:
                result.errors.append(f"课程 {course_id}: animationType 重复 {animation_type}")
            known_types.add(animation_type)
            if not isinstance(component, str) or not _COMPONENT_RE.fullmatch(component):
                result.errors.append(f"课程 {course_id}: 动画 {animation_type} 的组件名无效")
            bindings = animation.get("bindings")
            if not isinstance(bindings, list) or not bindings:
                result.errors.append(f"课程 {course_id}: 动画 {animation_type} 缺少 bindings")
                continue
            for binding in bindings:
                point_id = binding.get("pointId") if isinstance(binding, dict) else None
                if not isinstance(point_id, str) or not _ID_RE.fullmatch(point_id):
                    result.errors.append(f"课程 {course_id}: 动画 {animation_type} 包含非法 pointId")
                    continue
                if point_id in bound_points:
                    result.errors.append(f"课程 {course_id}: 知识点 {point_id} 被多个动画绑定")
                bound_points[point_id] = animation_type
                point = points.get(point_id)
                if point is None:
                    result.errors.append(f"课程 {course_id}: 动画绑定了不存在的知识点 {point_id}")
                elif point.get("animationType") != animation_type:
                    result.errors.append(
                        f"课程 {course_id}: {point_id}.animationType 与动画清单不一致"
                    )

        for point_id, point in points.items():
            animation_type = point.get("animationType")
            if isinstance(animation_type, str) and animation_type != "none":
                if animation_type not in known_types:
                    result.errors.append(
                        f"课程 {course_id}: 知识点 {point_id} 引用了未发布动画 {animation_type}"
                    )
                elif bound_points.get(point_id) != animation_type:
                    result.errors.append(
                        f"课程 {course_id}: 知识点 {point_id} 缺少动画清单绑定"
                    )

        assets = manifest.get("assets")
        if not isinstance(assets, dict):
            result.errors.append(f"课程 {course_id}: 动画清单缺少 assets 完整性信息")
            assets = {}
        for file_name in ("runtime.js", "runtime.css"):
            metadata = assets.get(file_name)
            if not isinstance(metadata, dict):
                result.errors.append(f"课程 {course_id}: 动画清单缺少 {file_name} 完整性信息")
                continue
            asset_path = animation_directory / file_name
            try:
                value = asset_path.read_bytes()
            except OSError as exc:
                result.errors.append(f"课程 {course_id}: 无法读取动画资产 {file_name}：{exc}")
                continue
            expected_bytes = metadata.get("bytes")
            expected_hash = metadata.get("sha256")
            if (
                not isinstance(expected_bytes, int)
                or isinstance(expected_bytes, bool)
                or expected_bytes != len(value)
            ):
                result.errors.append(f"课程 {course_id}: {file_name} 字节数与清单不一致")
            if (
                not isinstance(expected_hash, str)
                or not _SHA256_RE.fullmatch(expected_hash)
                or hashlib.sha256(value).hexdigest() != expected_hash
            ):
                result.errors.append(f"课程 {course_id}: {file_name} 完整性校验失败")
        return result

    def _course_ids_in(self, root: Path) -> list[str]:
        if not root.exists():
            return []
        identifiers: list[str] = []
        for item in root.iterdir():
            if item.is_symlink():
                raise CourseDataError(f"不允许符号链接：{item.name}")
            if not item.is_dir():
                raise CourseDataError(f"课程根目录只允许课程目录：{item.name}")
            identifiers.append(_safe_id(item.name, "course_id"))
        return sorted(identifiers)

    def _validate_root(self, root: Path, *, strict_details: bool) -> ValidationResult:
        result = ValidationResult()
        try:
            course_ids = self._course_ids_in(root)
        except CourseDataError as exc:
            result.errors.append(str(exc))
            return result
        for course_id in course_ids:
            try:
                course, index, points = self._load_course_objects(root, course_id)
            except CourseDataError as exc:
                result.errors.append(str(exc))
                continue
            child = self._validate_course_objects(
                course_id, course, index, points, strict_details=strict_details
            )
            result.errors.extend(child.errors)
            result.warnings.extend(child.warnings)
            animation_child = self._validate_animation_package(root, course_id, points)
            result.errors.extend(animation_child.errors)
            result.warnings.extend(animation_child.warnings)
        return result

    def validate_course(self, course_id: str, *, strict_details: bool = False) -> ValidationResult:
        with self._lock:
            course, index, points = self._load_course_objects(self.root, course_id)
            result = self._validate_course_objects(
                course_id, course, index, points, strict_details=strict_details
            )
            animation_result = self._validate_animation_package(self.root, course_id, points)
            result.errors.extend(animation_result.errors)
            result.warnings.extend(animation_result.warnings)
            return result

    # ------------------------------------------------------------------
    # Atomic writer helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _allowed_relative_path(relative: Path) -> bool:
        parts = relative.parts
        if len(parts) == 2 and _ID_RE.fullmatch(parts[0]) and parts[1] in {"course.json", "index.json"}:
            return True
        if (
            len(parts) == 3
            and _ID_RE.fullmatch(parts[0]) is not None
            and parts[1] == "animations"
            and parts[2] in _ANIMATION_ASSET_FILES
        ):
            return True
        return (
            len(parts) == 3
            and _ID_RE.fullmatch(parts[0]) is not None
            and parts[1] == "points"
            and parts[2].endswith(".json")
            and _ID_RE.fullmatch(parts[2][:-5]) is not None
        )

    def _tree_bytes(self, root: Path) -> dict[Path, bytes]:
        root = root.resolve()
        if not root.exists():
            return {}
        result: dict[Path, bytes] = {}
        for path in root.rglob("*"):
            if path.is_dir():
                continue
            if path.is_symlink():
                raise CourseDataError(f"不允许符号链接：{path.relative_to(root)}")
            relative = path.relative_to(root)
            if not self._allowed_relative_path(relative):
                raise CourseDataError(f"工作区包含不允许的文件：{relative.as_posix()}")
            if path.stat().st_size > _MAX_JSON_BYTES:
                raise CourseDataError(f"数据文件过大：{relative.as_posix()}")
            result[relative] = path.read_bytes()
        return result

    @staticmethod
    def _fingerprint_from_tree(tree: dict[Path, bytes]) -> str:
        digest = hashlib.sha256()
        for relative in sorted(tree, key=lambda item: item.as_posix()):
            digest.update(relative.as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(tree[relative])
            digest.update(b"\0")
        return digest.hexdigest()

    def _fingerprint(self, root: Path) -> str:
        return self._fingerprint_from_tree(self._tree_bytes(root))

    def _atomic_sync_tree(self, destination: Path, desired: dict[Path, bytes]) -> None:
        """Synchronise permitted package files with rollback on a failed replace.

        Individual filesystem replacements are atomic.  A process-wide lock and
        rollback make a multi-file course update behave transactionally for
        normal failures, while all data is already validated before this method
        is called.
        """

        destination.mkdir(parents=True, exist_ok=True)
        existing = self._tree_bytes(destination)
        changed = sorted(
            (set(existing) | set(desired)), key=lambda item: item.as_posix()
        )
        changed = [path for path in changed if existing.get(path) != desired.get(path)]
        if not changed:
            return

        temporary: dict[Path, Path] = {}
        touched: list[Path] = []
        try:
            for relative in changed:
                content = desired.get(relative)
                if content is None:
                    continue
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
                with temp.open("xb") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                temporary[relative] = temp

            for relative in changed:
                target = destination / relative
                if relative in temporary:
                    os.replace(temporary[relative], target)
                elif target.exists():
                    target.unlink()
                touched.append(relative)
        except Exception as exc:
            # Best-effort rollback restores the previous valid snapshot.  If a
            # filesystem error also prevents rollback, surfacing the original
            # exception is still safer than silently continuing.
            for relative in reversed(touched):
                target = destination / relative
                previous = existing.get(relative)
                try:
                    if previous is None:
                        target.unlink(missing_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        rollback = target.with_name(f".{target.name}.{uuid.uuid4().hex}.rollback")
                        rollback.write_bytes(previous)
                        os.replace(rollback, target)
                except OSError:
                    pass
            raise CourseDataError(f"课程数据原子提交失败：{exc}") from exc
        finally:
            for temp in temporary.values():
                try:
                    temp.unlink(missing_ok=True)
                except OSError:
                    pass

        # Remove directories left behind by a deleted point/course, deepest first.
        for directory in sorted(destination.rglob("*"), key=lambda item: len(item.parts), reverse=True):
            if directory.is_dir() and directory != destination:
                try:
                    directory.rmdir()
                except OSError:
                    pass

    def _write_package(self, course_id: str, course: dict[str, Any], index: dict[str, Any], points: dict[str, dict[str, Any]]) -> None:
        # Start from the full canonical tree.  A CRUD operation on one course
        # must never erase a different course package.
        desired = self._tree_bytes(self.root)
        animation_assets = {
            relative: content
            for relative, content in desired.items()
            if (
                len(relative.parts) == 3
                and relative.parts[0] == course_id
                and relative.parts[1] == "animations"
            )
        }
        for relative in list(desired):
            if relative.parts and relative.parts[0] == course_id:
                del desired[relative]
        desired.update({
            Path(course_id) / "course.json": _json_bytes(course),
            Path(course_id) / "index.json": _json_bytes(index),
        })
        for point_id, point in points.items():
            desired[Path(course_id) / "points" / f"{point_id}.json"] = _json_bytes(point)
        desired.update(animation_assets)
        validation = self._validate_root_from_tree(desired)
        if not validation.ok:
            raise CourseValidationError(validation.errors, validation.warnings)
        self._atomic_sync_tree(self.root, desired)

    # ------------------------------------------------------------------
    # Controlled CRUD API (used by REST and the legacy tool loop)
    # ------------------------------------------------------------------

    def _normalise_cluster(self, cluster: dict[str, Any]) -> dict[str, Any]:
        result = _deepcopy_json(cluster)
        cluster_id = _safe_id(result.get("id"), "cluster.id")
        if not isinstance(result.get("title"), str) or not result["title"].strip():
            raise CourseDataError("cluster.title 不能为空")
        color_index = int(hashlib.sha256(cluster_id.encode("utf-8")).hexdigest(), 16) % len(_DEFAULT_COLORS)
        accent, soft, dark = _DEFAULT_COLORS[color_index]
        result.setdefault("subtitle", "")
        result.setdefault("description", "")
        result.setdefault("accent", accent)
        result.setdefault("soft", soft)
        result.setdefault("dark", dark)
        result.setdefault("polygon", [])
        result.setdefault("labelPos", [2000, 1500])
        return result

    def _normalise_point(self, point: dict[str, Any]) -> dict[str, Any]:
        result = _deepcopy_json(point)
        point_id = _safe_id(result.get("id"), "point.id")
        if not isinstance(result.get("title"), str) or not result["title"].strip():
            raise CourseDataError("point.title 不能为空")
        if not isinstance(result.get("clusterId"), str):
            raise CourseDataError("point.clusterId 不能为空")
        result.setdefault("shortSummary", "")
        result.setdefault("difficulty", "基础")
        result.setdefault("importance", 0.5)
        result.setdefault("keyTerms", [])
        result.setdefault("pos", [0, 0])
        result.setdefault("scale", 1.0)
        if not _is_textbook_content_point(result):
            result.setdefault("coreIdea", "")
            result.setdefault("principles", [])
            result.setdefault("applications", [])
        result.setdefault("prerequisites", [])
        # Explicitly reference the local variable so static type checkers know
        # that the ID validation above is intentional.
        result["id"] = point_id
        return result

    def _validate_candidate_or_raise(
        self,
        course_id: str,
        course: dict[str, Any],
        index: dict[str, Any],
        points: dict[str, dict[str, Any]],
        *,
        strict_point_ids: Iterable[str] = (),
        strict_textbook_content_ids: Iterable[str] = (),
        require_complete_points: bool = False,
        strict_prerequisites: bool = False,
        allowed_legacy_metadata_mismatches: dict[str, set[str]] | None = None,
    ) -> None:
        validation = self._validate_course_objects(
            # Imported source data contains a few historical metadata and
            # prerequisite inconsistencies. They remain warnings for unrelated
            # writes; the point(s) being created or updated are checked below.
            course_id, course, index, points, strict_details=False
        )
        strict_ids = set(strict_point_ids)
        strict_textbook_ids = set(strict_textbook_content_ids)
        strict_ids.update(strict_textbook_ids)
        if strict_ids:
            index_by_id = {
                item.get("id"): item
                for item in index.get("points") or []
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            for point_id in strict_ids:
                detail = points.get(point_id)
                metadata = index_by_id.get(point_id)
                if detail is None or metadata is None:
                    validation.errors.append(f"课程 {course_id}: 缺少待校验知识点 {point_id}")
                    continue
                for field_name in _POINT_META_FIELDS:
                    if detail.get(field_name) != metadata.get(field_name):
                        if field_name in (allowed_legacy_metadata_mismatches or {}).get(point_id, set()):
                            continue
                        validation.errors.append(
                            f"课程 {course_id}: 新修改的知识点 {point_id} 的 {field_name} 未与 index 同步"
                        )
                prerequisites = detail.get("prerequisites")
                if strict_prerequisites or require_complete_points:
                    if not isinstance(prerequisites, list) or any(not isinstance(item, str) for item in prerequisites):
                        validation.errors.append(
                            f"课程 {course_id}: 知识点 {point_id}.prerequisites 必须是字符串数组"
                        )
                    elif len(set(prerequisites)) != len(prerequisites) or point_id in prerequisites:
                        validation.errors.append(
                            f"课程 {course_id}: 知识点 {point_id}.prerequisites 包含重复或自身引用"
                        )
                    else:
                        for prerequisite in prerequisites:
                            if prerequisite not in index_by_id:
                                validation.errors.append(
                                    f"课程 {course_id}: 知识点 {point_id} 的前置引用不存在：{prerequisite}"
                                )
                is_textbook_content = _is_textbook_content_point(detail)
                if point_id in strict_textbook_ids and not is_textbook_content:
                    validation.errors.append(
                        f"课程 {course_id}: 知识点 {point_id} 已使用 {_TEXTBOOK_CONTENT_SCHEMA}，"
                        "修改后不允许降级或移除 v2 content"
                    )
                # Versioned content envelopes were already validated by
                # ``_validate_course_objects`` even in legacy-compatible mode.
                # This branch only supplies the completeness checks that have
                # no declared schema for legacy points.
                if not is_textbook_content and require_complete_points:
                    if not isinstance(detail.get("coreIdea"), str) or not detail["coreIdea"].strip():
                        validation.errors.append(f"课程 {course_id}: 知识点 {point_id} 缺少非空 coreIdea")
                    for content_field in ("principles", "applications"):
                        value = detail.get(content_field)
                        if not isinstance(value, list) or not value or any(
                            not isinstance(item, str) or not item.strip() for item in value
                        ):
                            validation.errors.append(
                                f"课程 {course_id}: 知识点 {point_id}.{content_field} 必须是非空字符串数组"
                            )
        if not validation.ok:
            raise CourseValidationError(validation.errors, validation.warnings)

    def _touch_course(self, course: dict[str, Any]) -> dict[str, Any]:
        course = _deepcopy_json(course)
        course["revision"] = self._revision()
        course["updatedAt"] = self._today()
        return course

    def create_course(self, course: dict[str, Any], index: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            course = _deepcopy_json(course)
            course_id = _safe_id(course.get("id"), "course.id")
            if self._course_dir(course_id, required=False).exists():
                raise CourseDataError(f"课程已存在：{course_id}")
            if not isinstance(course.get("title"), str) or not course["title"].strip():
                raise CourseDataError("course.title 不能为空")
            course.setdefault("schema_version", "1.0")
            course.setdefault("language", "zh-CN")
            course.setdefault("description", "")
            course = self._touch_course(course)
            candidate_index = _deepcopy_json(index) if index is not None else {}
            candidate_index.setdefault("schema_version", "1.0")
            candidate_index["courseId"] = course_id
            candidate_index.setdefault("clusters", [])
            candidate_index.setdefault("points", [])
            self._validate_candidate_or_raise(course_id, course, candidate_index, {})
            self._write_package(course_id, course, candidate_index, {})
            self._sync_catalog_after_course_change()
            return _deepcopy_json(course)

    def create_placeholder_course(self, title: str, group_id: str) -> dict[str, Any]:
        """Create an empty course package and assign it to one catalogue group.

        Placeholder packages intentionally contain no clusters or points. They
        are catalogue/graph presentation nodes only; replacing one with a
        real course remains a delete-and-create operation.
        """

        with self._lock:
            clean_title = title.strip() if isinstance(title, str) else ""
            if not clean_title:
                raise CourseDataError("占位课程名称不能为空")
            if len(clean_title) > 200:
                raise CourseDataError("占位课程名称不能超过 200 个字符")
            _safe_id(group_id, "group_id")
            catalog = self._catalog_for_mutation()
            target = next((item for item in catalog["groups"] if item["id"] == group_id), None)
            if target is None:
                raise CourseNotFoundError(f"学科大类不存在：{group_id}")

            course_id = f"placeholder-{uuid.uuid4().hex[:16]}"
            course = self._touch_course({
                "id": course_id,
                "title": clean_title,
                "description": "",
                "language": "zh-CN",
                "placeholder": True,
                "schema_version": "1.0",
            })
            index = {
                "schema_version": "1.0",
                "courseId": course_id,
                "clusters": [],
                "points": [],
            }
            self._validate_candidate_or_raise(course_id, course, index, {})
            self._write_package(course_id, course, index, {})
            target["course_ids"].append(course_id)
            self._write_catalog(catalog)
            return {"course": _deepcopy_json(course), "group": _deepcopy_json(target)}

    def update_course(self, course_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current, index, points = self._load_course_objects(self.root, course_id)
            patch = _deepcopy_json(patch)
            if "id" in patch and patch["id"] != course_id:
                raise CourseDataError("课程 id 不可修改；请创建新课程后迁移内容")
            current.update(patch)
            current["id"] = course_id
            current = self._touch_course(current)
            self._validate_candidate_or_raise(course_id, current, index, points)
            self._write_package(course_id, current, index, points)
            return _deepcopy_json(current)

    def delete_course(self, course_id: str) -> None:
        with self._lock:
            self._course_dir(course_id)
            current = self._tree_bytes(self.root)
            desired = {
                relative: content
                for relative, content in current.items()
                if relative.parts[0] != course_id
            }
            self._atomic_sync_tree(self.root, desired)
            self._sync_catalog_after_course_change(course_id)

    def create_cluster(self, course_id: str, cluster: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            course, index, points = self._load_course_objects(self.root, course_id)
            cluster = self._normalise_cluster(cluster)
            clusters = list(index.get("clusters") or [])
            if any(item.get("id") == cluster["id"] for item in clusters if isinstance(item, dict)):
                raise CourseDataError(f"知识簇已存在：{cluster['id']}")
            clusters.append(cluster)
            index = _deepcopy_json(index)
            index["clusters"] = clusters
            course = self._touch_course(course)
            self._validate_candidate_or_raise(course_id, course, index, points)
            self._write_package(course_id, course, index, points)
            return _deepcopy_json(cluster)

    def update_cluster(self, course_id: str, cluster_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            cluster_id = _safe_id(cluster_id, "cluster_id")
            course, index, points = self._load_course_objects(self.root, course_id)
            index = _deepcopy_json(index)
            clusters = index.get("clusters") or []
            target = next((item for item in clusters if isinstance(item, dict) and item.get("id") == cluster_id), None)
            if target is None:
                raise CourseNotFoundError(f"知识簇不存在：{cluster_id}")
            if "id" in patch and patch["id"] != cluster_id:
                raise CourseDataError("知识簇 id 不可修改，以免破坏知识点引用")
            target.update(_deepcopy_json(patch))
            target["id"] = cluster_id
            normalised = self._normalise_cluster(target)
            target.clear()
            target.update(normalised)
            course = self._touch_course(course)
            self._validate_candidate_or_raise(course_id, course, index, points)
            self._write_package(course_id, course, index, points)
            return _deepcopy_json(target)

    def delete_cluster(self, course_id: str, cluster_id: str) -> None:
        with self._lock:
            cluster_id = _safe_id(cluster_id, "cluster_id")
            course, index, points = self._load_course_objects(self.root, course_id)
            referring = [
                item.get("id")
                for item in index.get("points") or []
                if isinstance(item, dict) and item.get("clusterId") == cluster_id
            ]
            if referring:
                raise CourseDataError(
                    f"知识簇 {cluster_id} 仍包含 {len(referring)} 个知识点，不能删除"
                )
            clusters = [
                item for item in index.get("clusters") or []
                if not isinstance(item, dict) or item.get("id") != cluster_id
            ]
            if len(clusters) == len(index.get("clusters") or []):
                raise CourseNotFoundError(f"知识簇不存在：{cluster_id}")
            index = _deepcopy_json(index)
            index["clusters"] = clusters
            course = self._touch_course(course)
            self._validate_candidate_or_raise(course_id, course, index, points)
            self._write_package(course_id, course, index, points)

    def create_point(self, course_id: str, point: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            course, index, points = self._load_course_objects(self.root, course_id)
            point = self._normalise_point(point)
            point_id = point["id"]
            if point_id in points:
                raise CourseDataError(f"知识点已存在：{point_id}")
            points = dict(points)
            points[point_id] = point
            index = _deepcopy_json(index)
            index["points"] = list(index.get("points") or []) + [
                {field: _deepcopy_json(point[field]) for field in _POINT_META_FIELDS}
            ]
            course = self._touch_course(course)
            self._validate_candidate_or_raise(
                course_id,
                course,
                index,
                points,
                strict_point_ids={point_id},
                require_complete_points=True,
                strict_prerequisites=True,
            )
            self._write_package(course_id, course, index, points)
            return _deepcopy_json(point)

    def update_point(self, course_id: str, point_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            point_id = _safe_id(point_id, "point_id")
            course, index, points = self._load_course_objects(self.root, course_id)
            current = points.get(point_id)
            if current is None:
                raise CourseNotFoundError(f"知识点不存在：{point_id}")
            was_textbook_content = _is_textbook_content_point(current)
            if "id" in patch and patch["id"] != point_id:
                raise CourseDataError("知识点 id 不可修改，以免破坏前置关系")
            current = _deepcopy_json(current)
            current.update(_deepcopy_json(patch))
            current["id"] = point_id
            current = self._normalise_point(current)
            points = dict(points)
            points[point_id] = current
            index = _deepcopy_json(index)
            for item in index.get("points") or []:
                if isinstance(item, dict) and item.get("id") == point_id:
                    item.update({field: _deepcopy_json(current[field]) for field in _POINT_META_FIELDS})
                    break
            course = self._touch_course(course)
            self._validate_candidate_or_raise(
                course_id,
                course,
                index,
                points,
                strict_point_ids={point_id},
                strict_textbook_content_ids=(
                    {point_id}
                    if was_textbook_content or _is_textbook_content_point(current)
                    else set()
                ),
                strict_prerequisites="prerequisites" in patch,
            )
            self._write_package(course_id, course, index, points)
            return _deepcopy_json(current)

    def delete_point(self, course_id: str, point_id: str) -> None:
        with self._lock:
            point_id = _safe_id(point_id, "point_id")
            course, index, points = self._load_course_objects(self.root, course_id)
            if point_id not in points:
                raise CourseNotFoundError(f"知识点不存在：{point_id}")
            points = dict(points)
            del points[point_id]
            # Keep prerequisite references valid by removing the deleted point
            # from the remaining detail files in the same transaction.
            for detail in points.values():
                prerequisites = detail.get("prerequisites")
                if isinstance(prerequisites, list):
                    detail["prerequisites"] = [item for item in prerequisites if item != point_id]
            index = _deepcopy_json(index)
            index["points"] = [
                item for item in index.get("points") or []
                if not isinstance(item, dict) or item.get("id") != point_id
            ]
            course = self._touch_course(course)
            self._validate_candidate_or_raise(course_id, course, index, points)
            self._write_package(course_id, course, index, points)

    # ------------------------------------------------------------------
    # OpenCode staging workspaces
    # ------------------------------------------------------------------

    def _workspace_session_dir(self, conversation_id: str) -> Path:
        return self._within(
            self.workspace_root,
            self.workspace_root / _safe_conversation_id(conversation_id),
        )

    @staticmethod
    def _state_path(session_dir: Path) -> Path:
        return session_dir / ".course-workspace-state"

    @staticmethod
    def _read_state(path: Path) -> dict[str, Any] | None:
        if not path.is_file():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    @staticmethod
    def _write_state(path: Path, *, base: str, workspace: str) -> None:
        path.write_text(
            json.dumps({"base": base, "workspace": workspace}, ensure_ascii=False),
            encoding="utf-8",
        )

    def _copy_canonical_to_workspace(self, workspace: Path) -> None:
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.parent.mkdir(parents=True, exist_ok=True)
        # copytree handles an empty canonical root as well.
        shutil.copytree(self.root, workspace)

    def prepare_workspace(self, conversation_id: str) -> CourseWorkspace:
        """Return a conflict-aware staged copy for one OpenCode conversation."""

        with self._lock:
            session_dir = self._workspace_session_dir(conversation_id)
            workspace = session_dir / "courses"
            state_path = self._state_path(session_dir)
            current = self._fingerprint(self.root)
            state = self._read_state(state_path)
            if workspace.is_dir() and state:
                workspace_fingerprint = self._fingerprint(workspace)
                if state.get("base") == current:
                    return CourseWorkspace(conversation_id, workspace, current)
                if state.get("workspace") != workspace_fingerprint:
                    raise CourseConflictError(
                        "课程数据已被其他会话更新，当前暂存工作区仍有未提交修改；请先完成或丢弃该会话。"
                    )
            self._copy_canonical_to_workspace(workspace)
            workspace_fingerprint = self._fingerprint(workspace)
            self._write_state(state_path, base=current, workspace=workspace_fingerprint)
            return CourseWorkspace(conversation_id, workspace, current)

    def prepare_readonly_workspace(self, conversation_id: str) -> CourseWorkspace:
        """Create a disposable course snapshot for a read-only Chat turn.

        OpenCode still needs ordinary files so it can search and read course
        content.  Chat sessions therefore receive a private snapshot, but that
        snapshot is never eligible for ``commit_workspace``.  It is refreshed
        before every turn and restored afterwards, so even an unexpected write
        cannot leak into the canonical course catalog or a later Chat turn.
        """

        with self._lock:
            scoped_id = f"chat-{_safe_conversation_id(conversation_id)}"[:80]
            session_dir = self._workspace_session_dir(scoped_id)
            workspace = session_dir / "courses"
            current = self._fingerprint(self.root)
            self._copy_canonical_to_workspace(workspace)
            return CourseWorkspace(scoped_id, workspace, current)

    def restore_readonly_workspace(self, workspace: CourseWorkspace) -> None:
        """Discard all Chat-session file changes and restore its snapshot."""

        with self._lock:
            session_dir = self._workspace_session_dir(workspace.conversation_id)
            expected_path = (session_dir / "courses").resolve()
            if workspace.path.resolve() != expected_path:
                raise CourseDataError("无效的只读课程工作区")
            self._copy_canonical_to_workspace(workspace.path)

    def discard_conversation_workspaces(self, conversation_id: str) -> list[str]:
        """Delete private Agent/Chat workspaces without touching canonical courses."""

        safe_id = _safe_conversation_id(conversation_id)
        scoped_ids = {safe_id, f"chat-{safe_id}"[:80]}
        removed: list[str] = []
        with self._lock:
            for scoped_id in sorted(scoped_ids):
                session_dir = self._workspace_session_dir(scoped_id)
                if not session_dir.exists():
                    continue
                if not session_dir.is_dir() or session_dir.is_symlink():
                    raise CourseDataError("课程会话工作区不是安全目录")
                shutil.rmtree(session_dir)
                removed.append(scoped_id)
        return removed

    def commit_workspace(self, workspace: CourseWorkspace) -> dict[str, Any]:
        """Validate a staged OpenCode tree and atomically promote its changes."""

        with self._lock:
            session_dir = self._workspace_session_dir(workspace.conversation_id)
            expected_path = (session_dir / "courses").resolve()
            if workspace.path.resolve() != expected_path:
                raise CourseDataError("无效的课程暂存工作区")
            if self._fingerprint(self.root) != workspace.base_fingerprint:
                raise CourseConflictError("课程数据已被其他会话更新，请重新开始本次修改")

            # ``strict_details=False`` deliberately accepts the handful of
            # legacy source warnings while still rejecting malformed JSON,
            # dangling files, unsafe paths, and invalid forest metadata.
            validation = self._validate_root(workspace.path, strict_details=False)
            if not validation.ok:
                raise CourseValidationError(validation.errors, validation.warnings)

            changed_validation = self._validate_workspace_changes(workspace.path)
            if not changed_validation.ok:
                raise CourseValidationError(
                    changed_validation.errors,
                    list(dict.fromkeys(validation.warnings + changed_validation.warnings)),
                )
            validation.warnings = list(
                dict.fromkeys(validation.warnings + changed_validation.warnings)
            )

            before = self._tree_bytes(self.root)
            desired = self._tree_bytes(workspace.path)
            changed_before_revision = sorted(
                [
                    path for path in set(before) | set(desired)
                    if before.get(path) != desired.get(path)
                ],
                key=lambda item: item.as_posix(),
            )
            if not changed_before_revision:
                return {
                    "changed_paths": [],
                    "course_ids": [],
                    "revision": self._fingerprint_from_tree(before),
                    "warnings": validation.warnings,
                }

            changed_course_ids = sorted({path.parts[0] for path in changed_before_revision})
            # Revision metadata belongs to every changed course, including a
            # course whose only modification was a point detail file.
            for course_id in changed_course_ids:
                course_path = Path(course_id) / "course.json"
                if course_path not in desired:
                    continue  # deleted course
                try:
                    metadata = json.loads(desired[course_path].decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise CourseDataError(f"课程 {course_id} 的 course.json 无法解析") from exc
                if not isinstance(metadata, dict):
                    raise CourseDataError(f"课程 {course_id} 的 course.json 必须是对象")
                metadata["revision"] = self._revision()
                metadata["updatedAt"] = self._today()
                desired[course_path] = _json_bytes(metadata)

            final_validation = self._validate_root_from_tree(desired)
            if not final_validation.ok:
                raise CourseValidationError(final_validation.errors, final_validation.warnings)

            self._atomic_sync_tree(self.root, desired)
            # Reset the staged copy to exactly what was committed so future
            # turns start from a clean, conflict-free snapshot.
            self._copy_canonical_to_workspace(workspace.path)
            canonical_fingerprint = self._fingerprint(self.root)
            self._write_state(
                self._state_path(session_dir),
                base=canonical_fingerprint,
                workspace=self._fingerprint(workspace.path),
            )
            final_changed_paths = sorted(
                [
                    path for path in set(before) | set(desired)
                    if before.get(path) != desired.get(path)
                ],
                key=lambda item: item.as_posix(),
            )
            return {
                "changed_paths": [path.as_posix() for path in final_changed_paths],
                "course_ids": changed_course_ids,
                "revision": canonical_fingerprint,
                "warnings": final_validation.warnings,
            }

    def _validate_root_from_tree(self, tree: dict[Path, bytes]) -> ValidationResult:
        """Validate serialized candidate bytes without exposing a temp package."""

        root = self.workspace_root / f".validate-{uuid.uuid4().hex}"
        try:
            self._atomic_sync_tree(root, tree)
            return self._validate_root(root, strict_details=False)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def _validate_workspace_changes(self, workspace_root: Path) -> ValidationResult:
        """Apply stricter rules only to points an agent actually changed.

        The imported baseline has a small, known set of old index/detail and
        prerequisite inconsistencies.  Treating those as hard errors would make
        a harmless edit to a course title impossible.  Conversely, allowing a
        newly authored point to introduce the same inconsistencies would defeat
        the purpose of the validation layer.  This comparison preserves the
        baseline while requiring changed/new points to be internally sound.
        """

        result = ValidationResult()
        before_ids = set(self._course_ids_in(self.root))
        after_ids = set(self._course_ids_in(workspace_root))
        for course_id in sorted(after_ids):
            after_course, after_index, after_points = self._load_course_objects(
                workspace_root, course_id
            )
            before_index: dict[str, Any] = {"points": []}
            before_points: dict[str, dict[str, Any]] = {}
            if course_id in before_ids:
                _, before_index, before_points = self._load_course_objects(self.root, course_id)

            before_meta = {
                item.get("id"): item
                for item in before_index.get("points") or []
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            after_meta = {
                item.get("id"): item
                for item in after_index.get("points") or []
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            changed_ids: set[str] = set()
            for point_id in set(before_meta) | set(after_meta):
                if before_meta.get(point_id) != after_meta.get(point_id):
                    changed_ids.add(point_id)
            for point_id in set(before_points) | set(after_points):
                if before_points.get(point_id) != after_points.get(point_id):
                    changed_ids.add(point_id)

            for point_id in sorted(changed_ids & set(after_points)):
                is_new = point_id not in before_points
                was_textbook_content = _is_textbook_content_point(
                    before_points.get(point_id)
                )
                is_textbook_content = _is_textbook_content_point(
                    after_points[point_id]
                )
                prerequisites_changed = (
                    is_new
                    or before_points.get(point_id, {}).get("prerequisites")
                    != after_points[point_id].get("prerequisites")
                )
                legacy_mismatches: set[str] = set()
                if not is_new and point_id in before_meta and point_id in after_meta:
                    for field_name in _POINT_META_FIELDS:
                        # A mismatch is tolerated only when this exact legacy
                        # discrepancy was already present and the agent did not
                        # alter either copy of that field.
                        if (
                            before_points[point_id].get(field_name)
                            != before_meta[point_id].get(field_name)
                            and after_points[point_id].get(field_name)
                            == before_points[point_id].get(field_name)
                            and after_meta[point_id].get(field_name)
                            == before_meta[point_id].get(field_name)
                        ):
                            legacy_mismatches.add(field_name)
                try:
                    self._validate_candidate_or_raise(
                        course_id,
                        after_course,
                        after_index,
                        after_points,
                        strict_point_ids={point_id},
                        strict_textbook_content_ids=(
                            {point_id}
                            if was_textbook_content or is_textbook_content
                            else set()
                        ),
                        require_complete_points=is_new,
                        strict_prerequisites=prerequisites_changed,
                        allowed_legacy_metadata_mismatches={point_id: legacy_mismatches},
                    )
                except CourseValidationError as exc:
                    result.errors.extend(exc.errors)
                    result.warnings.extend(exc.warnings)

            removed_ids = set(before_points) - set(after_points)
            if removed_ids:
                for point_id, detail in after_points.items():
                    prerequisites = detail.get("prerequisites")
                    if isinstance(prerequisites, list):
                        for removed in sorted(removed_ids & set(prerequisites)):
                            result.errors.append(
                                f"课程 {course_id}: 删除知识点 {removed} 前必须从 {point_id}.prerequisites 移除引用"
                            )
        # Avoid repeating the same legacy warning once per changed point.
        result.warnings = list(dict.fromkeys(result.warnings))
        result.errors = list(dict.fromkeys(result.errors))
        return result


_store: CourseStore | None = None
_store_lock = threading.Lock()


def get_course_store() -> CourseStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = CourseStore()
        return _store
