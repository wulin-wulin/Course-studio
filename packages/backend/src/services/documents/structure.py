"""Integrity checks for the immutable textbook structure and workflow sidecar."""

from __future__ import annotations

from typing import Any


class TextbookStructureIntegrityError(ValueError):
    """The workflow sidecar no longer preserves parser-owned structure."""


def _text(value: Any) -> str:
    return str(value or "").strip()


def _require_record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TextbookStructureIntegrityError(f"{label}格式无效")
    return value


def _assert_optional_source_fields(
    source: dict[str, Any],
    workflow: dict[str, Any],
    fields: tuple[str, ...],
    label: str,
) -> None:
    for field in fields:
        if field in source and (field not in workflow or workflow[field] != source[field]):
            raise TextbookStructureIntegrityError(
                f"教材{label}的 {field} 已被修改"
            )


def assert_textbook_source_unchanged(
    source_outline: dict[str, Any],
    workflow_outline: dict[str, Any],
    *,
    course_id: str | None = None,
) -> dict[str, int]:
    """Ensure parser-owned chapters/points are an unchanged prefix.

    ``source_outline`` is the backend-owned copy under
    ``textbook-input/<document-id>/outline.json``.  The workflow sidecar may
    append controlled points to a chapter, but it cannot edit, move, reorder,
    rename, or re-origin any parser-owned point.  Numeric order fields on the
    original points are checked as well; extensions therefore append after the
    source list in each chapter.
    """

    source = _require_record(source_outline, "教材输入结构")
    workflow = _require_record(workflow_outline, "教材工作流结构")
    if source.get("schema_version") != "textbook-outline/1.0":
        raise TextbookStructureIntegrityError(
            "教材输入结构必须使用 textbook-outline/1.0"
        )
    if workflow.get("schema_version") != "textbook-outline/1.0":
        raise TextbookStructureIntegrityError(
            "教材工作流结构必须使用 textbook-outline/1.0"
        )

    source_document_id = _text(source.get("document_id"))
    workflow_document_id = _text(workflow.get("document_id"))
    if not source_document_id or source_document_id != workflow_document_id:
        raise TextbookStructureIntegrityError(
            "教材输入结构与工作流结构的 document_id 不一致"
        )

    source_course = _require_record(source.get("course"), "教材输入结构 course")
    workflow_course = _require_record(workflow.get("course"), "教材工作流结构 course")
    source_course_id = _text(source_course.get("id"))
    workflow_course_id = _text(workflow_course.get("id"))
    if (
        not source_course_id
        or source_course_id != workflow_course_id
        or (course_id is not None and workflow_course_id != course_id)
    ):
        raise TextbookStructureIntegrityError(
            "教材输入结构与工作流结构的课程 ID 不一致"
        )

    source_chapters = source.get("chapters")
    workflow_chapters = workflow.get("chapters")
    if not isinstance(source_chapters, list) or not source_chapters:
        raise TextbookStructureIntegrityError("教材输入结构必须包含章节")
    if not isinstance(workflow_chapters, list) or not workflow_chapters:
        raise TextbookStructureIntegrityError("教材工作流结构必须包含章节")
    if len(source_chapters) != len(workflow_chapters):
        raise TextbookStructureIntegrityError("教材工作流不得新增、删除或重排章节")

    source_points_by_id: dict[str, tuple[int, str, int]] = {}
    for chapter_index, raw_chapter in enumerate(source_chapters):
        chapter = _require_record(raw_chapter, f"教材输入章节 {chapter_index + 1}")
        if chapter.get("order") != chapter_index:
            raise TextbookStructureIntegrityError(
                f"教材输入章节 {chapter_index + 1} 的 order 不符合固定顺序"
            )
        chapter_id = _text(chapter.get("id"))
        chapter_points = chapter.get("points")
        if not isinstance(chapter_points, list) or not chapter_points:
            raise TextbookStructureIntegrityError(
                f"教材输入章节 {chapter_id} 必须包含知识点"
            )
        for point_index, raw_point in enumerate(chapter_points):
            point = _require_record(
                raw_point,
                f"教材输入知识点 {chapter_id}/{point_index + 1}",
            )
            point_id = _text(point.get("id"))
            title = _text(point.get("title"))
            if not point_id or not title:
                raise TextbookStructureIntegrityError(
                    f"教材输入知识点 {chapter_id}/{point_index + 1} 缺少 id/title"
                )
            if point.get("origin") != "textbook":
                raise TextbookStructureIntegrityError(
                    f"教材输入知识点 {point_id} 的 origin 必须保持 textbook"
                )
            if point.get("order") != point_index:
                raise TextbookStructureIntegrityError(
                    f"教材输入知识点 {point_id} 的 order 不符合固定顺序"
                )
            if point_id in source_points_by_id:
                raise TextbookStructureIntegrityError(
                    f"教材输入知识点 ID 重复：{point_id}"
                )
            source_points_by_id[point_id] = (chapter_index, title, point["order"])

    textbook_point_count = 0
    extension_point_count = 0
    for chapter_index, (raw_source_chapter, raw_workflow_chapter) in enumerate(
        zip(source_chapters, workflow_chapters, strict=True)
    ):
        source_chapter = _require_record(
            raw_source_chapter, f"教材输入章节 {chapter_index + 1}"
        )
        workflow_chapter = _require_record(
            raw_workflow_chapter, f"教材工作流章节 {chapter_index + 1}"
        )
        source_chapter_id = _text(source_chapter.get("id"))
        if (
            source_chapter_id != _text(workflow_chapter.get("id"))
            or _text(source_chapter.get("title"))
            != _text(workflow_chapter.get("title"))
            or source_chapter.get("order") != workflow_chapter.get("order")
        ):
            raise TextbookStructureIntegrityError(
                f"教材章节 {chapter_index + 1} 的 ID、顺序或标题已被修改"
            )
        _assert_optional_source_fields(
            source_chapter,
            workflow_chapter,
            ("number", "page"),
            f"章节 {source_chapter_id}",
        )

        source_points = source_chapter["points"]
        workflow_points = workflow_chapter.get("points")
        if not isinstance(workflow_points, list) or not workflow_points:
            raise TextbookStructureIntegrityError(
                f"教材工作流章节 {source_chapter_id} 必须包含知识点"
            )

        source_cursor = 0
        extension_started = False
        for point_index, raw_workflow_point in enumerate(workflow_points):
            point = _require_record(
                raw_workflow_point,
                f"教材工作流知识点 {source_chapter_id}/{point_index + 1}",
            )
            point_id = _text(point.get("id"))
            title = _text(point.get("title"))
            if not point_id or not title:
                raise TextbookStructureIntegrityError(
                    f"教材工作流知识点 {source_chapter_id}/{point_index + 1} 缺少 id/title"
                )
            expected_source = source_points[source_cursor] if source_cursor < len(source_points) else None
            expected_id = _text(expected_source.get("id")) if isinstance(expected_source, dict) else ""
            if expected_source is not None and point_id == expected_id:
                if extension_started:
                    raise TextbookStructureIntegrityError(
                        f"教材章节 {source_chapter_id} 的教材知识点顺序已被修改"
                    )
                source_chapter_index, expected_title, expected_order = source_points_by_id[point_id]
                if (
                    source_chapter_index != chapter_index
                    or title != expected_title
                    or point.get("origin") != "textbook"
                    or point.get("order") != expected_order
                ):
                    raise TextbookStructureIntegrityError(
                        f"教材知识点 {point_id} 的 ID、顺序、标题或 origin 已被修改"
                    )
                _assert_optional_source_fields(
                    expected_source,
                    point,
                    ("number", "page"),
                    f"知识点 {point_id}",
                )
                source_cursor += 1
                textbook_point_count += 1
                continue

            if point_id in source_points_by_id:
                source_chapter_index, _, _ = source_points_by_id[point_id]
                if source_chapter_index != chapter_index:
                    raise TextbookStructureIntegrityError(
                        f"教材知识点 {point_id} 被移动到其他章节"
                    )
                raise TextbookStructureIntegrityError(
                    f"教材知识点 {point_id} 的顺序、标题或 origin 已被修改"
                )

            extension_started = True
            origin = _text(point.get("origin"))
            if origin not in {"llm-extension", "user"}:
                raise TextbookStructureIntegrityError(
                    f"新增知识点 {point_id} 必须使用受控扩展 origin=llm-extension 或 origin=user"
                )
            if origin == "llm-extension":
                anchor_id = _text(point.get("anchor_point_id"))
                anchor = source_points_by_id.get(anchor_id)
                if anchor is None or anchor[0] != chapter_index:
                    raise TextbookStructureIntegrityError(
                        f"扩展知识点 {point_id} 必须锚定在同章教材知识点"
                    )
                if not _text(point.get("extension_reason")):
                    raise TextbookStructureIntegrityError(
                        f"扩展知识点 {point_id} 缺少 extension_reason"
                    )
            extension_point_count += 1

        if source_cursor != len(source_points):
            missing_id = _text(source_points[source_cursor].get("id"))
            raise TextbookStructureIntegrityError(
                f"教材知识点 {missing_id or '<unknown>'} 缺失或顺序已被修改"
            )

    return {
        "textbook_point_count": textbook_point_count,
        "extension_point_count": extension_point_count,
    }
