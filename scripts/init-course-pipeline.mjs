#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const COMPONENT_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const STAGES = new Set(["initial", "points", "animation-manifest", "animations"]);

function fail(message) {
  throw new Error(message);
}

function readJson(filePath, label, root = path.resolve(process.cwd())) {
  if (!fs.existsSync(filePath)) fail(`缺少${label}：${path.relative(process.cwd(), filePath)}`);
  assertSafeRegularFile(root, filePath, label);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label}不是有效 JSON：${error.message}`);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
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

function assertKnowledgePointApproval(paths, courseId, points) {
  const identity = points.map((point, index) => {
    if (typeof point?.title !== "string" || !point.title.trim()) {
      fail(`课程索引第 ${index + 1} 个知识点缺少 title，不能验证知识点审核`);
    }
    return [point.id, point.title.trim()];
  });
  const approvalPath = path.join(
    paths.workspaceRoot,
    ".course-review-approvals",
    courseId,
    "knowledge-points.json",
  );
  ensureInside(paths.workspaceRoot, approvalPath);
  if (!fs.existsSync(approvalPath)) {
    fail("知识点清单尚未获得用户审核，不能创建详情任务");
  }
  const approval = readJson(approvalPath, "知识点审核回执", paths.workspaceRoot);
  if (
    approval.schema_version !== "course-review-approval/1.0"
    || typeof approval.review_id !== "string"
    || !approval.review_id.trim()
    || approval.course_id !== courseId
    || approval.kind !== "knowledge-points"
    || approval.gate !== "G2_IDENTITY_REVIEW"
    || !isIsoUtc(approval.approved_at)
    || !Number.isInteger(approval.operation_count)
    || approval.operation_count < 0
    || approval.operation_count > 500
    || !Array.isArray(approval.submitted_operations)
    || approval.submitted_operations.length !== approval.operation_count
    || !approval.submitted_operations.every(isRecord)
    || !SHA256_PATTERN.test(approval.identity_sha256 ?? "")
    || approval.identity_sha256 !== sha256(identity)
  ) {
    fail("知识点审核回执缺失、格式错误或已因 id/title/顺序变化而失效");
  }
}

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    fail(`拒绝访问流水线目录之外的路径：${target}`);
  }
}

function assertSafeDirectoryChain(root, targetDirectory) {
  ensureInside(root, targetDirectory);
  const relative = path.relative(root, targetDirectory);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`流水线路径包含符号链接或非目录项：${current}`);
    }
  }
}

function assertSafeRegularFile(root, filePath, label) {
  assertSafeDirectoryChain(root, path.dirname(filePath));
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label}必须是普通文件，且路径中不能包含符号链接`);
  }
}

function ensureDirectory(root, directory) {
  assertSafeDirectoryChain(root, directory);
  fs.mkdirSync(directory, { recursive: true });
}

function createPlaceholder(root, filePath, created) {
  ensureInside(root, filePath);
  ensureDirectory(root, path.dirname(filePath));
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`目标不是普通文件：${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, "{}\n", { encoding: "utf8", flag: "wx" });
  created.push(path.relative(process.cwd(), filePath).split(path.sep).join("/"));
}

function parseArgs(argv) {
  const courseId = argv[2];
  if (!courseId || !ID_PATTERN.test(courseId)) {
    fail("用法：node .opencode/tools/init-course-pipeline.mjs <course-id> [--stage initial|points|animation-manifest|animations]");
  }
  let stage = "initial";
  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--stage") {
      stage = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--stage=")) {
      stage = argument.slice("--stage=".length);
    } else {
      fail(`未知参数：${argument}`);
    }
  }
  if (!STAGES.has(stage)) fail(`未知脚手架阶段：${stage}`);
  return { courseId, stage };
}

function scaffoldInitial(paths, created) {
  for (const directory of [
    paths.animationRequests,
    paths.points,
    paths.animations,
    paths.components,
  ]) ensureDirectory(paths.pipelineRoot, directory);

  for (const filePath of [paths.course, paths.index, paths.manifest, paths.graph]) {
    createPlaceholder(paths.pipelineRoot, filePath, created);
  }
}

function scaffoldPoints(paths, courseId, created) {
  const index = assertKnowledgePointStageApproved(paths, courseId);
  for (const point of index.points) {
    createPlaceholder(paths.pipelineRoot, path.join(paths.points, `${point.id}.json`), created);
    createPlaceholder(paths.pipelineRoot, path.join(paths.animationRequests, `${point.id}.json`), created);
  }
}

function assertKnowledgePointStageApproved(paths, courseId) {
  const index = readJson(paths.index, "课程索引");
  if (index.schema_version !== "course-content-index/1.0" || index.courseId !== courseId) {
    fail("课程索引必须是 course-content-index/1.0，且 courseId 与命令参数一致");
  }
  if (!Array.isArray(index.points) || index.points.length === 0) fail("课程索引尚未包含知识点");
  const seen = new Set();
  for (const point of index.points) {
    if (!point || !ID_PATTERN.test(point.id ?? "") || seen.has(point.id)) {
      fail(`课程索引包含非法或重复的知识点 ID：${point?.id ?? "<empty>"}`);
    }
    seen.add(point.id);
  }
  assertKnowledgePointApproval(paths, courseId, index.points);
  return index;
}

function scaffoldAnimationManifest(paths, created) {
  createPlaceholder(paths.pipelineRoot, paths.animationManifest, created);
}

function scaffoldAnimations(paths, created) {
  const manifest = readJson(paths.animationManifest, "动画清单");
  if (manifest.schema_version !== "course-content-animations/1.0" || !Array.isArray(manifest.animations)) {
    fail("动画清单必须是 course-content-animations/1.0");
  }
  const seen = new Set();
  for (const animation of manifest.animations) {
    const component = animation?.component ?? "";
    if (!COMPONENT_PATTERN.test(component) || seen.has(component)) {
      fail(`动画清单包含非法或重复的组件名：${component || "<empty>"}`);
    }
    seen.add(component);
    createPlaceholder(paths.pipelineRoot, path.join(paths.animations, `${component}.tsx`), created);
    createPlaceholder(paths.pipelineRoot, path.join(paths.animations, `${component}.css`), created);
  }
}

function main() {
  const { courseId, stage } = parseArgs(process.argv);
  const root = path.resolve(process.cwd());
  const pipelineRoot = path.join(root, "pipeline");
  fs.mkdirSync(pipelineRoot, { recursive: true });
  const pipelineStat = fs.lstatSync(pipelineRoot);
  if (pipelineStat.isSymbolicLink() || !pipelineStat.isDirectory()) fail("pipeline 必须是普通目录");

  const courseRoot = path.join(pipelineRoot, courseId);
  const contentRoot = path.join(courseRoot, "course-content");
  const paths = {
    workspaceRoot: root,
    pipelineRoot,
    courseRoot,
    contentRoot,
    manifest: path.join(contentRoot, "generation", "manifest.json"),
    animationManifest: path.join(contentRoot, "generation", "animation-manifest.json"),
    animationRequests: path.join(contentRoot, "generation", "animation-requests"),
    animations: path.join(contentRoot, "src", "animations"),
    components: path.join(contentRoot, "src", "components"),
    course: path.join(contentRoot, "src", "data", "course.json"),
    index: path.join(contentRoot, "src", "data", "index.json"),
    points: path.join(contentRoot, "src", "data", "points"),
    graph: path.join(courseRoot, "clustered-graph.json"),
  };
  ensureInside(pipelineRoot, courseRoot);

  const created = [];
  if (stage === "initial") scaffoldInitial(paths, created);
  else if (stage === "points") scaffoldPoints(paths, courseId, created);
  else if (stage === "animation-manifest") {
    assertKnowledgePointStageApproved(paths, courseId);
    scaffoldAnimationManifest(paths, created);
  } else {
    assertKnowledgePointStageApproved(paths, courseId);
    scaffoldAnimations(paths, created);
  }

  process.stdout.write(`${JSON.stringify({
    courseId,
    stage,
    created,
    contentRoot: `pipeline/${courseId}/course-content`,
    graphFile: `pipeline/${courseId}/clustered-graph.json`,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
