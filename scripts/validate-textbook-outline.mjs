#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  assertTextbookSourceUnchanged,
  textbookStructureSha256,
} from "../skills/knowledge-pipeline-orchestrator/scripts/textbook-structure.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ORIGINS = new Set(["textbook", "llm-extension", "user"]);
const MODES = new Set(["outline", "graph"]);

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
    fail("教材结构缺少来源和 PDF 哈希");
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

function validateGraph(root, courseRoot, outline, outlinePoints) {
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
  if (byId.size !== outlinePoints.length) fail("知识图谱包含教材结构之外的知识点");
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
  if (hasBinding) {
    const binding = readJson(root, bindingPath, "教材绑定记录");
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
  return input;
}

function main() {
  const { mode, courseId } = parseArgs(process.argv);
  const root = path.resolve(process.cwd());
  const courseRoot = path.join(root, "pipeline", courseId);
  ensureInside(root, courseRoot);
  const outline = readJson(root, path.join(courseRoot, "textbook-outline.json"), "教材结构");
  const { points } = validateOutline(outline, courseId);
  const inputOutline = loadTextbookInput(root, outline);
  if (inputOutline) {
    try {
      assertTextbookSourceUnchanged(inputOutline, outline, { courseId });
    } catch (error) {
      fail(`教材原始结构不可变校验失败：${error.message}`);
    }
  }
  validateIndex(root, courseRoot, courseId, points);
  if (mode === "graph") validateGraph(root, courseRoot, outline, points);
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
