#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createCourseMapLayout } from "./layout-course-map.mjs";
import { buildCourseAnimationRuntime } from "./bundle-course-animations.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    fail(`拒绝访问发布工作区之外的路径：${target}`);
  }
}

function assertSafePath(root, target, label, expectedType) {
  ensureInside(root, target);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`${label}的工作区根目录必须是普通目录`);
  }
  let current = root;
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fail(`缺少${label}：${path.relative(root, current)}`);
    const stat = fs.lstatSync(current);
    const isLast = index === segments.length - 1;
    if (stat.isSymbolicLink()) fail(`${label}路径不允许符号链接：${path.relative(root, current)}`);
    if (!isLast && !stat.isDirectory()) fail(`${label}路径包含非目录项：${path.relative(root, current)}`);
    if (isLast && expectedType === "file" && !stat.isFile()) fail(`${label}必须是普通文件`);
    if (isLast && expectedType === "directory" && !stat.isDirectory()) fail(`${label}必须是普通目录`);
  }
}

function openRegularFileNoFollow(filePath, label) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail(`${label}必须是普通文件`);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fail(`无法安全读取${label}：${error.message}`);
  }
}

function readRegularFile(filePath, label) {
  const descriptor = openRegularFileNoFollow(filePath, label);
  try {
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJson(root, filePath, label = "JSON") {
  assertSafePath(root, filePath, label, "file");
  try {
    return JSON.parse(readRegularFile(filePath, label).toString("utf8"));
  } catch (error) {
    fail(`无法读取${label}：${path.relative(root, filePath)}\n${error.message}`);
  }
}

function copyTreeNoLinks(sourceRoot, targetRoot, label) {
  const sourceStat = fs.lstatSync(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    fail(`${label}必须是普通目录，且不能包含符号链接`);
  }
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
      fail(`${label}不允许符号链接：${sourcePath}`);
    }
    if (stat.isDirectory()) {
      copyTreeNoLinks(sourcePath, targetPath, label);
    } else if (stat.isFile()) {
      const value = readRegularFile(sourcePath, label);
      fs.writeFileSync(targetPath, value, { flag: "wx", mode: 0o400 });
    } else {
      fail(`${label}不允许特殊文件：${sourcePath}`);
    }
  }
}

function fingerprintTree(root) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`发布目录指纹只接受普通目录：${root}`);
  }
  const hash = crypto.createHash("sha256");
  function visit(directory, relative = "") {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
      const candidate = path.join(directory, entry.name);
      const stat = fs.lstatSync(candidate);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        fail(`发布快照不允许符号链接：${nextRelative}`);
      }
      if (stat.isDirectory()) {
        hash.update(`d\0${nextRelative}\0`);
        visit(candidate, nextRelative);
      } else if (stat.isFile()) {
        const value = readRegularFile(candidate, `发布快照文件 ${nextRelative}`);
        hash.update(`f\0${nextRelative}\0${value.length}\0`);
        hash.update(value);
      } else {
        fail(`发布快照不允许特殊文件：${nextRelative}`);
      }
    }
  }
  visit(root);
  return hash.digest("hex");
}

function reuseIdenticalPublishedCourse(root, targetDirectory, candidateDirectory, courseId) {
  const existingTarget = fs.lstatSync(targetDirectory, { throwIfNoEntry: false });
  if (!existingTarget) return false;

  assertSafePath(root, targetDirectory, "已有课程发布目录", "directory");
  const candidateFingerprint = fingerprintTree(candidateDirectory);
  const targetFingerprint = fingerprintTree(targetDirectory);
  if (targetFingerprint !== candidateFingerprint) {
    fail(
      `课程 ${courseId} 已存在，但内容与当前已审核流水线生成结果不同；`
        + "发布工具不会覆盖已有课程",
    );
  }

  fs.rmSync(candidateDirectory, { recursive: true, force: true });
  return true;
}

function createPublishSnapshot(root, courseId) {
  const pipelineDirectory = path.join(root, "pipeline", courseId);
  const approvalDirectory = path.join(root, ".course-review-approvals", courseId);
  assertSafePath(root, pipelineDirectory, "课程流水线目录", "directory");
  assertSafePath(root, approvalDirectory, "课程审核回执目录", "directory");

  const snapshotRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir(), `course-studio-publish-${courseId}-`)),
  );
  try {
    copyTreeNoLinks(
      pipelineDirectory,
      path.join(snapshotRoot, "pipeline", courseId),
      "课程流水线快照",
    );
    copyTreeNoLinks(
      approvalDirectory,
      path.join(snapshotRoot, ".course-review-approvals", courseId),
      "课程审核回执快照",
    );
    return {
      root: snapshotRoot,
      pipelineDirectory: path.join(snapshotRoot, "pipeline", courseId),
      fingerprint: fingerprintTree(snapshotRoot),
    };
  } catch (error) {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertSnapshotUnchanged(snapshot) {
  if (fingerprintTree(snapshot.root) !== snapshot.fingerprint) {
    fail("G7 校验或动画构建期间发布快照发生变化，拒绝发布");
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

  assertSafePath(root, pipelineDirectory, "课程流水线目录", "directory");
  assertSafePath(root, pipelineChecker, "G7 流水线校验工具", "file");
  const existingTarget = fs.lstatSync(targetDirectory, { throwIfNoEntry: false });
  if (fs.existsSync(coursesDirectory)) {
    assertSafePath(root, coursesDirectory, "课程发布目录", "directory");
  } else {
    fs.mkdirSync(coursesDirectory, { recursive: false, mode: 0o700 });
  }
  if (existingTarget) {
    assertSafePath(root, targetDirectory, "已有课程发布目录", "directory");
  }

  let snapshot;
  let temporaryDirectory;
  try {
    snapshot = createPublishSnapshot(root, courseId);
    const contentRoot = path.join(snapshot.pipelineDirectory, "course-content");
    const graphPath = path.join(snapshot.pipelineDirectory, "clustered-graph.json");
    const sourceCoursePath = path.join(contentRoot, "src", "data", "course.json");
    const manifestPath = path.join(contentRoot, "generation", "manifest.json");
    const animationManifestPath = path.join(contentRoot, "generation", "animation-manifest.json");
    assertSafePath(snapshot.root, contentRoot, "课程内容快照", "directory");
    assertSafePath(snapshot.root, graphPath, "聚类图谱快照", "file");

    const g7TimeoutMs = timeoutFromEnvironment(
      "COURSE_PIPELINE_G7_TIMEOUT_MS",
      DEFAULT_G7_CHECK_TIMEOUT_MS,
    );
    const checked = spawnSync(
      process.execPath,
      [pipelineChecker, contentRoot, graphPath, "--phase", "all", "--json"],
      {
        cwd: snapshot.root,
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
      fail("G7 流水线校验未确认当前快照和两份有效结构化审核回执，不能发布");
    }
    assertSnapshotUnchanged(snapshot);

    const sourceCourse = readJson(snapshot.root, sourceCoursePath, "课程元数据");
    const manifest = readJson(snapshot.root, manifestPath, "生成清单");
    const animationManifest = readJson(snapshot.root, animationManifestPath, "动画清单");
    const graph = readJson(snapshot.root, graphPath, "聚类图谱");
    validateGraphBasics(graph, courseId);
    if (sourceCourse.id !== courseId || manifest.subject?.id !== courseId) {
      fail("course.json、generation/manifest.json 与 course-id 不一致");
    }

    const animations = Array.isArray(animationManifest.animations) ? animationManifest.animations : null;
    if (animations === null) fail("动画清单格式无效");

    const { course, index, details } = buildCourseData(courseId, sourceCourse, manifest, graph);
    temporaryDirectory = path.join(coursesDirectory, `.publishing-${courseId}-${process.pid}`);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
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
    assertSnapshotUnchanged(snapshot);
    let recovered = reuseIdenticalPublishedCourse(
      root,
      targetDirectory,
      temporaryDirectory,
      courseId,
    );
    if (!recovered) {
      try {
        fs.renameSync(temporaryDirectory, targetDirectory);
      } catch (error) {
        recovered = reuseIdenticalPublishedCourse(
          root,
          targetDirectory,
          temporaryDirectory,
          courseId,
        );
        if (!recovered) throw error;
      }
    }
    temporaryDirectory = undefined;

    process.stdout.write(`${JSON.stringify({
      courseId,
      clusters: index.clusters.length,
      points: index.points.length,
      animations: animations.length,
      output: `courses/${courseId}`,
      recovered,
    })}\n`);
  } catch (error) {
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    if (snapshot) fs.rmSync(snapshot.root, { recursive: true, force: true });
  }
}

try {
  await publish(parseArgs(process.argv));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
