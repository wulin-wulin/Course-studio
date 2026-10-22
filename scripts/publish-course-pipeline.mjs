#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCourseMapLayout } from "./layout-course-map.mjs";
import { buildCourseAnimationRuntime } from "./bundle-course-animations.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEGACY_GRAPH_SCHEMA = "clustered-graph/2.0";
const THIN_GRAPH_SCHEMA = "clustered-graph/3.0";
const TEXTBOOK_CONTENT_SCHEMA = "textbook-content/2.0";
const DEFAULT_G7_CHECK_TIMEOUT_MS = 2 * 60 * 1000;
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function parseArgs(argv) {
  const courseId = argv[2];
  if (!courseId || !ID_PATTERN.test(courseId)) {
    fail("用法：node .opencode/tools/publish-course-pipeline.mjs <course-id>");
  }
  if (argv.length > 3) fail(`未知参数：${argv.slice(3).join(" ")}`);
  return courseId;
}

function validateGraphBasics(graph, courseId) {
  if (![LEGACY_GRAPH_SCHEMA, THIN_GRAPH_SCHEMA].includes(graph?.schema_version)) {
    fail(
      `clustered-graph.json 的 schema_version 必须是 ${LEGACY_GRAPH_SCHEMA} 或 ${THIN_GRAPH_SCHEMA}`,
    );
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

export function loadCanonicalPoints(contentRoot, graph) {
  const index = readJson(
    path.join(contentRoot, "src", "data", "index.json"),
    "课程知识点索引",
  );
  if (!Array.isArray(index.points)) fail("课程知识点索引 points 必须是数组");
  const indexIds = index.points.map((point) => point?.id);
  const graphIds = graph.points.map((point) => point?.id);
  if (JSON.stringify(indexIds) !== JSON.stringify(graphIds)) {
    fail("clustered-graph.json 必须与 canonical index 保持相同知识点和顺序");
  }
  return indexIds.map((id) => {
    const point = readJson(
      path.join(contentRoot, "src", "data", "points", `${id}.json`),
      `canonical 知识点 ${id}`,
    );
    if (!isRecord(point) || point.id !== id) {
      fail(`canonical 知识点 ${id}.json 的 id 与 index 不一致`);
    }
    return point;
  });
}

export function deriveCompatibilityMetadata(point) {
  if (
    point?.content?.schema_version !== TEXTBOOK_CONTENT_SCHEMA
    || !Array.isArray(point.content.blocks)
  ) {
    return {};
  }
  const sourceSpans = [];
  const seen = new Set();
  let modelEnriched = false;
  for (const block of point.content.blocks) {
    const provenance = isRecord(block?.provenance) ? block.provenance : {};
    if (provenance.origin === "model") modelEnriched = true;
    for (const span of Array.isArray(provenance.sourceSpans)
      ? provenance.sourceSpans
      : []) {
      const key = JSON.stringify(stable(span));
      if (seen.has(key)) continue;
      seen.add(key);
      sourceSpans.push(structuredClone(span));
    }
  }
  return { sourceSpans, modelEnriched };
}

function sentence(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return /[。！？.!?]$/.test(text) ? text : `${text}。`;
}

function normalizedSequences(graph) {
  const value = graph.sequences ?? { cluster: [], point: [] };
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !Array.isArray(value.cluster)
    || !Array.isArray(value.point)
  ) {
    fail("clustered-graph.json 的 sequences 必须包含 cluster/point 数组");
  }
  return {
    cluster: value.cluster.map((edge) => ({ fromId: edge.fromId, toId: edge.toId })),
    point: value.point.map((edge) => ({ fromId: edge.fromId, toId: edge.toId })),
  };
}

export function buildCourseData(
  courseId,
  sourceCourse,
  manifest,
  graph,
  canonicalPoints = graph.points,
) {
  const courseTitle = sourceCourse.title.trim();
  const colorByCluster = new Map(
    graph.clusters.map((cluster, index) => [cluster.id, PALETTE[index % PALETTE.length]]),
  );
  const clusterById = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const kindById = new Map(
    (manifest.pointEvidence ?? []).map((evidence) => [evidence.pointId, evidence.kind]),
  );
  const evidenceById = new Map(
    (manifest.pointEvidence ?? []).map((evidence) => [evidence.pointId, evidence]),
  );
  const canonicalById = new Map(canonicalPoints.map((point) => [point.id, point]));
  const usesThinGraph = graph.schema_version === THIN_GRAPH_SCHEMA;
  if (usesThinGraph && manifest.generation?.contentContract !== TEXTBOOK_CONTENT_SCHEMA) {
    fail(`${THIN_GRAPH_SCHEMA} 只允许发布 ${TEXTBOOK_CONTENT_SCHEMA} 内容包`);
  }
  for (const relationPoint of graph.points) {
    const canonical = canonicalById.get(relationPoint.id);
    if (!canonical) fail(`图谱知识点 ${relationPoint.id} 缺少 canonical point 文件`);
    if (
      usesThinGraph
      && (
        canonical.title !== relationPoint.title
        || canonical.origin !== relationPoint.origin
      )
    ) {
      fail(`图谱知识点 ${relationPoint.id} 的 title/origin 与 canonical point 不一致`);
    }
  }
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

  const points = graph.points.map((point) => {
    const canonical = usesThinGraph ? canonicalById.get(point.id) : point;
    return {
    id: point.id,
    title: point.title,
    clusterId: point.clusterIds[0],
    clusterIds: [...point.clusterIds],
    role: point.role,
    related: [...point.related],
    shortSummary: canonical.shortSummary,
    difficulty: canonical.difficulty,
    importance: canonical.importance,
    keyTerms: [...canonical.keyTerms],
    ...(point.origin ? { origin: point.origin } : {}),
    };
  });
  const baseIndex = {
    schema_version: "1.0",
    courseId,
    generatedAt: graph.generation.generatedAt,
    clusters,
    points,
    sequences: normalizedSequences(graph),
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
    const canonical = usesThinGraph ? canonicalById.get(point.id) : point;
    const indexPoint = indexPointById.get(point.id);
    const primaryCluster = clusterById.get(point.clusterIds[0]);
    const evidence = evidenceById.get(point.id);
    const compatibility = usesThinGraph
      ? deriveCompatibilityMetadata(canonical)
      : {};
    return {
      ...canonical,
      subtitle: primaryCluster.title,
      clusterId: point.clusterIds[0],
      clusterIds: [...point.clusterIds],
      role: point.role,
      prerequisites: [...point.prerequisites],
      related: [...point.related],
      kind: kindById.get(point.id),
      ...(point.origin || evidence?.origin
        ? { origin: point.origin ?? evidence.origin }
        : {}),
      ...(usesThinGraph
        ? compatibility
        : point.sourceSpans || evidence?.sourceSpans
        ? { sourceSpans: point.sourceSpans ?? evidence.sourceSpans }
        : {}),
      ...(!usesThinGraph && typeof (point.modelEnriched ?? evidence?.modelEnriched) === "boolean"
        ? { modelEnriched: point.modelEnriched ?? evidence.modelEnriched }
        : {}),
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

export async function publish(courseId) {
  const root = path.resolve(process.cwd());
  const pipelineDirectory = path.join(root, "pipeline", courseId);
  const contentRoot = path.join(pipelineDirectory, "course-content");
  const graphPath = path.join(pipelineDirectory, "clustered-graph.json");
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
  let checkReport;
  try {
    checkReport = JSON.parse(checked.stdout);
  } catch (error) {
    fail(`G7 流水线校验未返回有效 JSON，不能确认审核门禁：${error.message}`);
  }
  if (
    checkReport?.ok !== true
    || checkReport?.phase !== "all"
    || path.resolve(checkReport?.contentRoot ?? "") !== contentRoot
    || path.resolve(checkReport?.graphFile ?? "") !== graphPath
    || checkReport?.counts?.reviewApprovals !== 2
  ) {
    fail("G7 流水线校验未确认当前课程和两份有效结构化审核回执，不能发布");
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

  const canonicalPoints = loadCanonicalPoints(contentRoot, graph);
  const { course, index, details } = buildCourseData(
    courseId,
    sourceCourse,
    manifest,
    graph,
    canonicalPoints,
  );
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
  })}\n`);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  try {
    await publish(parseArgs(process.argv));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
