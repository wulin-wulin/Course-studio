#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createCourseMapLayout } from "./layout-course-map.mjs";

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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`无法读取 JSON：${filePath}\n${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const courseId = argv[2];
  if (!courseId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(courseId)) {
    fail("用法：node .opencode/tools/publish-course-pipeline.mjs <course-id>");
  }
  return courseId;
}

function validateGraph(graph) {
  if (graph?.schema_version !== "clustered-graph/1.0") {
    fail("clustered-graph.json 的 schema_version 必须是 clustered-graph/1.0");
  }
  if (!Array.isArray(graph.clusters) || graph.clusters.length === 0) {
    fail("clustered-graph.json 必须至少包含一个簇");
  }
  if (!Array.isArray(graph.points) || graph.points.length === 0) {
    fail("clustered-graph.json 必须至少包含一个知识点");
  }

  const clusterIds = new Set(graph.clusters.map((cluster) => cluster.id));
  const pointIds = new Set();
  for (const point of graph.points) {
    if (!point?.id || pointIds.has(point.id)) fail(`知识点 ID 缺失或重复：${point?.id ?? "<empty>"}`);
    pointIds.add(point.id);
    if (!clusterIds.has(point.clusterId)) fail(`知识点 ${point.id} 引用了不存在的簇 ${point.clusterId}`);
  }

  const indegree = new Map([...pointIds].map((id) => [id, 0]));
  const outgoing = new Map([...pointIds].map((id) => [id, []]));
  for (const point of graph.points) {
    for (const prerequisite of point.prerequisites ?? []) {
      if (!pointIds.has(prerequisite)) fail(`知识点 ${point.id} 引用了不存在的前置知识点 ${prerequisite}`);
      if (prerequisite === point.id) fail(`知识点 ${point.id} 不能依赖自身`);
      outgoing.get(prerequisite).push(point.id);
      indegree.set(point.id, indegree.get(point.id) + 1);
    }
    for (const relatedId of point.related ?? []) {
      if (!pointIds.has(relatedId)) fail(`知识点 ${point.id} 引用了不存在的关联知识点 ${relatedId}`);
    }
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const next of outgoing.get(id)) {
      const degree = indegree.get(next) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (visited !== graph.points.length) fail("prerequisites 中存在环，不能发布");
}

function sentence(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return /[。！？.!?]$/.test(text) ? text : `${text}。`;
}

function clusterDescription(cluster, courseTitle) {
  return sentence(cluster.description, `${cluster.title}是${courseTitle}课程中的核心知识模块`);
}

function pointDetail(point, indexPoint, pointById, clusterById, color) {
  const cluster = clusterById.get(point.clusterId);
  const prerequisites = [...(point.prerequisites ?? [])];
  const comparisons = (point.related ?? []).slice(0, 4).map(
    (id) => `${point.title}与${pointById.get(id).title}处于相近或互补的知识脉络，可比较其目标、方法与适用场景。`,
  );
  const keyTerms = Array.isArray(point.keyTerms) ? point.keyTerms.filter(Boolean).slice(0, 6) : [];
  const terms = keyTerms.length ? keyTerms.join("、") : point.title;

  return {
    id: point.id,
    title: point.title,
    subtitle: cluster.title,
    clusterId: point.clusterId,
    shortSummary: point.shortSummary,
    difficulty: point.difficulty,
    importance: point.importance,
    keyTerms: [...point.keyTerms],
    pos: indexPoint.pos,
    scale: indexPoint.scale,
    aliases: [...(point.aliases ?? [])],
    kind: point.kind,
    role: point.role,
    prerequisites,
    coreIdea: sentence(point.shortSummary, `${point.title}关注${cluster.title}中的关键概念、方法与实践边界`),
    principles: [
      `建立“${point.title}”的概念模型，理解${terms}之间的关系。`,
      `结合“${cluster.title}”的整体目标，分析该知识点的输入、过程、输出与约束。`,
      `通过案例和反馈验证理解，并识别方法成立的条件、常见误区与权衡。`,
    ],
    applications: [
      `在真实任务中识别需要运用“${point.title}”的问题，并选择合适的方法。`,
      `把该知识点与“${cluster.title}”的整体内容相结合，完成分析、设计或评估。`,
    ],
    comparisons,
    related: [...(point.related ?? [])],
    visual: {
      type: "concept-card",
      caption: `${point.title} · ${cluster.title}`,
      color,
    },
  };
}

function buildCourseData(courseId, graph) {
  const courseTitle = graph.subject?.normalizedTitle?.trim() || graph.subject?.input?.trim() || courseId;
  const clusterById = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const pointById = new Map(graph.points.map((point) => [point.id, point]));
  const colorByCluster = new Map(graph.clusters.map((cluster, index) => [cluster.id, PALETTE[index % PALETTE.length]]));
  const rolesById = Object.fromEntries(graph.points.map((point) => [point.id, point.role]));

  const clusters = graph.clusters.map((cluster) => {
    const [accent, soft, dark] = colorByCluster.get(cluster.id);
    return {
      id: cluster.id,
      title: cluster.title,
      subtitle: cluster.subtitle,
      description: clusterDescription(cluster, courseTitle),
      accent: cluster.accent ?? accent,
      soft: cluster.soft ?? soft,
      dark: cluster.dark ?? dark,
    };
  });

  const points = graph.points.map((point) => ({
    id: point.id,
    title: point.title,
    clusterId: point.clusterId,
    shortSummary: point.shortSummary,
    difficulty: point.difficulty,
    importance: point.importance,
    keyTerms: [...point.keyTerms],
  }));

  const baseIndex = {
    schema_version: "1.0",
    courseId,
    generatedAt: new Date().toISOString(),
    clusters,
    points,
    relations: Array.isArray(graph.relations) ? graph.relations : [],
  };
  const layout = createCourseMapLayout({
    courseId,
    index: baseIndex,
    rolesById,
    styleName: "organic",
    seed: `${courseId}:course-creator:v1`,
  });

  const laidOutPointById = new Map(layout.index.points.map((point) => [point.id, point]));
  const details = graph.points.map((point) =>
    pointDetail(
      point,
      laidOutPointById.get(point.id),
      pointById,
      clusterById,
      colorByCluster.get(point.clusterId)[0],
    ),
  );
  const course = {
    schema_version: "1.0",
    id: courseId,
    title: courseTitle,
    subtitle: sentence(graph.subject?.scope, `系统掌握${courseTitle}的核心知识与实践方法`),
    description: sentence(graph.subject?.scope, `从基础概念到综合实践，建立${courseTitle}的完整知识地图`),
    language: graph.subject?.language || "zh-CN",
    accent: PALETTE[0][0],
    route: `/courses/${courseId}`,
    revision: 1,
    status: "published",
  };

  return {
    course,
    index: layout.index,
    details,
  };
}

function publish(courseId) {
  const root = process.cwd();
  const pipelineDirectory = path.join(root, "pipeline", courseId);
  const coursesDirectory = path.join(root, "courses");
  const targetDirectory = path.join(coursesDirectory, courseId);
  const candidatePath = path.join(pipelineDirectory, "candidate-points.json");
  const graphPath = path.join(pipelineDirectory, "clustered-graph.json");
  const pipelineChecker = path.join(
    root,
    ".opencode",
    "skills",
    "knowledge-pipeline-orchestrator",
    "scripts",
    "check-pipeline.mjs",
  );

  if (!fs.existsSync(candidatePath)) fail(`缺少中间产物：pipeline/${courseId}/candidate-points.json`);
  if (!fs.existsSync(graphPath)) fail(`缺少中间产物：pipeline/${courseId}/clustered-graph.json`);
  if (!fs.existsSync(pipelineChecker)) fail("缺少 G4 流水线校验工具，不能发布");
  if (fs.existsSync(targetDirectory)) fail(`课程 ${courseId} 已存在；发布工具不会覆盖已有课程`);
  fs.mkdirSync(coursesDirectory, { recursive: true });

  const graph = readJson(graphPath);
  if (graph.subject?.id !== courseId) {
    fail(`课程 ID 不一致：参数是 ${courseId}，图谱 subject.id 是 ${graph.subject?.id ?? "<empty>"}`);
  }
  const checked = spawnSync(
    process.execPath,
    [pipelineChecker, candidatePath, graphPath, "--json"],
    { cwd: root, encoding: "utf8" },
  );
  if (checked.status !== 0) {
    const detail = (checked.stdout || checked.stderr || "未知校验错误").trim();
    fail(`G4 流水线校验未通过，不能发布：\n${detail}`);
  }
  validateGraph(graph);
  const { course, index, details } = buildCourseData(courseId, graph);

  const temporaryDirectory = path.join(coursesDirectory, `.publishing-${courseId}-${process.pid}`);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  try {
    writeJson(path.join(temporaryDirectory, "course.json"), course);
    writeJson(path.join(temporaryDirectory, "index.json"), index);
    for (const detail of details) {
      writeJson(path.join(temporaryDirectory, "points", `${detail.id}.json`), detail);
    }
    fs.renameSync(temporaryDirectory, targetDirectory);
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  process.stdout.write(
    `${JSON.stringify({ courseId, clusters: index.clusters.length, points: index.points.length, output: `courses/${courseId}` })}\n`,
  );
}

try {
  publish(parseArgs(process.argv));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
