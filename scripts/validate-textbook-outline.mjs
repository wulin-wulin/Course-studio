#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import {
  assertTextbookSourceUnchanged,
  textbookStructureSha256,
} from "../skills/knowledge-pipeline-orchestrator/scripts/textbook-structure.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ORIGINS = new Set(["textbook", "llm-extension", "user"]);
const MODES = new Set(["outline", "graph"]);
const MATERIAL_SCHEMA = "textbook-material/1.0";
const MANIFEST_SCHEMA = "course-content-generation/1.0";

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    fail(`拒绝访问工作区之外的路径：${target}`);
  }
}

function assertSafePathChain(root, target) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  ensureInside(absoluteRoot, absoluteTarget);
  let rootStat;
  try {
    rootStat = fs.lstatSync(absoluteRoot);
  } catch (error) {
    fail(`工作区根目录不可读取：${absoluteRoot}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`工作区根目录必须是普通目录：${absoluteRoot}`);
  }

  const relative = path.relative(absoluteRoot, absoluteTarget);
  let current = absoluteRoot;
  for (const [index, segment] of relative.split(path.sep).filter(Boolean).entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      // lstat also finds dangling symlinks; existsSync would miss those.
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fail(`无法读取教材工作区路径：${current}`);
    }
    if (stat.isSymbolicLink()) {
      fail(`教材工作区路径不允许符号链接：${current}`);
    }
    if (index < relative.split(path.sep).filter(Boolean).length - 1 && !stat.isDirectory()) {
      fail(`教材工作区路径祖先不是目录：${current}`);
    }
  }
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readJson(root, filePath, label) {
  assertSafePathChain(root, filePath);
  if (!pathExists(filePath)) fail(`缺少${label}：${path.relative(root, filePath)}`);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}必须是普通文件`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label}不是有效 JSON：${error.message}`);
  }
}

function readUtf8(root, filePath, label) {
  assertSafePathChain(root, filePath);
  if (!pathExists(filePath)) fail(`缺少${label}：${path.relative(root, filePath)}`);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}必须是普通文件`);
  const bytes = fs.readFileSync(filePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`${label}必须是有效 UTF-8 文本`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uniqueStrings(value) {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length;
}

function strings(value) {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.length > 0);
}

function boundPath(root, relativePath, label) {
  if (
    typeof relativePath !== "string"
    || !relativePath.trim()
    || path.isAbsolute(relativePath)
    || relativePath.includes("\\")
  ) {
    fail(`${label}必须是工作区内使用正斜杠的相对路径`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`${label}包含非法路径片段`);
  }
  const target = path.join(root, ...segments);
  assertSafePathChain(root, target);
  return target;
}

function markdownSlice(lines, lineStart, lineEnd) {
  const excerpt = lines.slice(lineStart - 1, lineEnd).join("\n");
  return excerpt + (lineEnd < lines.length ? "\n" : "");
}

function parseArgs(argv) {
  const mode = argv[2] || "outline";
  const courseId = argv[3];
  if (!MODES.has(mode) || !courseId || !ID_PATTERN.test(courseId)) {
    fail("用法：node validate-textbook-outline.mjs outline|graph <course-id>");
  }
  return { mode, courseId };
}

function assertSequentialOrder(items, label) {
  const orders = items.map((item) => item?.order);
  const zeroBased = orders.every((value, index) => value === index);
  const oneBased = orders.every((value, index) => value === index + 1);
  if (!zeroBased && !oneBased) {
    fail(`${label}的 order 必须连续且统一从 0 或 1 开始`);
  }
}

function validateOutline(outline, courseId) {
  if (!isRecord(outline) || outline.schema_version !== "textbook-outline/1.0") {
    fail("教材结构必须使用 textbook-outline/1.0");
  }
  if (typeof outline.document_id !== "string" || !outline.document_id.trim()) {
    fail("教材结构缺少 document_id");
  }
  if (!isRecord(outline.course) || outline.course.id !== courseId) {
    fail("教材结构 course.id 必须与命令参数一致");
  }
  if (typeof outline.course.title !== "string" || !outline.course.title.trim()) {
    fail("教材结构缺少课程标题");
  }
  if (!isRecord(outline.source) || typeof outline.source.sha256 !== "string") {
    fail("教材结构缺少来源和源文件哈希");
  }
  if (!Array.isArray(outline.chapters) || outline.chapters.length === 0) {
    fail("教材结构至少需要一个章节");
  }

  assertSequentialOrder(outline.chapters, "章节");
  const chapterIds = new Set();
  const pointIds = new Set();
  const points = [];
  for (const [chapterIndex, chapter] of outline.chapters.entries()) {
    if (!isRecord(chapter) || !ID_PATTERN.test(chapter.id ?? "")) {
      fail(`第 ${chapterIndex + 1} 个章节 ID 非法`);
    }
    if (chapterIds.has(chapter.id)) fail(`章节 ID 重复：${chapter.id}`);
    chapterIds.add(chapter.id);
    if (typeof chapter.title !== "string" || !chapter.title.trim()) {
      fail(`章节 ${chapter.id} 缺少标题`);
    }
    if (!Array.isArray(chapter.points) || chapter.points.length === 0) {
      fail(`章节 ${chapter.id} 至少需要一个知识点`);
    }
    assertSequentialOrder(chapter.points, `章节 ${chapter.id} 的知识点`);
    const chapterPointOrigins = new Map();
    for (const [pointIndex, point] of chapter.points.entries()) {
      if (!isRecord(point) || !ID_PATTERN.test(point.id ?? "")) {
        fail(`章节 ${chapter.id} 的第 ${pointIndex + 1} 个知识点 ID 非法`);
      }
      if (pointIds.has(point.id)) fail(`知识点 ID 重复：${point.id}`);
      pointIds.add(point.id);
      if (typeof point.title !== "string" || !point.title.trim()) {
        fail(`知识点 ${point.id} 缺少标题`);
      }
      if (!ORIGINS.has(point.origin)) {
        fail(`知识点 ${point.id} 的 origin 必须是 textbook、llm-extension 或 user`);
      }
      if (
        point.page !== undefined
        && point.page !== null
        && (!Number.isInteger(point.page) || point.page < 1)
      ) {
        fail(`知识点 ${point.id} 的 page 必须是正整数`);
      }
      if (point.origin === "llm-extension") {
        if (
          !ID_PATTERN.test(point.anchor_point_id ?? "")
          || chapterPointOrigins.get(point.anchor_point_id) !== "textbook"
        ) {
          fail(`扩展知识点 ${point.id} 必须锚定在同章中已出现的教材知识点`);
        }
        if (typeof point.extension_reason !== "string" || !point.extension_reason.trim()) {
          fail(`扩展知识点 ${point.id} 缺少 extension_reason`);
        }
      }
      points.push({
        id: point.id,
        title: point.title.trim(),
        chapterId: chapter.id,
        origin: point.origin,
        sourceRefs: point.source_refs,
      });
      chapterPointOrigins.set(point.id, point.origin);
    }
  }
  return { chapterIds, points };
}

function validateIndex(root, courseRoot, courseId, outlinePoints) {
  const index = readJson(
    root,
    path.join(courseRoot, "course-content", "src", "data", "index.json"),
    "课程索引",
  );
  if (index.schema_version !== "course-content-index/1.0" || index.courseId !== courseId) {
    fail("课程索引必须是 course-content-index/1.0，且 courseId 一致");
  }
  if (!Array.isArray(index.points) || index.points.length !== outlinePoints.length) {
    fail("课程索引知识点数量与教材结构不一致");
  }
  for (const [position, outlinePoint] of outlinePoints.entries()) {
    const indexPoint = index.points[position];
    if (
      indexPoint?.id !== outlinePoint.id
      || indexPoint?.title?.trim() !== outlinePoint.title
      || (
        Object.prototype.hasOwnProperty.call(indexPoint ?? {}, "origin")
        && indexPoint.origin !== outlinePoint.origin
      )
    ) {
      fail(`课程索引第 ${position + 1} 个知识点与教材结构的顺序、ID 或标题不一致`);
    }
  }
  return index;
}

function validateMaterialBlock(block, index, kind, lines, seenIds) {
  const label = `material.${kind}s[${index}]`;
  if (!isRecord(block) || typeof block.id !== "string" || !block.id) {
    fail(`${label} 缺少有效 id`);
  }
  if (seenIds.has(block.id)) fail(`material block id 重复：${block.id}`);
  seenIds.add(block.id);
  if (block.order !== index) fail(`${label}.order 必须与数组顺序一致`);
  if (
    !Number.isInteger(block.line_start)
    || !Number.isInteger(block.line_end)
    || block.line_start < 1
    || block.line_end < block.line_start
    || block.line_end > lines.length
  ) {
    fail(`${label} 的 line_start/line_end 超出 Markdown 行范围`);
  }
  if (!strings(block.heading_path) || block.heading_path.length === 0) {
    fail(`${label}.heading_path 必须是非空字符串数组`);
  }
  if (!uniqueStrings(block.asset_refs)) {
    fail(`${label}.asset_refs 必须是不重复字符串数组`);
  }
  if (
    block.page !== null
    && block.page !== undefined
    && (!Number.isInteger(block.page) || block.page < 1)
  ) {
    fail(`${label}.page 必须为空或正整数`);
  }
  const expectedSha = sha256(markdownSlice(lines, block.line_start, block.line_end));
  if (!SHA256_PATTERN.test(block.sha256 ?? "") || block.sha256 !== expectedSha) {
    fail(`${label}.sha256 与 full.md 对应行不一致`);
  }
  if (kind === "section") {
    if (
      block.type !== "section"
      || typeof block.title !== "string"
      || !block.title.trim()
      || !Number.isInteger(block.heading_level)
      || block.heading_level < 1
      || block.heading_level > 6
    ) {
      fail(`${label} 缺少有效的 type/title/heading_level`);
    }
  }
  return block;
}

function validateMaterial(root, outline, outlinePoints, binding) {
  const documentId = outline.document_id;
  const expectedMaterialPath = `textbook-input/${documentId}/material.json`;
  const expectedMarkdownPath = `textbook-input/${documentId}/full.md`;
  if (
    binding.input_material_path !== expectedMaterialPath
    || binding.input_markdown_path !== expectedMarkdownPath
  ) {
    fail("Markdown 教材绑定必须指向对应 document_id 下的 material.json 和 full.md");
  }
  const materialPath = boundPath(root, binding.input_material_path, "input_material_path");
  const markdownPath = boundPath(root, binding.input_markdown_path, "input_markdown_path");
  const material = readJson(root, materialPath, "教材正文材料索引");
  const markdown = readUtf8(root, markdownPath, "教材 Markdown 正文");
  if (markdown.includes("\r")) fail("full.md 必须使用规范化的 LF 换行");
  const lines = markdown.split("\n");

  if (material.schema_version !== MATERIAL_SCHEMA) {
    fail(`material.schema_version 必须是 ${MATERIAL_SCHEMA}`);
  }
  if (material.document_id !== documentId) {
    fail("material.document_id 与教材结构不一致");
  }
  if (
    !isRecord(material.source)
    || material.source.format !== "markdown"
    || material.source.sha256 !== outline.source.sha256
  ) {
    fail("material.source 必须声明 markdown，且来源摘要与教材结构一致");
  }
  if (!isRecord(material.markdown) || material.markdown.path !== "full.md") {
    fail("material.markdown.path 必须是 full.md");
  }
  if (
    !SHA256_PATTERN.test(material.markdown.sha256 ?? "")
    || material.markdown.sha256 !== sha256(markdown)
  ) {
    fail("material.markdown.sha256 与 full.md 不一致");
  }
  if (material.markdown.line_count !== lines.length) {
    fail("material.markdown.line_count 与 full.md 不一致");
  }
  if (
    material.markdown.character_count !== undefined
    && material.markdown.character_count !== [...markdown].length
  ) {
    fail("material.markdown.character_count 与 full.md 不一致");
  }
  if (!Array.isArray(material.sections) || material.sections.length === 0) {
    fail("material.sections 至少需要一个正文 section");
  }
  if (!Array.isArray(material.chunks) || material.chunks.length === 0) {
    fail("material.chunks 至少需要一个正文 chunk");
  }

  const seenBlockIds = new Set();
  const sections = material.sections.map((section, index) => (
    validateMaterialBlock(section, index, "section", lines, seenBlockIds)
  ));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const chunks = material.chunks.map((chunk, index) => {
    validateMaterialBlock(chunk, index, "chunk", lines, seenBlockIds);
    const label = `material.chunks[${index}]`;
    if (!uniqueStrings(chunk.section_ids) || chunk.section_ids.length === 0) {
      fail(`${label}.section_ids 至少需要一个有效 section id`);
    }
    const parents = chunk.section_ids.map((id) => sectionById.get(id));
    if (parents.some((section) => !section)) {
      fail(`${label}.section_ids 引用了不存在的 section`);
    }
    if (!parents.some((section) => (
      chunk.line_start >= section.line_start && chunk.line_end <= section.line_end
    ))) {
      fail(`${label} 的行范围不属于其引用的 section`);
    }
    return chunk;
  });
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

  for (const section of sections) {
    const covering = chunks
      .filter((chunk) => chunk.section_ids.includes(section.id))
      .slice()
      .sort((left, right) => left.line_start - right.line_start || left.line_end - right.line_end);
    if (covering.length === 0) fail(`section ${section.id} 没有对应 chunk`);
    let expectedLine = section.line_start;
    for (const chunk of covering) {
      if (chunk.line_start !== expectedLine || chunk.line_end > section.line_end) {
        fail(`section ${section.id} 的 chunks 没有连续覆盖正文行范围`);
      }
      expectedLine = chunk.line_end + 1;
    }
    if (expectedLine !== section.line_end + 1) {
      fail(`section ${section.id} 的 chunks 没有完整覆盖正文行范围`);
    }
  }

  if (!Array.isArray(material.point_sources) || material.point_sources.length === 0) {
    fail("material.point_sources 至少需要一个教材知识点映射");
  }
  const pointSourcesById = new Map();
  for (const [index, pointSource] of material.point_sources.entries()) {
    const label = `material.point_sources[${index}]`;
    if (!isRecord(pointSource) || !ID_PATTERN.test(pointSource.point_id ?? "")) {
      fail(`${label}.point_id 非法`);
    }
    if (pointSourcesById.has(pointSource.point_id)) {
      fail(`material.point_sources.point_id 重复：${pointSource.point_id}`);
    }
    if (
      !uniqueStrings(pointSource.section_ids)
      || pointSource.section_ids.length === 0
      || pointSource.section_ids.some((id) => !sectionById.has(id))
    ) {
      fail(`${label}.section_ids 必须引用真实 section`);
    }
    if (
      !uniqueStrings(pointSource.chunk_ids)
      || pointSource.chunk_ids.length === 0
      || pointSource.chunk_ids.some((id) => !chunkById.has(id))
    ) {
      fail(`${label}.chunk_ids 必须引用真实 chunk`);
    }
    for (const chunkId of pointSource.chunk_ids) {
      const chunk = chunkById.get(chunkId);
      if (!chunk.section_ids.some((id) => pointSource.section_ids.includes(id))) {
        fail(`${label}.chunk_ids 与 section_ids 不属于同一正文区域`);
      }
    }
    pointSourcesById.set(pointSource.point_id, pointSource);
  }

  const textbookPointIds = new Set(
    outlinePoints.filter((point) => point.origin === "textbook").map((point) => point.id),
  );
  for (const pointId of pointSourcesById.keys()) {
    if (!textbookPointIds.has(pointId)) {
      fail(`material.point_sources 引用了非教材知识点：${pointId}`);
    }
  }
  for (const point of outlinePoints.filter((item) => item.origin === "textbook")) {
    const pointSource = pointSourcesById.get(point.id);
    if (!pointSource) fail(`教材知识点 ${point.id} 缺少 material.point_sources 映射`);
    const allowedRefs = new Set([...pointSource.section_ids, ...pointSource.chunk_ids]);
    if (
      !uniqueStrings(point.sourceRefs)
      || point.sourceRefs.length === 0
      || point.sourceRefs.some((id) => !seenBlockIds.has(id))
      || point.sourceRefs.some((id) => !allowedRefs.has(id))
    ) {
      fail(`教材知识点 ${point.id} 的 source_refs 必须全部来自对应 point_sources`);
    }
  }

  return {
    material,
    markdown,
    lines,
    blockById: new Map([
      ...sections.map((section) => [section.id, section]),
      ...chunks.map((chunk) => [chunk.id, chunk]),
    ]),
    pointSourcesById,
  };
}

function validateSourceSpan(span, label, outlinePoint, materialContext, documentId) {
  if (!isRecord(span)) fail(`${label} 必须是对象`);
  if (span.materialId !== documentId) {
    fail(`${label}.materialId 必须等于教材 document_id`);
  }
  if (!uniqueStrings(span.blockIds) || span.blockIds.length === 0) {
    fail(`${label}.blockIds 至少需要一个真实 block id`);
  }
  const blocks = span.blockIds.map((id) => materialContext.blockById.get(id));
  if (blocks.some((block) => !block)) fail(`${label}.blockIds 引用了不存在的 material block`);
  if (
    !Number.isInteger(span.lineStart)
    || !Number.isInteger(span.lineEnd)
    || span.lineStart < 1
    || span.lineEnd < span.lineStart
    || span.lineEnd > materialContext.lines.length
  ) {
    fail(`${label} 的 lineStart/lineEnd 超出 full.md 行范围`);
  }
  const minimumLine = Math.min(...blocks.map((block) => block.line_start));
  const maximumLine = Math.max(...blocks.map((block) => block.line_end));
  if (
    span.lineStart < minimumLine
    || span.lineEnd > maximumLine
    || blocks.some((block) => span.lineEnd < block.line_start || span.lineStart > block.line_end)
  ) {
    fail(`${label} 的行范围与 blockIds 不一致`);
  }
  if (!strings(span.headingPath) || span.headingPath.length === 0) {
    fail(`${label}.headingPath 必须是非空字符串数组`);
  }
  if (!blocks.some((block) => isDeepStrictEqual(block.heading_path, span.headingPath))) {
    fail(`${label}.headingPath 与引用的 material block 不一致`);
  }
  if (!uniqueStrings(span.assetRefs)) {
    fail(`${label}.assetRefs 必须是不重复字符串数组`);
  }
  const knownAssets = new Set(blocks.flatMap((block) => block.asset_refs));
  if (span.assetRefs.some((asset) => !knownAssets.has(asset))) {
    fail(`${label}.assetRefs 包含引用 block 中不存在的资源`);
  }
  if (
    span.page !== undefined
    && (
      !Number.isInteger(span.page)
      || span.page < 1
      || !blocks.some((block) => block.page === span.page)
    )
  ) {
    fail(`${label}.page 与引用的 material block 不一致`);
  }
  const expectedSha = sha256(
    markdownSlice(materialContext.lines, span.lineStart, span.lineEnd),
  );
  if (!SHA256_PATTERN.test(span.excerptSha256 ?? "") || span.excerptSha256 !== expectedSha) {
    fail(`${label}.excerptSha256 与 full.md 对应行不一致`);
  }
  if (outlinePoint.origin === "textbook") {
    const pointSource = materialContext.pointSourcesById.get(outlinePoint.id);
    const allowed = new Set([
      ...(pointSource?.section_ids ?? []),
      ...(pointSource?.chunk_ids ?? []),
    ]);
    if (span.blockIds.some((id) => !allowed.has(id))) {
      fail(`${label}.blockIds 必须全部来自知识点 ${outlinePoint.id} 的 point_sources`);
    }
  }
}

function validateMarkdownManifest(root, courseRoot, outline, outlinePoints, materialContext) {
  const manifest = readJson(
    root,
    path.join(courseRoot, "course-content", "generation", "manifest.json"),
    "教材生成 manifest",
  );
  if (manifest.schema_version !== MANIFEST_SCHEMA) {
    fail(`generation/manifest.json 必须使用 ${MANIFEST_SCHEMA}`);
  }
  if (manifest.subject?.id !== outline.course.id) {
    fail("generation/manifest.json subject.id 与课程不一致");
  }
  if (manifest.generation?.evidenceMode !== "textbook-grounded") {
    fail("Markdown 教材必须使用 evidenceMode=textbook-grounded");
  }
  if (
    manifest.generation?.pointCount !== undefined
    && manifest.generation.pointCount !== outlinePoints.length
  ) {
    fail("generation/manifest.json pointCount 与教材结构不一致");
  }
  if (!Array.isArray(manifest.sources)) fail("generation/manifest.json sources 必须是数组");
  const sourceById = new Map();
  for (const [index, source] of manifest.sources.entries()) {
    if (!isRecord(source) || typeof source.id !== "string" || !source.id) {
      fail(`generation/manifest.json sources[${index}] 缺少 id`);
    }
    if (sourceById.has(source.id)) fail(`manifest source id 重复：${source.id}`);
    sourceById.set(source.id, source);
  }
  if (![...sourceById.values()].some((source) => source.type === "textbook")) {
    fail("textbook-grounded manifest 至少需要一个 type=textbook 的来源");
  }
  if (!Array.isArray(manifest.pointEvidence) || manifest.pointEvidence.length !== outlinePoints.length) {
    fail("generation/manifest.json pointEvidence 必须与教材知识点等长同序");
  }

  const evidenceById = new Map();
  for (const [index, outlinePoint] of outlinePoints.entries()) {
    const evidence = manifest.pointEvidence[index];
    const label = `generation/manifest.json pointEvidence[${index}]`;
    if (
      !isRecord(evidence)
      || evidence.pointId !== outlinePoint.id
      || evidence.title?.trim() !== outlinePoint.title
    ) {
      fail(`${label} 必须与教材知识点 ID、标题和顺序一致`);
    }
    if (evidence.origin !== outlinePoint.origin) {
      fail(`${label}.origin 与教材结构不一致`);
    }
    if (typeof evidence.modelEnriched !== "boolean") {
      fail(`${label}.modelEnriched 必须是布尔值`);
    }
    if (!uniqueStrings(evidence.sourceRefs)) {
      fail(`${label}.sourceRefs 必须是不重复字符串数组`);
    }
    if (evidence.sourceRefs.some((id) => !sourceById.has(id))) {
      fail(`${label}.sourceRefs 引用了不存在的 manifest source`);
    }
    if (!Array.isArray(evidence.sourceSpans)) {
      fail(`${label}.sourceSpans 必须是数组`);
    }
    if (outlinePoint.origin === "textbook") {
      if (evidence.sourceSpans.length === 0) {
        fail(`教材知识点 ${outlinePoint.id} 至少需要一个 sourceSpan`);
      }
      if (!evidence.sourceRefs.some((id) => sourceById.get(id)?.type === "textbook")) {
        fail(`教材知识点 ${outlinePoint.id} 至少需要一个 textbook sourceRef`);
      }
    }
    evidence.sourceSpans.forEach((span, spanIndex) => {
      validateSourceSpan(
        span,
        `${label}.sourceSpans[${spanIndex}]`,
        outlinePoint,
        materialContext,
        outline.document_id,
      );
    });
    evidenceById.set(outlinePoint.id, evidence);
  }
  return { manifest, evidenceById };
}

function validateSequenceCoverage(graph, outline) {
  if (
    !isRecord(graph.sequences)
    || !Array.isArray(graph.sequences.cluster)
    || !Array.isArray(graph.sequences.point)
  ) {
    fail("Markdown 教材图谱必须显式声明 sequences.cluster 和 sequences.point");
  }
  const clusterIds = new Set(outline.chapters.map((chapter) => chapter.id));
  const pointIds = new Set(
    outline.chapters.flatMap((chapter) => chapter.points.map((point) => point.id)),
  );
  function edgeKeys(edges, ids, label) {
    const keys = new Set();
    for (const [index, edge] of edges.entries()) {
      if (
        !isRecord(edge)
        || typeof edge.fromId !== "string"
        || typeof edge.toId !== "string"
        || !ids.has(edge.fromId)
        || !ids.has(edge.toId)
        || edge.fromId === edge.toId
      ) {
        fail(`sequences.${label}[${index}] 不是有效的同类阅读顺序边`);
      }
      const key = `${edge.fromId}\u0000${edge.toId}`;
      if (keys.has(key)) fail(`sequences.${label} 包含重复边`);
      keys.add(key);
    }
    return keys;
  }
  const clusterEdges = edgeKeys(graph.sequences.cluster, clusterIds, "cluster");
  const pointEdges = edgeKeys(graph.sequences.point, pointIds, "point");
  for (let index = 0; index < outline.chapters.length - 1; index += 1) {
    const fromId = outline.chapters[index].id;
    const toId = outline.chapters[index + 1].id;
    if (!clusterEdges.has(`${fromId}\u0000${toId}`)) {
      fail(`sequences.cluster 缺少相邻章节顺序 ${fromId} -> ${toId}`);
    }
  }
  for (const chapter of outline.chapters) {
    for (let index = 0; index < chapter.points.length - 1; index += 1) {
      const fromId = chapter.points[index].id;
      const toId = chapter.points[index + 1].id;
      if (!pointEdges.has(`${fromId}\u0000${toId}`)) {
        fail(`sequences.point 缺少同章相邻知识点顺序 ${fromId} -> ${toId}`);
      }
    }
  }
}

function validateGraph(root, courseRoot, outline, outlinePoints, markdownManifest = null) {
  const graph = readJson(root, path.join(courseRoot, "clustered-graph.json"), "知识图谱");
  if (graph.schema_version !== "clustered-graph/2.0") {
    fail("知识图谱必须使用 clustered-graph/2.0");
  }
  if (!Array.isArray(graph.clusters) || graph.clusters.length !== outline.chapters.length) {
    fail("教材课程必须由章节一一生成知识簇");
  }
  for (const [index, chapter] of outline.chapters.entries()) {
    const cluster = graph.clusters[index];
    if (cluster?.id !== chapter.id || cluster?.title?.trim() !== chapter.title.trim()) {
      fail(`知识簇第 ${index + 1} 项没有保持教材章节 ID、标题和顺序`);
    }
  }
  const byId = new Map((graph.points ?? []).map((point) => [point.id, point]));
  for (const outlinePoint of outlinePoints) {
    const graphPoint = byId.get(outlinePoint.id);
    if (!graphPoint || graphPoint.clusterIds?.[0] !== outlinePoint.chapterId) {
      fail(`知识点 ${outlinePoint.id} 的主知识簇不是教材章节 ${outlinePoint.chapterId}`);
    }
  }
  if ((graph.points ?? []).length !== outlinePoints.length || byId.size !== outlinePoints.length) {
    fail("知识图谱包含教材结构之外的知识点或重复 ID");
  }
  if (markdownManifest) {
    for (const outlinePoint of outlinePoints) {
      const evidence = markdownManifest.evidenceById.get(outlinePoint.id);
      const graphPoint = byId.get(outlinePoint.id);
      const detail = readJson(
        root,
        path.join(courseRoot, "course-content", "src", "data", "points", `${outlinePoint.id}.json`),
        `知识点详情 ${outlinePoint.id}`,
      );
      for (const field of ["origin", "sourceSpans", "modelEnriched"]) {
        if (!isDeepStrictEqual(graphPoint[field], evidence[field])) {
          fail(`图谱知识点 ${outlinePoint.id} 的 ${field} 与 manifest 不一致`);
        }
        if (!isDeepStrictEqual(detail[field], evidence[field])) {
          fail(`知识点详情 ${outlinePoint.id} 的 ${field} 与 manifest 不一致`);
        }
      }
    }
    validateSequenceCoverage(graph, outline);
  }
  return graph;
}

function loadTextbookInput(root, outline) {
  const documentId = String(outline?.document_id ?? "").trim();
  if (!documentId || documentId.includes("/") || documentId.includes("\\") || documentId === "." || documentId === "..") {
    fail("教材结构 document_id 不能用于定位教材输入结构");
  }
  const inputRoot = path.join(root, "textbook-input");
  const inputPath = path.join(inputRoot, documentId, "outline.json");
  const bindingPath = path.join(root, "textbook-binding.json");
  const hasInputRoot = pathExists(inputRoot);
  const hasBinding = pathExists(bindingPath);
  // Hand-authored generic fixtures may contain only the workflow sidecar. A
  // real bound textbook session always has either the immutable input copy or
  // the durable binding record; once either marker exists, missing input is a
  // hard integrity failure rather than a silent fallback to ordinary courses.
  if (!hasInputRoot && !hasBinding) return null;
  const input = readJson(root, inputPath, "教材输入结构");
  let binding = null;
  if (hasBinding) {
    binding = readJson(root, bindingPath, "教材绑定记录");
    if (
      binding.document_id !== documentId
      || binding.output_outline_path !== `pipeline/${outline.course?.id}/textbook-outline.json`
    ) {
      fail("教材绑定记录与工作流结构不一致");
    }
    let sourceHash;
    try {
      sourceHash = textbookStructureSha256(input, { courseId: outline.course?.id });
    } catch (error) {
      fail(`教材输入结构无法计算完整性摘要：${error.message}`);
    }
    if (binding.structure_sha256 !== sourceHash) {
      fail("教材输入结构完整性摘要与绑定记录不一致");
    }
  }
  const hasMaterialPath = Object.prototype.hasOwnProperty.call(
    binding ?? {},
    "input_material_path",
  );
  const hasMarkdownPath = Object.prototype.hasOwnProperty.call(
    binding ?? {},
    "input_markdown_path",
  );
  if (hasMaterialPath !== hasMarkdownPath) {
    fail("Markdown 教材绑定必须同时声明 input_material_path 和 input_markdown_path");
  }
  return {
    input,
    binding,
    markdownMode: hasMaterialPath && hasMarkdownPath,
  };
}

function main() {
  const { mode, courseId } = parseArgs(process.argv);
  const root = path.resolve(process.cwd());
  const courseRoot = path.join(root, "pipeline", courseId);
  ensureInside(root, courseRoot);
  const outline = readJson(root, path.join(courseRoot, "textbook-outline.json"), "教材结构");
  const { points } = validateOutline(outline, courseId);
  const textbookInput = loadTextbookInput(root, outline);
  if (textbookInput) {
    try {
      assertTextbookSourceUnchanged(textbookInput.input, outline, { courseId });
    } catch (error) {
      fail(`教材原始结构不可变校验失败：${error.message}`);
    }
  }
  validateIndex(root, courseRoot, courseId, points);
  let markdownManifest = null;
  if (textbookInput?.markdownMode) {
    const materialContext = validateMaterial(
      root,
      outline,
      points,
      textbookInput.binding,
    );
    markdownManifest = validateMarkdownManifest(
      root,
      courseRoot,
      outline,
      points,
      materialContext,
    );
  }
  if (mode === "graph") {
    validateGraph(root, courseRoot, outline, points, markdownManifest);
  }
  process.stdout.write(`${JSON.stringify({
    courseId,
    mode,
    documentId: outline.document_id,
    chapterCount: outline.chapters.length,
    pointCount: points.length,
    status: "valid",
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
