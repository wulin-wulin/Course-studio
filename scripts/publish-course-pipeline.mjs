#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCourseMapLayout } from "./layout-course-map.mjs";
import { buildCourseAnimationRuntime } from "./bundle-course-animations.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_G7_CHECK_TIMEOUT_MS = 2 * 60 * 1000;
const VALIDATION_RECEIPT_SCHEMA = "course-pipeline-validation-receipt/1.0";
const VALIDATION_RECEIPT_GATE = "G7_RELEASE_READY";
const PALETTE = [
  ["#2F7A65", "#E2F4EC", "#185342"],
  ["#A86132", "#F8E8DA", "#6E381C"],
  ["#9A7A26", "#F8F0D1", "#665014"],
  ["#7B5A91", "#F0E8F5", "#4D3260"],
  ["#397B9D", "#E1F0F6", "#20516B"],
  ["#9B5264", "#F7E5E9", "#65303D"],
  ["#5F823C", "#EAF2DF", "#3D5724"],
  ["#585099", "#EAE8F7", "#373166"],
  ["#A94E3D", "#F8E3DE", "#713025"],
  ["#327D78", "#E0F1EF", "#20534F"],
];

function fail(message) {
  throw new Error(message);
}

function timeoutFromEnvironment(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`环境变量 ${name} 必须是正整数毫秒值，当前值：${raw}`);
  }
  return value;
}

function readJson(filePath, label = "JSON") {
  if (!fs.existsSync(filePath)) fail(`缺少${label}：${path.relative(process.cwd(), filePath)}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`无法读取${label}：${path.relative(process.cwd(), filePath)}\n${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function assertNoSymbolicLinkComponents(target, label) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      fail(`${label}路径不允许符号链接：${current}`);
    }
  }
}

function assertRegularFile(filePath, label) {
  if (!fs.existsSync(filePath)) fail(`缺少${label}：${path.relative(process.cwd(), filePath)}`);
  assertNoSymbolicLinkComponents(filePath, label);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label}必须是普通文件且不允许符号链接：${filePath}`);
  }
  return stat;
}

function fileFingerprint(filePath, label) {
  const stat = assertRegularFile(filePath, label);
  return {
    bytes: stat.size,
    sha256: sha256(fs.readFileSync(filePath)),
  };
}

function treeFingerprint(root, label) {
  if (!fs.existsSync(root)) fail(`缺少${label}：${root}`);
  assertNoSymbolicLinkComponents(root, label);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`${label}必须是普通目录且不允许符号链接：${root}`);
  }

  const entries = [];
  const visit = (directory) => {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      ));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`${label}不允许符号链接：${absolute}`);
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!stat.isFile()) fail(`${label}包含不支持的目录项：${absolute}`);
      entries.push({
        path: slashPath(path.relative(root, absolute)),
        bytes: stat.size,
        sha256: sha256(fs.readFileSync(absolute)),
      });
    }
  };
  visit(root);
  return {
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    sha256: sha256(JSON.stringify(entries)),
  };
}

function validatorFingerprint(root) {
  const components = [
    {
      name: "publisher",
      ...fileFingerprint(fileURLToPath(import.meta.url), "发布工具"),
    },
    ...[
      "candidate-knowledge-point-generator",
      "knowledge-cluster-builder",
      "knowledge-pipeline-orchestrator",
    ].map((name) => ({
      name,
      ...treeFingerprint(
        path.join(root, ".opencode", "skills", name),
        `校验 Skill ${name}`,
      ),
    })),
  ];
  return {
    components,
    sha256: sha256(JSON.stringify(components)),
  };
}

function validationSnapshot({
  root,
  courseId,
  contentRoot,
  graphPath,
}) {
  const approvalRoot = path.join(root, ".course-review-approvals", courseId);
  const content = treeFingerprint(contentRoot, "课程内容包");
  const graph = fileFingerprint(graphPath, "聚类图谱");
  const knowledgePointsApproval = fileFingerprint(
    path.join(approvalRoot, "knowledge-points.json"),
    "G2 知识点审核回执",
  );
  const knowledgeGraphApproval = fileFingerprint(
    path.join(approvalRoot, "knowledge-graph.json"),
    "G6 知识图谱审核回执",
  );
  const validator = validatorFingerprint(root);
  const binding = {
    schema_version: VALIDATION_RECEIPT_SCHEMA,
    gate: VALIDATION_RECEIPT_GATE,
    course_id: courseId,
    content_sha256: content.sha256,
    graph_sha256: graph.sha256,
    knowledge_points_approval_sha256: knowledgePointsApproval.sha256,
    knowledge_graph_approval_sha256: knowledgeGraphApproval.sha256,
    validator_sha256: validator.sha256,
  };
  return {
    ...binding,
    input_sha256: sha256(JSON.stringify(binding)),
    stats: {
      contentFiles: content.files,
      contentBytes: content.bytes,
      validatorFiles: validator.components.reduce(
        (total, component) => total + (component.files ?? 1),
        0,
      ),
    },
  };
}

function readValidationReceipt(receiptPath) {
  if (!fs.existsSync(receiptPath)) return null;
  assertNoSymbolicLinkComponents(receiptPath, "G7 校验凭据");
  if (fs.lstatSync(receiptPath).isSymbolicLink()) {
    fail(`G7 校验凭据不允许符号链接：${receiptPath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertNoSymbolicLinkComponents(path.dirname(filePath), "G7 校验凭据目录");
  const directoryStat = fs.lstatSync(path.dirname(filePath));
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    fail(`G7 校验凭据目录必须是普通目录：${path.dirname(filePath)}`);
  }
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    fail(`G7 校验凭据不允许符号链接：${filePath}`);
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function receiptMatches(receipt, snapshot) {
  if (
    !receipt
    || receipt.schema_version !== VALIDATION_RECEIPT_SCHEMA
    || receipt.gate !== VALIDATION_RECEIPT_GATE
    || receipt.course_id !== snapshot.course_id
    || receipt.input_sha256 !== snapshot.input_sha256
    || receipt.content_sha256 !== snapshot.content_sha256
    || receipt.graph_sha256 !== snapshot.graph_sha256
    || receipt.knowledge_points_approval_sha256
      !== snapshot.knowledge_points_approval_sha256
    || receipt.knowledge_graph_approval_sha256
      !== snapshot.knowledge_graph_approval_sha256
    || receipt.validator_sha256 !== snapshot.validator_sha256
  ) return false;
  return (
    receipt.check?.ok === true
    && receipt.check?.phase === "all"
    && receipt.check?.reviewApprovals === 2
  );
}

function parseArgs(argv) {
  const [courseId, ...options] = argv.slice(2);
  if (!courseId || !ID_PATTERN.test(courseId)) {
    fail(
      "用法：node .opencode/tools/publish-course-pipeline.mjs "
      + "<course-id> [--check]",
    );
  }
  if (options.length > 1 || (options.length === 1 && options[0] !== "--check")) {
    fail(`未知参数：${options.join(" ")}`);
  }
  return { courseId, checkOnly: options[0] === "--check" };
}

function validateGraphBasics(graph, courseId) {
  if (graph?.schema_version !== "clustered-graph/2.0") {
    fail("clustered-graph.json 的 schema_version 必须是 clustered-graph/2.0");
  }
  if (graph.subject?.id !== courseId || graph.generation?.sourceCourseId !== courseId) {
    fail("图谱的 subject.id、generation.sourceCourseId 必须与 course-id 一致");
  }
  if (!Array.isArray(graph.clusters) || graph.clusters.length === 0) {
    fail("clustered-graph.json 必须至少包含一个簇");
  }
  if (!Array.isArray(graph.points) || graph.points.length === 0) {
    fail("clustered-graph.json 必须至少包含一个知识点");
  }

  const clusterIds = new Set();
  for (const cluster of graph.clusters) {
    if (!ID_PATTERN.test(cluster?.id ?? "") || clusterIds.has(cluster.id)) {
      fail(`知识簇 ID 缺失、非法或重复：${cluster?.id ?? "<empty>"}`);
    }
    clusterIds.add(cluster.id);
  }
  const pointIds = new Set();
  for (const point of graph.points) {
    if (!ID_PATTERN.test(point?.id ?? "") || pointIds.has(point.id)) {
      fail(`知识点 ID 缺失、非法或重复：${point?.id ?? "<empty>"}`);
    }
    pointIds.add(point.id);
    if (!Array.isArray(point.clusterIds) || point.clusterIds.length === 0) {
      fail(`知识点 ${point.id} 缺少 clusterIds`);
    }
    for (const clusterId of point.clusterIds) {
      if (!clusterIds.has(clusterId)) fail(`知识点 ${point.id} 引用了不存在的簇 ${clusterId}`);
    }
  }
}

function sentence(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return /[。！？.!?]$/.test(text) ? text : `${text}。`;
}

function buildCourseData(courseId, sourceCourse, manifest, graph) {
  const courseTitle = sourceCourse.title.trim();
  const colorByCluster = new Map(
    graph.clusters.map((cluster, index) => [cluster.id, PALETTE[index % PALETTE.length]]),
  );
  const clusterById = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const kindById = new Map(
    (manifest.pointEvidence ?? []).map((evidence) => [evidence.pointId, evidence.kind]),
  );
  const rolesById = Object.fromEntries(graph.points.map((point) => [point.id, point.role]));

  const clusters = graph.clusters
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((cluster) => {
      const [accent, soft, dark] = colorByCluster.get(cluster.id);
      return {
        ...cluster,
        description: sentence(cluster.description, `${cluster.title}是${courseTitle}课程中的核心知识模块`),
        accent: cluster.accent ?? accent,
        soft: cluster.soft ?? soft,
        dark: cluster.dark ?? dark,
      };
    });

  const points = graph.points.map((point) => ({
    id: point.id,
    title: point.title,
    clusterId: point.clusterIds[0],
    clusterIds: [...point.clusterIds],
    role: point.role,
    related: [...point.related],
    shortSummary: point.shortSummary,
    difficulty: point.difficulty,
    importance: point.importance,
    keyTerms: [...point.keyTerms],
  }));
  const baseIndex = {
    schema_version: "1.0",
    courseId,
    generatedAt: graph.generation.generatedAt,
    clusters,
    points,
  };
  const layout = createCourseMapLayout({
    courseId,
    index: baseIndex,
    rolesById,
    styleName: "organic",
    seed: `${courseId}:course-creator:v2`,
  });
  const indexPointById = new Map(layout.index.points.map((point) => [point.id, point]));

  const details = graph.points.map((point) => {
    const indexPoint = indexPointById.get(point.id);
    const primaryCluster = clusterById.get(point.clusterIds[0]);
    return {
      ...point,
      subtitle: primaryCluster.title,
      clusterId: point.clusterIds[0],
      clusterIds: [...point.clusterIds],
      related: [...point.related],
      kind: kindById.get(point.id),
      pos: indexPoint.pos,
      scale: indexPoint.scale,
    };
  });

  const course = {
    ...sourceCourse,
    schema_version: "1.0",
    subtitle: sentence(graph.subject.scope, `系统掌握${courseTitle}的核心知识与实践方法`),
    accent: clusters[0].accent,
    route: `/courses/${courseId}`,
    revision: sourceCourse.version,
    status: "published",
  };
  return { course, index: layout.index, details };
}

function assertSuccessfulG7Report(report, contentRoot, graphPath) {
  if (
    report?.ok !== true
    || report?.phase !== "all"
    || path.resolve(report?.contentRoot ?? "") !== contentRoot
    || path.resolve(report?.graphFile ?? "") !== graphPath
    || report?.counts?.reviewApprovals !== 2
  ) {
    fail("G7 流水线校验未确认当前课程和两份有效结构化审核回执，不能发布");
  }
}

function runFullG7Check({
  root,
  contentRoot,
  graphPath,
  pipelineChecker,
}) {
  const g7TimeoutMs = timeoutFromEnvironment(
    "COURSE_PIPELINE_G7_TIMEOUT_MS",
    DEFAULT_G7_CHECK_TIMEOUT_MS,
  );
  const checked = spawnSync(
    process.execPath,
    [pipelineChecker, contentRoot, graphPath, "--phase", "all", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: g7TimeoutMs,
      killSignal: "SIGTERM",
    },
  );
  if (checked.error?.code === "ETIMEDOUT") {
    fail(
      `G7 流水线校验超时（${g7TimeoutMs}ms），已终止校验进程；`
        + "请检查校验器或产物规模，必要时通过 COURSE_PIPELINE_G7_TIMEOUT_MS 调整上限",
    );
  }
  if (checked.error) {
    fail(`G7 流水线校验进程启动失败：${checked.error.message}`);
  }
  if (checked.status !== 0) {
    const detail = (checked.stdout || checked.stderr || "未知校验错误").trim();
    fail(`G7 流水线校验未通过，不能发布：\n${detail}`);
  }
  let report;
  try {
    report = JSON.parse(checked.stdout);
  } catch (error) {
    fail(`G7 流水线校验未返回有效 JSON，不能确认审核门禁：${error.message}`);
  }
  assertSuccessfulG7Report(report, contentRoot, graphPath);
  return report;
}

function ensureG7Validation({
  root,
  courseId,
  contentRoot,
  graphPath,
  pipelineChecker,
  receiptPath,
}) {
  const startedAt = Date.now();
  const before = validationSnapshot({
    root,
    courseId,
    contentRoot,
    graphPath,
  });
  const cached = readValidationReceipt(receiptPath);
  if (receiptMatches(cached, before)) {
    return {
      source: "receipt",
      snapshot: before,
      durationMs: Date.now() - startedAt,
    };
  }

  const report = runFullG7Check({
    root,
    contentRoot,
    graphPath,
    pipelineChecker,
  });
  const after = validationSnapshot({
    root,
    courseId,
    contentRoot,
    graphPath,
  });
  if (after.input_sha256 !== before.input_sha256) {
    fail("G7 校验期间课程、图谱、审核回执或校验器发生变化，请重新执行发布前检查");
  }
  writeJsonAtomic(receiptPath, {
    schema_version: VALIDATION_RECEIPT_SCHEMA,
    gate: VALIDATION_RECEIPT_GATE,
    course_id: courseId,
    validated_at: new Date().toISOString(),
    input_sha256: after.input_sha256,
    content_sha256: after.content_sha256,
    graph_sha256: after.graph_sha256,
    knowledge_points_approval_sha256: after.knowledge_points_approval_sha256,
    knowledge_graph_approval_sha256: after.knowledge_graph_approval_sha256,
    validator_sha256: after.validator_sha256,
    check: {
      ok: true,
      phase: report.phase,
      reviewApprovals: report.counts.reviewApprovals,
      errors: report.counts.errors,
      warnings: report.counts.warnings,
    },
    stats: after.stats,
  });
  return {
    source: "fresh",
    snapshot: after,
    durationMs: Date.now() - startedAt,
  };
}

async function publish({ courseId, checkOnly }) {
  const root = path.resolve(process.cwd());
  const pipelineDirectory = path.join(root, "pipeline", courseId);
  const contentRoot = path.join(pipelineDirectory, "course-content");
  const graphPath = path.join(pipelineDirectory, "clustered-graph.json");
  const receiptPath = path.join(
    pipelineDirectory,
    "reviews",
    "g7-release.validation.json",
  );
  const sourceCoursePath = path.join(contentRoot, "src", "data", "course.json");
  const manifestPath = path.join(contentRoot, "generation", "manifest.json");
  const animationManifestPath = path.join(contentRoot, "generation", "animation-manifest.json");
  const coursesDirectory = path.join(root, "courses");
  const targetDirectory = path.join(coursesDirectory, courseId);
  const pipelineChecker = path.join(
    root,
    ".opencode",
    "skills",
    "knowledge-pipeline-orchestrator",
    "scripts",
    "check-pipeline.mjs",
  );

  if (!fs.existsSync(contentRoot) || fs.lstatSync(contentRoot).isSymbolicLink()) {
    fail(`缺少或拒绝使用不安全的内容包：pipeline/${courseId}/course-content`);
  }
  if (!fs.existsSync(graphPath)) fail(`缺少中间产物：pipeline/${courseId}/clustered-graph.json`);
  if (!fs.existsSync(pipelineChecker)) fail("缺少 G7 流水线校验工具，不能发布");
  if (fs.existsSync(targetDirectory)) fail(`课程 ${courseId} 已存在；发布工具不会覆盖已有课程`);

  const validation = ensureG7Validation({
    root,
    courseId,
    contentRoot,
    graphPath,
    pipelineChecker,
    receiptPath,
  });
  if (checkOnly) {
    process.stdout.write(`${JSON.stringify({
      action: "release-check",
      courseId,
      gate: VALIDATION_RECEIPT_GATE,
      status: "ready",
      validationSource: validation.source,
      validationMs: validation.durationMs,
      inputSha256: validation.snapshot.input_sha256,
      receipt: slashPath(path.relative(root, receiptPath)),
    })}\n`);
    return;
  }

  const sourceCourse = readJson(sourceCoursePath, "课程元数据");
  const manifest = readJson(manifestPath, "生成清单");
  const animationManifest = readJson(animationManifestPath, "动画清单");
  const graph = readJson(graphPath, "聚类图谱");
  validateGraphBasics(graph, courseId);
  if (sourceCourse.id !== courseId || manifest.subject?.id !== courseId) {
    fail("course.json、generation/manifest.json 与 course-id 不一致");
  }

  const animations = Array.isArray(animationManifest.animations) ? animationManifest.animations : null;
  if (animations === null) fail("动画清单格式无效");

  const { course, index, details } = buildCourseData(courseId, sourceCourse, manifest, graph);
  fs.mkdirSync(coursesDirectory, { recursive: true });
  const temporaryDirectory = path.join(coursesDirectory, `.publishing-${courseId}-${process.pid}`);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  try {
    writeJson(path.join(temporaryDirectory, "course.json"), course);
    writeJson(path.join(temporaryDirectory, "index.json"), index);
    for (const detail of details) {
      writeJson(path.join(temporaryDirectory, "points", `${detail.id}.json`), detail);
    }
    if (animations.length > 0) {
      await buildCourseAnimationRuntime({
        contentRoot,
        outputDirectory: path.join(temporaryDirectory, "animations"),
        animationManifest,
        projectRootHint: process.env.COURSE_STUDIO_PROJECT_ROOT,
      });
    }
    const beforePromotion = validationSnapshot({
      root,
      courseId,
      contentRoot,
      graphPath,
    });
    if (beforePromotion.input_sha256 !== validation.snapshot.input_sha256) {
      fail("生产构建期间课程、图谱、审核回执或校验器发生变化，已取消原子发布");
    }
    fs.renameSync(temporaryDirectory, targetDirectory);
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  process.stdout.write(`${JSON.stringify({
    courseId,
    clusters: index.clusters.length,
    points: index.points.length,
    animations: animations.length,
    output: `courses/${courseId}`,
    validationSource: validation.source,
    validationMs: validation.durationMs,
  })}\n`);
}

try {
  await publish(parseArgs(process.argv));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
