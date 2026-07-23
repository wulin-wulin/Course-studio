#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const COURSE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REVIEW_KINDS = new Map([
  ["knowledge-points", "G2_IDENTITY_REVIEW"],
  ["knowledge-graph", "G6_GRAPH_REVIEW"],
]);
const PIPELINE_CHECKER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../skills/knowledge-pipeline-orchestrator/scripts/check-pipeline.mjs",
);

function fail(message) {
  throw new Error(message);
}

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    fail(`拒绝访问课程创建工作区之外的路径：${target}`);
  }
}

function assertSafePath(root, target, { file = false } = {}) {
  ensureInside(root, target);
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    const isLast = index === segments.length - 1;
    if (stat.isSymbolicLink()) fail(`审核路径不允许符号链接：${current}`);
    if (isLast && file && !stat.isFile()) fail(`审核文件路径不是普通文件：${current}`);
    if (!isLast && !stat.isDirectory()) fail(`审核路径包含非目录项：${current}`);
  }
}

function readJson(root, filePath, label) {
  assertSafePath(root, filePath, { file: true });
  if (!fs.existsSync(filePath)) fail(`缺少${label}：${path.relative(root, filePath)}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label}不是有效 JSON：${error.message}`);
  }
}

function readOptionalJson(root, filePath) {
  assertSafePath(root, filePath, { file: true });
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(root, filePath, value) {
  assertSafePath(root, filePath, { file: true });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertSafePath(root, path.dirname(filePath));
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  ensureInside(root, temporary);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
      fail(`审核文件不允许符号链接：${filePath}`);
    }
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function sha256(value, { stableKeys = false } = {}) {
  const encoded = JSON.stringify(stableKeys ? stable(value) : value);
  return crypto.createHash("sha256").update(encoded, "utf8").digest("hex");
}

function isIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const normalized = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return parsed.toISOString() === normalized;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function identityPayload(points, label) {
  if (!Array.isArray(points) || points.length === 0) fail(`${label}必须包含至少一个知识点`);
  const seen = new Set();
  return points.map((point, index) => {
    const id = point?.id;
    const title = point?.title;
    if (!COURSE_ID_PATTERN.test(id ?? "") || seen.has(id)) {
      fail(`${label}[${index}] 的 id 缺失、非法或重复`);
    }
    if (typeof title !== "string" || !title.trim()) {
      fail(`${label}[${index}] 的 title 必须是非空字符串`);
    }
    seen.add(id);
    return [id, title.trim()];
  });
}

export function prerequisitePayload(points) {
  const pointIds = new Set(points.map((point) => point.id));
  const edges = [];
  for (const point of points) {
    if (!Array.isArray(point.prerequisites)) {
      fail(`知识点 ${point.id} 的 prerequisites 必须是数组`);
    }
    const seen = new Set();
    for (const prerequisiteId of point.prerequisites) {
      if (
        typeof prerequisiteId !== "string"
        || !pointIds.has(prerequisiteId)
        || prerequisiteId === point.id
        || seen.has(prerequisiteId)
      ) {
        fail(`知识点 ${point.id} 包含非法、重复、自引用或悬空的 prerequisite`);
      }
      seen.add(prerequisiteId);
      edges.push([point.id, prerequisiteId]);
    }
  }
  return edges.sort(([leftDependent, leftPrerequisite], [rightDependent, rightPrerequisite]) => (
    compareText(leftDependent, rightDependent)
    || compareText(leftPrerequisite, rightPrerequisite)
  ));
}

function normalizedStringArray(value, label, allowed, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    fail(`${label}必须是${nonEmpty ? "非空" : ""}数组`);
  }
  const seen = new Set();
  return value.map((item) => {
    if (
      typeof item !== "string"
      || !item
      || seen.has(item)
      || (allowed && !allowed.has(item))
    ) {
      fail(`${label}包含非法、重复或悬空值`);
    }
    seen.add(item);
    return item;
  });
}

export function clusterReviewPayload(graph) {
  if (!Array.isArray(graph?.clusters) || graph.clusters.length === 0) {
    fail("graph.clusters 必须是非空对象数组");
  }
  const clusterIds = new Set();
  const clusters = graph.clusters.map((cluster, index) => {
    if (
      !cluster
      || typeof cluster !== "object"
      || !COURSE_ID_PATTERN.test(cluster.id ?? "")
      || clusterIds.has(cluster.id)
      || typeof cluster.title !== "string"
      || !cluster.title.trim()
    ) {
      fail(`graph.clusters[${index}] 定义非法`);
    }
    clusterIds.add(cluster.id);
    return structuredClone(cluster);
  });

  const pointIds = new Set(graph.points.map((point) => point.id));
  const assignments = graph.points.map((point) => {
    const clusterIdsForPoint = normalizedStringArray(
      point.clusterIds,
      `知识点 ${point.id} 的 clusterIds`,
      clusterIds,
      { nonEmpty: true },
    );
    if (!["trunk", "branch", "leaf"].includes(point.role)) {
      fail(`知识点 ${point.id} 的 role 非法`);
    }
    const related = normalizedStringArray(
      point.related,
      `知识点 ${point.id} 的 related`,
      pointIds,
    );
    if (related.includes(point.id)) fail(`知识点 ${point.id} 的 related 不允许自引用`);
    return {
      id: point.id,
      clusterIds: clusterIdsForPoint,
      role: point.role,
      related,
    };
  });
  return { clusters, assignments };
}

function normalizeRefinedAudit(value) {
  if (!Array.isArray(value)) fail("graph.generation.refinedPrerequisiteEdges 必须是数组");
  return value.map((entry, index) => {
    if (
      !entry
      || typeof entry !== "object"
      || new Set(Object.keys(entry)).size !== 4
      || !["op", "from", "to", "reason"].every((key) => key in entry)
    ) {
      fail(`refinedPrerequisiteEdges[${index}] 必须严格包含 op/from/to/reason`);
    }
    return {
      op: String(entry.op ?? "").trim(),
      from: String(entry.from ?? "").trim(),
      to: String(entry.to ?? "").trim(),
      reason: String(entry.reason ?? "").trim(),
    };
  });
}

export function reviewAuditPayload(graph) {
  const generation = graph?.generation;
  if (!generation || typeof generation !== "object") {
    fail("graph.generation 必须是对象");
  }
  if (!Array.isArray(generation.brokenCycleEdges)) {
    fail("graph.generation.brokenCycleEdges 必须是数组");
  }
  return {
    refinedPrerequisiteEdges: normalizeRefinedAudit(generation.refinedPrerequisiteEdges),
    brokenCycleEdges: structuredClone(generation.brokenCycleEdges),
  };
}

export function reviewHashes(kind, points, graph = null) {
  const identitySha256 = sha256(identityPayload(points, `${kind}.points`));
  if (kind === "knowledge-points") return { identitySha256 };
  const clustersSha256 = sha256(clusterReviewPayload(graph), { stableKeys: true });
  const prerequisitesSha256 = sha256(prerequisitePayload(points));
  const reviewAuditSha256 = sha256(reviewAuditPayload(graph), { stableKeys: true });
  return {
    identitySha256,
    clustersSha256,
    prerequisitesSha256,
    reviewAuditSha256,
  };
}

export function approvalMatches(approval, { courseId, kind, gate, hashes }) {
  if (!approval || approval.schema_version !== "course-review-approval/1.0") return false;
  if (
    typeof approval.review_id !== "string"
    || !approval.review_id.trim()
    || approval.course_id !== courseId
    || approval.kind !== kind
    || approval.gate !== gate
    || !isIsoUtc(approval.approved_at)
    || !Number.isInteger(approval.operation_count)
    || approval.operation_count < 0
    || approval.operation_count > 500
    || !Array.isArray(approval.submitted_operations)
    || approval.submitted_operations.length !== approval.operation_count
    || !approval.submitted_operations.every(isRecord)
    || !SHA256_PATTERN.test(approval.identity_sha256 ?? "")
    || approval.identity_sha256 !== hashes.identitySha256
  ) return false;
  if (kind !== "knowledge-graph") return true;
  return [
    ["clusters_sha256", hashes.clustersSha256],
    ["prerequisites_sha256", hashes.prerequisitesSha256],
    ["review_audit_sha256", hashes.reviewAuditSha256],
  ].every(([field, expected]) => (
    SHA256_PATTERN.test(approval[field] ?? "") && approval[field] === expected
  ));
}

function runPipelineCheck(root, args, label) {
  if (!fs.existsSync(PIPELINE_CHECKER) || !fs.lstatSync(PIPELINE_CHECKER).isFile()) {
    fail(`缺少流水线校验器：${PIPELINE_CHECKER}`);
  }
  const result = spawnSync(process.execPath, [PIPELINE_CHECKER, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) fail(`${label}无法启动：${result.error.message}`);

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    const detail = (result.stderr || result.stdout || "校验器未返回 JSON").trim();
    fail(`${label}失败：${detail}`);
  }
  if (result.status !== 0 || report?.ok !== true) {
    const detail = Array.isArray(report?.findings) && report.findings.length > 0
      ? report.findings.map((finding) => finding.message).join("；")
      : (result.stderr || "校验未通过").trim();
    fail(`${label}未通过：${detail}`);
  }
}

function parseArgs(argv) {
  const [kind, courseId, ...extra] = argv.slice(2);
  if (!REVIEW_KINDS.has(kind) || !COURSE_ID_PATTERN.test(courseId ?? "") || extra.length > 0) {
    fail(
      "用法：node .opencode/tools/prepare-course-review.mjs "
      + "knowledge-points|knowledge-graph <course-id>",
    );
  }
  return { kind, courseId, gate: REVIEW_KINDS.get(kind) };
}

function prepare() {
  const { kind, courseId, gate } = parseArgs(process.argv);
  const root = path.resolve(process.cwd());
  const courseRoot = path.join(root, "pipeline", courseId);
  const contentRoot = path.join(courseRoot, "course-content");
  const indexPath = path.join(contentRoot, "src", "data", "index.json");
  const graphPath = path.join(courseRoot, "clustered-graph.json");
  const approvalRoot = path.join(root, ".course-review-approvals", courseId);
  const approvalPath = path.join(approvalRoot, `${kind}.json`);
  const requestPath = path.join(courseRoot, "reviews", `${kind}.request.json`);

  assertSafePath(root, courseRoot);
  runPipelineCheck(
    root,
    kind === "knowledge-points"
      ? [contentRoot, "--phase", "index"]
      : [contentRoot, graphPath, "--phase", "all", "--pre-review", "knowledge-graph"],
    kind === "knowledge-points" ? "G1 知识点索引校验" : "G6 知识图谱预审核校验",
  );

  const graph = kind === "knowledge-graph"
    ? readJson(root, graphPath, "聚类图谱")
    : null;
  const points = kind === "knowledge-points"
    ? readJson(root, indexPath, "课程知识点索引").points
    : graph.points;
  const hashes = reviewHashes(kind, points, graph);

  if (kind === "knowledge-graph") {
    const identityApproval = readOptionalJson(
      root,
      path.join(approvalRoot, "knowledge-points.json"),
    );
    if (!approvalMatches(identityApproval, {
      courseId,
      kind: "knowledge-points",
      gate: REVIEW_KINDS.get("knowledge-points"),
      hashes: { identitySha256: hashes.identitySha256 },
    })) {
      fail("知识点清单尚未审核，或知识点 id/title/顺序已在审核后改变；不能开始知识图谱审核");
    }
  }

  const approval = readOptionalJson(root, approvalPath);
  if (approvalMatches(approval, { courseId, kind, gate, hashes })) {
    process.stdout.write(`${JSON.stringify({
      courseId,
      kind,
      gate,
      status: "approved",
      ...hashes,
    })}\n`);
    return;
  }

  writeJsonAtomic(root, requestPath, {
    schema_version: "course-review-request/1.0",
    course_id: courseId,
    kind,
    gate,
    requested_at: new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify({
    courseId,
    kind,
    gate,
    status: "pending",
    requestFile: path.relative(root, requestPath).split(path.sep).join("/"),
    ...hashes,
  })}\n`);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  try {
    prepare();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
