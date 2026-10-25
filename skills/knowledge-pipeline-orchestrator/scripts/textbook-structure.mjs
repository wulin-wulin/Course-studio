#!/usr/bin/env node

import { createHash } from 'node:crypto';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ORIGINS = new Set(['textbook', 'llm-extension', 'user']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Sort object keys recursively before JSON encoding.  Python's review store
 * uses json.dumps(..., sort_keys=True, ensure_ascii=False, separators=(',', ':'));
 * JSON.stringify on this representation has the same compact UTF-8 payload.
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function text(value) {
  return String(value ?? '').trim();
}

function assertOptionalSourceFields(source, workflow, fields, label) {
  for (const field of fields) {
    if (
      Object.prototype.hasOwnProperty.call(source, field)
      && (
        !Object.prototype.hasOwnProperty.call(workflow, field)
        || !Object.is(workflow[field], source[field])
      )
    ) {
      throw new Error(`教材${label}的 ${field} 已被修改`);
    }
  }
}

/**
 * Compare the immutable parser output with the mutable workflow sidecar.
 *
 * The workflow sidecar may contain additional teaching points, but the
 * parser-owned chapters and points form a frozen prefix in every chapter.
 * Keeping the source points as a prefix makes their numeric ``order`` values
 * stable while still allowing the generator to append controlled extensions.
 * This check deliberately compares identity fields only; content fields such
 * as page notes can evolve independently after the structure has been bound.
 *
 * @returns {{textbookPointCount: number, extensionPointCount: number}}
 */
export function assertTextbookSourceUnchanged(
  sourceOutline,
  workflowOutline,
  { courseId = null } = {},
) {
  if (!isRecord(sourceOutline) || sourceOutline.schema_version !== 'textbook-outline/1.0') {
    throw new Error('教材输入结构必须使用 textbook-outline/1.0');
  }
  if (!isRecord(workflowOutline) || workflowOutline.schema_version !== 'textbook-outline/1.0') {
    throw new Error('教材工作流结构必须使用 textbook-outline/1.0');
  }

  const sourceDocumentId = text(sourceOutline.document_id);
  const workflowDocumentId = text(workflowOutline.document_id);
  if (!sourceDocumentId || sourceDocumentId !== workflowDocumentId) {
    throw new Error('教材输入结构与工作流结构的 document_id 不一致');
  }

  const sourceCourse = sourceOutline.course;
  const workflowCourse = workflowOutline.course;
  if (!isRecord(sourceCourse) || !isRecord(workflowCourse)) {
    throw new Error('教材输入结构与工作流结构缺少 course');
  }
  const sourceCourseId = text(sourceCourse.id);
  const workflowCourseId = text(workflowCourse.id);
  if (
    !sourceCourseId
    || sourceCourseId !== workflowCourseId
    || (courseId !== null && workflowCourseId !== courseId)
  ) {
    throw new Error('教材输入结构与工作流结构的课程 ID 不一致');
  }

  const sourceChapters = sourceOutline.chapters;
  const workflowChapters = workflowOutline.chapters;
  if (!Array.isArray(sourceChapters) || sourceChapters.length === 0) {
    throw new Error('教材输入结构必须包含章节');
  }
  if (!Array.isArray(workflowChapters) || workflowChapters.length === 0) {
    throw new Error('教材工作流结构必须包含章节');
  }
  if (sourceChapters.length !== workflowChapters.length) {
    throw new Error('教材工作流不得新增、删除或重排章节');
  }

  const sourcePointById = new Map();
  let textbookPointCount = 0;
  let extensionPointCount = 0;

  // Index every parser-owned point before walking workflow chapters. This
  // lets the comparison detect a point copied from a later chapter into an
  // earlier one instead of treating it as a brand-new extension.
  for (const [chapterIndex, sourceChapter] of sourceChapters.entries()) {
    if (!isRecord(sourceChapter)) {
      throw new Error(`教材输入结构第 ${chapterIndex + 1} 个章节格式无效`);
    }
    if (sourceChapter.order !== chapterIndex) {
      throw new Error(`教材输入章节 ${chapterIndex + 1} 的 order 不符合固定顺序`);
    }
    const sourcePoints = sourceChapter.points;
    if (!Array.isArray(sourcePoints) || sourcePoints.length === 0) {
      throw new Error(`教材输入章节 ${text(sourceChapter.id)} 必须包含知识点`);
    }
    for (const [pointIndex, sourcePoint] of sourcePoints.entries()) {
      if (!isRecord(sourcePoint)) {
        throw new Error(`教材输入知识点 ${text(sourceChapter.id)}/${pointIndex + 1} 格式无效`);
      }
      const sourcePointId = text(sourcePoint.id);
      const sourcePointTitle = text(sourcePoint.title);
      if (!ID_PATTERN.test(sourcePointId) || !sourcePointTitle) {
        throw new Error(`教材输入知识点 ${text(sourceChapter.id)}/${pointIndex + 1} 缺少合法 id/title`);
      }
      if (sourcePoint.origin !== 'textbook') {
        throw new Error(`教材输入知识点 ${sourcePointId} 的 origin 必须保持 textbook`);
      }
      if (sourcePoint.order !== pointIndex) {
        throw new Error(`教材输入知识点 ${sourcePointId} 的 order 不符合固定顺序`);
      }
      if (sourcePointById.has(sourcePointId)) {
        throw new Error(`教材输入知识点 ID 重复：${sourcePointId}`);
      }
      sourcePointById.set(sourcePointId, {
        chapterIndex,
        chapterId: text(sourceChapter.id),
        title: sourcePointTitle,
        order: sourcePoint.order,
      });
    }
  }

  for (const [chapterIndex, sourceChapter] of sourceChapters.entries()) {
    if (!isRecord(sourceChapter)) {
      throw new Error(`教材输入结构第 ${chapterIndex + 1} 个章节格式无效`);
    }
    const workflowChapter = workflowChapters[chapterIndex];
    if (!isRecord(workflowChapter)) {
      throw new Error(`教材工作流第 ${chapterIndex + 1} 个章节格式无效`);
    }
    const sourceChapterId = text(sourceChapter.id);
    const workflowChapterId = text(workflowChapter.id);
    const sourceChapterTitle = text(sourceChapter.title);
    const workflowChapterTitle = text(workflowChapter.title);
    if (
      sourceChapterId !== workflowChapterId
      || sourceChapterTitle !== workflowChapterTitle
      || sourceChapter.order !== workflowChapter.order
    ) {
      throw new Error(
        `教材章节 ${chapterIndex + 1} 的 ID、顺序或标题已被修改`,
      );
    }
    assertOptionalSourceFields(
      sourceChapter,
      workflowChapter,
      ['number', 'page'],
      `章节 ${sourceChapterId}`,
    );

    const sourcePoints = sourceChapter.points;
    const workflowPoints = workflowChapter.points;
    if (!Array.isArray(sourcePoints) || sourcePoints.length === 0) {
      throw new Error(`教材输入章节 ${sourceChapterId} 必须包含知识点`);
    }
    if (!Array.isArray(workflowPoints) || workflowPoints.length === 0) {
      throw new Error(`教材工作流章节 ${workflowChapterId} 必须包含知识点`);
    }

    let sourceCursor = 0;
    let extensionStarted = false;
    for (const [pointIndex, workflowPoint] of workflowPoints.entries()) {
      if (!isRecord(workflowPoint)) {
        throw new Error(`教材工作流知识点 ${workflowChapterId}/${pointIndex + 1} 格式无效`);
      }
      const pointId = text(workflowPoint.id);
      const pointTitle = text(workflowPoint.title);
      if (!ID_PATTERN.test(pointId) || !pointTitle) {
        throw new Error(`教材工作流知识点 ${workflowChapterId}/${pointIndex + 1} 缺少合法 id/title`);
      }
      const expectedSourcePoint = sourcePoints[sourceCursor];
      if (expectedSourcePoint && pointId === text(expectedSourcePoint.id)) {
        if (extensionStarted) {
          throw new Error(`教材章节 ${workflowChapterId} 的教材知识点顺序已被修改`);
        }
        const expectedTitle = text(expectedSourcePoint.title);
        if (
          pointTitle !== expectedTitle
          || workflowPoint.origin !== 'textbook'
          || workflowPoint.order !== expectedSourcePoint.order
        ) {
          throw new Error(
            `教材知识点 ${pointId} 的 ID、顺序、标题或 origin 已被修改`,
          );
        }
        assertOptionalSourceFields(
          expectedSourcePoint,
          workflowPoint,
          ['number', 'page'],
          `知识点 ${pointId}`,
        );
        sourceCursor += 1;
        textbookPointCount += 1;
        continue;
      }

      if (sourcePointById.has(pointId)) {
        const sourcePoint = sourcePointById.get(pointId);
        if (sourcePoint?.chapterIndex !== chapterIndex) {
          throw new Error(`教材知识点 ${pointId} 被移动到其他章节`);
        }
        throw new Error(`教材知识点 ${pointId} 的顺序、标题或 origin 已被修改`);
      }

      extensionStarted = true;
      if (workflowPoint.origin !== 'llm-extension' && workflowPoint.origin !== 'user') {
        throw new Error(
          `新增知识点 ${pointId} 必须使用受控扩展 origin=llm-extension 或 origin=user`,
        );
      }
      const anchorId = text(workflowPoint.anchor_point_id);
      const anchor = sourcePointById.get(anchorId);
      if (!anchor || anchor.chapterIndex !== chapterIndex) {
        throw new Error(`非教材知识点 ${pointId} 必须锚定在同章教材知识点`);
      }
      if (workflowPoint.origin === 'llm-extension') {
        if (typeof workflowPoint.extension_reason !== 'string' || !workflowPoint.extension_reason.trim()) {
          throw new Error(`扩展知识点 ${pointId} 缺少 extension_reason`);
        }
      }
      extensionPointCount += 1;
    }
    if (sourceCursor !== sourcePoints.length) {
      const missing = text(sourcePoints[sourceCursor]?.id);
      throw new Error(`教材知识点 ${missing || '<unknown>'} 缺失或顺序已被修改`);
    }
  }

  return { textbookPointCount, extensionPointCount };
}

/**
 * Build the exact structural payload hashed by reviews/store.py.
 *
 * The binding service writes an already-normalized sidecar, but normalizing
 * here as well keeps CLI gates compatible with approvals created by the
 * backend when a harmless formatting difference (for example surrounding
 * whitespace) is present.  Content fields on chapters/points are retained;
 * only identity/order/origin fields receive the same canonical defaults as
 * the backend review snapshot.
 */
export function textbookStructurePayload(outline, { courseId = null } = {}) {
  if (!isRecord(outline) || outline.schema_version !== 'textbook-outline/1.0') {
    throw new Error('教材结构必须使用 textbook-outline/1.0');
  }

  const documentId = text(outline.document_id);
  if (!documentId) throw new Error('教材结构缺少 document_id');

  if (!isRecord(outline.course)) {
    throw new Error('教材结构缺少 course');
  }
  const rawCourseId = String(outline.course.id ?? '');
  const resolvedCourseId = text(rawCourseId);
  const courseTitle = text(outline.course.title);
  if (!resolvedCourseId || (courseId !== null && rawCourseId !== courseId)) {
    throw new Error('教材结构 course.id 与审核课程不一致');
  }
  if (!courseTitle) throw new Error('教材结构缺少课程标题');

  if (!Array.isArray(outline.chapters) || outline.chapters.length === 0) {
    throw new Error('教材结构必须包含章节');
  }

  const chapterIds = new Set();
  const pointIds = new Set();
  const chapters = outline.chapters.map((rawChapter, chapterIndex) => {
    if (!isRecord(rawChapter)) {
      throw new Error(`教材章节 ${chapterIndex + 1} 格式无效`);
    }
    const chapterId = text(rawChapter.id);
    const chapterTitle = text(rawChapter.title);
    if (!ID_PATTERN.test(chapterId) || !chapterTitle || chapterIds.has(chapterId)) {
      throw new Error(`教材章节 ${chapterIndex + 1} 缺少合法且唯一的 id/title`);
    }
    if (!Array.isArray(rawChapter.points) || rawChapter.points.length === 0) {
      throw new Error(`教材章节 ${chapterId} 必须包含知识点`);
    }
    chapterIds.add(chapterId);

    const points = rawChapter.points.map((rawPoint, pointIndex) => {
      if (!isRecord(rawPoint)) {
        throw new Error(`教材知识点 ${chapterId}/${pointIndex + 1} 格式无效`);
      }
      const pointId = text(rawPoint.id);
      const pointTitle = text(rawPoint.title);
      if (!ID_PATTERN.test(pointId) || !pointTitle || pointIds.has(pointId)) {
        throw new Error(`教材知识点 ${chapterId}/${pointIndex + 1} 缺少合法且唯一的 id/title`);
      }
      pointIds.add(pointId);
      const point = structuredClone(rawPoint);
      point.id = pointId;
      point.title = pointTitle;
      point.order = pointIndex;
      const origin = text(point.origin) || 'textbook';
      if (!ORIGINS.has(origin)) {
        throw new Error(`教材知识点 ${pointId} 的 origin 无效`);
      }
      point.origin = origin;
      return point;
    });

    const chapter = structuredClone(rawChapter);
    chapter.id = chapterId;
    chapter.title = chapterTitle;
    chapter.order = chapterIndex;
    chapter.points = points;
    return chapter;
  });

  return {
    document_id: documentId,
    course: { id: resolvedCourseId, title: courseTitle },
    chapters,
  };
}

export function textbookStructureSha256(outline, options = {}) {
  const encoded = JSON.stringify(stable(textbookStructurePayload(outline, options)));
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

export { stable };
