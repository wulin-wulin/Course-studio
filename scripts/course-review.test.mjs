import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { buildAnimationRegistry } from "../skills/candidate-knowledge-point-generator/scripts/build_animation_registry.mjs";
import { createCourseFixture } from "../skills/candidate-knowledge-point-generator/scripts/test-fixture.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREPARE_SCRIPT = path.join(PROJECT_ROOT, "scripts", "prepare-course-review.mjs");
const INIT_SCRIPT = path.join(PROJECT_ROOT, "scripts", "init-course-pipeline.mjs");
const CHECKER_SCRIPT = path.join(
  PROJECT_ROOT,
  "skills",
  "knowledge-pipeline-orchestrator",
  "scripts",
  "check-pipeline.mjs",
);
const COURSE_ID = "state-machines";

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function copyDirectory(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else if (entry.isFile()) copyFileSync(sourcePath, targetPath);
    else throw new Error(`测试夹具不允许特殊目录项：${sourcePath}`);
  }
}

function makeGraph(contentRoot) {
  const manifest = readJson(path.join(contentRoot, "generation", "manifest.json"));
  const index = readJson(path.join(contentRoot, "src", "data", "index.json"));
  const points = index.points.map((point) => readJson(
    path.join(contentRoot, "src", "data", "points", `${point.id}.json`),
  ));
  return {
    schema_version: "clustered-graph/2.0",
    subject: manifest.subject,
    generation: {
      generatedAt: "2026-07-16",
      sourceCourseId: COURSE_ID,
      pointCount: points.length,
      clusterCount: 1,
      brokenCycleEdges: [],
      refinedPrerequisiteEdges: [],
    },
    clusters: [{
      id: "state-process",
      title: "状态过程",
      subtitle: "从输入状态到终止条件",
      description: "描述状态按规则变化并在明确条件下停止。",
      order: 0,
    }],
    points: points.map((point, index) => ({
      ...point,
      clusterIds: ["state-process"],
      role: index === 0 ? "trunk" : index === points.length - 1 ? "leaf" : "branch",
      related: [],
    })),
  };
}

function makeWorkspace(t, { includeDetails = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "course-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const courseRoot = path.join(root, "pipeline", COURSE_ID);
  const fixture = createCourseFixture(t, { withAnimation: false, includeDetails });
  if (includeDetails) buildAnimationRegistry(fixture.root);
  const contentRoot = path.join(courseRoot, "course-content");
  copyDirectory(fixture.root, contentRoot);
  if (includeDetails) {
    writeJson(path.join(courseRoot, "clustered-graph.json"), makeGraph(contentRoot));
  }
  return root;
}

function run(root, kind) {
  return spawnSync(process.execPath, [PREPARE_SCRIPT, kind, COURSE_ID], {
    cwd: root,
    encoding: "utf8",
  });
}

function runChecker(root, contentRoot, graphPath, ...extra) {
  const relativeInput = (input) => {
    const relative = path.relative(root, input);
    return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      ? relative
      : input;
  };
  return spawnSync(
    process.execPath,
    [
      CHECKER_SCRIPT,
      relativeInput(contentRoot),
      ...(graphPath ? [relativeInput(graphPath)] : []),
      ...extra,
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
}

function writeApproval(root, kind, { stale = false, operations = [] } = {}) {
  const contentRoot = path.join(root, "pipeline", COURSE_ID, "course-content");
  const graphPath = path.join(root, "pipeline", COURSE_ID, "clustered-graph.json");
  const points = kind === "knowledge-points" && !existsSync(graphPath)
    ? readJson(path.join(contentRoot, "src", "data", "index.json")).points
    : readJson(graphPath).points;
  const identitySha256 = sha256(points.map((point) => [point.id, point.title.trim()]));
  const edges = points
    .flatMap((point) => (point.prerequisites ?? []).map(
      (prerequisite) => [point.id, prerequisite],
    ))
    .sort(([leftDependent, leftPrerequisite], [rightDependent, rightPrerequisite]) => (
      compareText(leftDependent, rightDependent)
      || compareText(leftPrerequisite, rightPrerequisite)
    ));
  writeJson(
    path.join(root, ".course-review-approvals", COURSE_ID, `${kind}.json`),
    {
      schema_version: "course-review-approval/1.0",
      review_id: `review-${kind}`,
      course_id: COURSE_ID,
      kind,
      gate: kind === "knowledge-points" ? "G2_IDENTITY_REVIEW" : "G6_PREREQUISITE_REVIEW",
      identity_sha256: stale ? "0".repeat(64) : identitySha256,
      ...(kind === "prerequisites" ? {
        prerequisites_sha256: sha256(edges),
        review_audit_sha256: sha256(
          readJson(graphPath).generation.refinedPrerequisiteEdges.map((entry) => ({
            op: String(entry?.op ?? "").trim(),
            from: String(entry?.from ?? "").trim(),
            to: String(entry?.to ?? "").trim(),
            reason: String(entry?.reason ?? "").trim(),
          })),
        ),
      } : {}),
      approved_at: "2026-07-23T00:00:00.000Z",
      operation_count: operations.length,
      submitted_operations: operations,
    },
  );
}

test("知识点审核在无有效回执时创建持久化请求", (t) => {
  const root = makeWorkspace(t);
  const result = run(root, "knowledge-points");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pending");
  const requestPath = path.join(
    root,
    "pipeline",
    COURSE_ID,
    "reviews",
    "knowledge-points.request.json",
  );
  assert.ok(existsSync(requestPath));
  assert.equal(readJson(requestPath).gate, "G2_IDENTITY_REVIEW");
});

test("G1 索引校验失败时不会创建知识点审核请求", (t) => {
  const root = makeWorkspace(t);
  const indexPath = path.join(
    root,
    "pipeline",
    COURSE_ID,
    "course-content",
    "src",
    "data",
    "index.json",
  );
  const index = readJson(indexPath);
  delete index.points[0].keyTerms;
  writeJson(indexPath, index);

  const result = run(root, "knowledge-points");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /G1 知识点索引校验未通过/);
  assert.equal(
    existsSync(path.join(root, "pipeline", COURSE_ID, "reviews", "knowledge-points.request.json")),
    false,
  );
});

test("模型可写的请求标记不能替代后端审批，也不能启动详情阶段", (t) => {
  const root = makeWorkspace(t);
  const first = run(root, "knowledge-points");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, "pending");

  const repeated = run(root, "knowledge-points");
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).status, "pending");
  assert.equal(
    existsSync(path.join(root, ".course-review-approvals", COURSE_ID, "knowledge-points.json")),
    false,
  );

  const init = spawnSync(process.execPath, [INIT_SCRIPT, COURSE_ID, "--stage", "points"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(init.status, 0);
  assert.match(init.stderr, /尚未获得用户审核/);
  assert.equal(
    existsSync(path.join(root, "pipeline", COURSE_ID, "course-content", "src", "data", "points", "input-state.json")),
    false,
  );
});

test("知识点审核回执与当前身份哈希一致时允许继续", (t) => {
  const root = makeWorkspace(t);
  writeApproval(root, "knowledge-points");
  const result = run(root, "knowledge-points");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "approved");
});

test("依赖审核必须建立在有效知识点审核之上", (t) => {
  const root = makeWorkspace(t, { includeDetails: true });
  const result = run(root, "prerequisites");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /知识点清单尚未(?:获得用户)?审核/);
});

test("依赖审核请求和回执绑定最终边集合", (t) => {
  const root = makeWorkspace(t, { includeDetails: true });
  writeApproval(root, "knowledge-points");
  const pending = run(root, "prerequisites");
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).status, "pending");

  writeApproval(root, "prerequisites");
  const approved = run(root, "prerequisites");
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).status, "approved");
});

test("G6 全量预审核校验失败时不会创建依赖审核请求", (t) => {
  const root = makeWorkspace(t, { includeDetails: true });
  writeApproval(root, "knowledge-points");
  const graphPath = path.join(root, "pipeline", COURSE_ID, "clustered-graph.json");
  const graph = readJson(graphPath);
  graph.generation.clusterCount += 1;
  writeJson(graphPath, graph);

  const result = run(root, "prerequisites");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /G6 依赖关系预审核校验未通过/);
  assert.equal(
    existsSync(path.join(root, "pipeline", COURSE_ID, "reviews", "prerequisites.request.json")),
    false,
  );
});

test("过期知识点回执不会被当作批准", (t) => {
  const root = makeWorkspace(t);
  writeApproval(root, "knowledge-points", { stale: true });
  const result = run(root, "knowledge-points");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "pending");
});

test("缺少后端审批元数据的哈希文件不会被当作批准", (t) => {
  const root = makeWorkspace(t);
  writeApproval(root, "knowledge-points");
  const approvalPath = path.join(
    root,
    ".course-review-approvals",
    COURSE_ID,
    "knowledge-points.json",
  );
  const approval = readJson(approvalPath);
  delete approval.review_id;
  writeJson(approvalPath, approval);

  const result = run(root, "knowledge-points");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "pending");

  const init = spawnSync(process.execPath, [INIT_SCRIPT, COURSE_ID, "--stage", "points"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(init.status, 0);
  assert.match(init.stderr, /回执缺失、格式错误/);
});

test("submitted_operations 数量与 operation_count 不一致时回执无效", (t) => {
  const root = makeWorkspace(t);
  writeApproval(root, "knowledge-points");
  const approvalPath = path.join(
    root,
    ".course-review-approvals",
    COURSE_ID,
    "knowledge-points.json",
  );
  const approval = readJson(approvalPath);
  approval.operation_count = 1;
  writeJson(approvalPath, approval);

  const result = run(root, "knowledge-points");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "pending");
});

test("无效日历时间不能伪装成 ISO UTC 审核时间", (t) => {
  const root = makeWorkspace(t, { includeDetails: true });
  const contentRoot = path.join(root, "pipeline", COURSE_ID, "course-content");
  const graphPath = path.join(root, "pipeline", COURSE_ID, "clustered-graph.json");
  writeApproval(root, "knowledge-points");
  writeApproval(root, "prerequisites");

  const approvalPath = path.join(
    root,
    ".course-review-approvals",
    COURSE_ID,
    "knowledge-points.json",
  );
  const approval = readJson(approvalPath);
  approval.approved_at = "2026-99-99T99:99:99.999Z";
  writeJson(approvalPath, approval);

  const prepared = run(root, "knowledge-points");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).status, "pending");

  const initialized = spawnSync(
    process.execPath,
    [INIT_SCRIPT, COURSE_ID, "--stage", "points"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(initialized.status, 0);
  assert.match(initialized.stderr, /回执缺失、格式错误/);

  const checked = runChecker(root, contentRoot, graphPath, "--phase", "all");
  assert.notEqual(checked.status, 0);
  assert.ok(
    JSON.parse(checked.stdout).findings.some(
      (finding) => finding.code === "invalid-knowledge-points-approval",
    ),
  );
});

test("依赖边变化会让已有依赖审批回到 pending", (t) => {
  const root = makeWorkspace(t, { includeDetails: true });
  writeApproval(root, "knowledge-points");
  writeApproval(root, "prerequisites");
  assert.equal(JSON.parse(run(root, "prerequisites").stdout).status, "approved");

  const graphPath = path.join(root, "pipeline", COURSE_ID, "clustered-graph.json");
  const graph = readJson(graphPath);
  graph.points[1].prerequisites = [];
  graph.generation.refinedPrerequisiteEdges = [{
    op: "remove",
    from: "state-transition",
    to: "input-state",
    reason: "审核前调整课程推进顺序",
  }];
  writeJson(graphPath, graph);
  const changed = run(root, "prerequisites");
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).status, "pending");
});

test("依赖边不变但审计原因变化会让已有审批回到 pending", (t) => {
  const root = makeWorkspace(t, { includeDetails: true });
  const graphPath = path.join(root, "pipeline", COURSE_ID, "clustered-graph.json");
  const graph = readJson(graphPath);
  graph.points[1].prerequisites = [];
  graph.generation.refinedPrerequisiteEdges = [{
    op: "remove",
    from: "state-transition",
    to: "input-state",
    reason: "原审核原因",
  }];
  writeJson(graphPath, graph);
  writeApproval(root, "knowledge-points");
  writeApproval(root, "prerequisites");
  assert.equal(JSON.parse(run(root, "prerequisites").stdout).status, "approved");

  graph.generation.refinedPrerequisiteEdges[0].reason = "审核后被改写的原因";
  writeJson(graphPath, graph);
  const changed = run(root, "prerequisites");
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).status, "pending");
});

test("最终 checker 同样拒绝操作数量不匹配的回执", (t) => {
  const root = makeWorkspace(t, { includeDetails: true });
  const contentRoot = path.join(root, "pipeline", COURSE_ID, "course-content");
  const graphPath = path.join(root, "pipeline", COURSE_ID, "clustered-graph.json");
  writeApproval(root, "knowledge-points");
  writeApproval(root, "prerequisites");
  const valid = runChecker(root, contentRoot, graphPath, "--phase", "all");
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);

  const approvalPath = path.join(
    root,
    ".course-review-approvals",
    COURSE_ID,
    "prerequisites.json",
  );
  const approval = readJson(approvalPath);
  approval.operation_count = 1;
  writeJson(approvalPath, approval);
  const invalid = runChecker(root, contentRoot, graphPath, "--phase", "all");
  assert.notEqual(invalid.status, 0);
  assert.ok(
    JSON.parse(invalid.stdout).findings.some(
      (finding) => finding.code === "invalid-prerequisites-approval",
    ),
  );
});

test("checker 拒绝普通输入的符号链接叶子和祖先链", (t) => {
  const root = makeWorkspace(t, { includeDetails: true });
  const contentRoot = path.join(root, "pipeline", COURSE_ID, "course-content");
  const graphPath = path.join(root, "pipeline", COURSE_ID, "clustered-graph.json");
  const linkedPipeline = path.join(root, "linked-pipeline");
  const linkedGraph = path.join(root, "linked-graph.json");
  try {
    symlinkSync(path.join(root, "pipeline"), linkedPipeline, "dir");
    symlinkSync(graphPath, linkedGraph, "file");
  } catch (error) {
    t.skip(`当前平台不能创建测试符号链接：${error.message}`);
    return;
  }

  const ancestor = runChecker(
    root,
    path.join(linkedPipeline, COURSE_ID, "course-content"),
    graphPath,
    "--phase",
    "all",
    "--pre-review",
    "prerequisites",
  );
  assert.notEqual(ancestor.status, 0);
  assert.match(JSON.parse(ancestor.stdout).findings[0].message, /符号链接/);

  const leaf = runChecker(
    root,
    contentRoot,
    linkedGraph,
    "--phase",
    "all",
    "--pre-review",
    "prerequisites",
  );
  assert.notEqual(leaf.status, 0);
  assert.match(JSON.parse(leaf.stdout).findings[0].message, /符号链接/);
});

test("审批路径中的符号链接会被拒绝", (t) => {
  const root = makeWorkspace(t);
  try {
    symlinkSync(
      path.join(root, "pipeline"),
      path.join(root, ".course-review-approvals"),
      "dir",
    );
  } catch (error) {
    t.skip(`当前平台不能创建测试符号链接：${error.message}`);
    return;
  }
  const result = run(root, "knowledge-points");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /符号链接/);
});
