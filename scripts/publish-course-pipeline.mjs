#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createCourseMapLayout } from "./layout-course-map.mjs";
import { buildCourseAnimationRuntime } from "./bundle-course-animations.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

function parseArgs(argv) {
  const courseId = argv[2];
  if (!courseId || !ID_PATTERN.test(courseId)) {
    fail("用法：node .opencode/tools/publish-course-pipeline.mjs <course-id>");
  }
  if (argv.length > 3) fail(`未知参数：${argv.slice(3).join(" ")}`);
  return courseId;
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

async function publish(courseId) {
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

  const checked = spawnSync(
    process.execPath,
    [pipelineChecker, contentRoot, graphPath, "--phase", "all", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  if (checked.status !== 0) {
    const detail = (checked.stdout || checked.stderr || "未知校验错误").trim();
    fail(`G7 流水线校验未通过，不能发布：\n${detail}`);
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

try {
  await publish(parseArgs(process.argv));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
