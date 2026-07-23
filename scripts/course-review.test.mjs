import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAnimationRegistry } from "../skills/candidate-knowledge-point-generator/scripts/build_animation_registry.mjs";
import { createCourseFixture } from "../skills/candidate-knowledge-point-generator/scripts/test-fixture.mjs";
import { reviewHashes } from "./prepare-course-review.mjs";

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
      clusterCount: 2,
      brokenCycleEdges: [],
      refinedPrerequisiteEdges: [],
    },
    clusters: [
      {
        id: "state-process",
        title: "状态过程",
        subtitle: "从输入到转换",
        description: "描述状态如何按规则发生变化。",
        order: 0,
      },
      {
        id: "state-outcomes",
        title: "状态结果",
        subtitle: "从转换到终止",
        description: "描述状态过程如何达到终止条件。",
        order: 1,
      },
    ],
    points: points.map((point, index) => ({
      ...point,
      clusterIds: [index === points.length - 1 ? "state-outcomes" : "state-process"],
      role: index === 0 || index === points.length - 1 ? "trunk" : "branch",
      related: [],
    })),
  };
}

function workspace(t, { full = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "course-review-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createCourseFixture(t, { withAnimation: false, includeDetails: full });
  if (full) buildAnimationRegistry(fixture.root);
  const contentRoot = path.join(root, "pipeline", COURSE_ID, "course-content");
  copyDirectory(fixture.root, contentRoot);
  const graph = full ? makeGraph(contentRoot) : null;
  if (graph) writeJson(path.join(root, "pipeline", COURSE_ID, "clustered-graph.json"), graph);
  return { root, contentRoot, graph };
}

function approvalBase(kind) {
  return {
    schema_version: "course-review-approval/1.0",
    review_id: `review-${kind}`,
    course_id: COURSE_ID,
    kind,
    gate: kind === "knowledge-points" ? "G2_IDENTITY_REVIEW" : "G6_GRAPH_REVIEW",
    approved_at: "2026-07-24T00:00:00.000Z",
    operation_count: 0,
    submitted_operations: [],
  };
}

function writeApproval(root, kind, points, graph = null) {
  const hashes = reviewHashes(kind, points, graph);
  writeJson(
    path.join(root, ".course-review-approvals", COURSE_ID, `${kind}.json`),
    {
      ...approvalBase(kind),
      identity_sha256: hashes.identitySha256,
      ...(kind === "knowledge-graph" ? {
        clusters_sha256: hashes.clustersSha256,
        prerequisites_sha256: hashes.prerequisitesSha256,
        review_audit_sha256: hashes.reviewAuditSha256,
      } : {}),
    },
  );
}

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

test("G2 无回执时创建结构化请求并阻止详情脚手架", (t) => {
  const { root, contentRoot } = workspace(t);
  const prepared = run(PREPARE_SCRIPT, ["knowledge-points", COURSE_ID], root);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).status, "pending");
  assert.equal(
    readJson(path.join(root, "pipeline", COURSE_ID, "reviews", "knowledge-points.request.json")).gate,
    "G2_IDENTITY_REVIEW",
  );

  const blocked = run(INIT_SCRIPT, [COURSE_ID, "--stage", "points"], root);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /尚未获得用户审核/);

  const index = readJson(path.join(contentRoot, "src", "data", "index.json"));
  writeApproval(root, "knowledge-points", index.points);
  const approvalPath = path.join(
    root,
    ".course-review-approvals",
    COURSE_ID,
    "knowledge-points.json",
  );
  const invalidApproval = readJson(approvalPath);
  invalidApproval.operation_count = 1;
  invalidApproval.submitted_operations = ["not-a-signed-operation"];
  writeJson(approvalPath, invalidApproval);
  const invalidBlocked = run(INIT_SCRIPT, [COURSE_ID, "--stage", "points"], root);
  assert.notEqual(invalidBlocked.status, 0);
  assert.match(invalidBlocked.stderr, /格式错误/);

  writeApproval(root, "knowledge-points", index.points);
  const allowed = run(INIT_SCRIPT, [COURSE_ID, "--stage", "points"], root);
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("G6 图谱审核请求和最终 checker 只接受当前双回执", (t) => {
  const { root, contentRoot, graph } = workspace(t, { full: true });
  const index = readJson(path.join(contentRoot, "src", "data", "index.json"));
  writeApproval(root, "knowledge-points", index.points);

  const pending = run(PREPARE_SCRIPT, ["knowledge-graph", COURSE_ID], root);
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).status, "pending");
  assert.equal(
    readJson(path.join(root, "pipeline", COURSE_ID, "reviews", "knowledge-graph.request.json")).gate,
    "G6_GRAPH_REVIEW",
  );

  writeApproval(root, "knowledge-graph", graph.points, graph);
  const approved = run(PREPARE_SCRIPT, ["knowledge-graph", COURSE_ID], root);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).status, "approved");

  const checked = run(
    CHECKER_SCRIPT,
    [
      contentRoot,
      path.join(root, "pipeline", COURSE_ID, "clustered-graph.json"),
      "--phase",
      "all",
      "--json",
    ],
    root,
  );
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal(JSON.parse(checked.stdout).counts.reviewApprovals, 2);
});

test("图谱审核哈希覆盖簇、clusterIds、role、related、先修和审核审计", (t) => {
  const { graph } = workspace(t, { full: true });
  const baseline = reviewHashes("knowledge-graph", graph.points, graph);
  const cases = [
    (next) => { next.clusters[0].title += "更新"; },
    (next) => { next.points[1].clusterIds.push("state-outcomes"); },
    (next) => { next.points[1].role = "trunk"; },
    (next) => { next.points[0].related = [next.points.at(-1).id]; },
    (next) => { next.points[1].prerequisites = []; },
    (next) => {
      next.generation.refinedPrerequisiteEdges = [{
        op: "remove",
        from: next.points[1].id,
        to: next.points[0].id,
        reason: "审核调整",
      }];
    },
    (next) => {
      next.generation.brokenCycleEdges = [{
        from: next.points[1].id,
        to: next.points[0].id,
        reason: "打破环",
      }];
    },
  ];
  for (const mutate of cases) {
    const next = structuredClone(graph);
    mutate(next);
    const changed = reviewHashes("knowledge-graph", next.points, next);
    assert.notDeepEqual(changed, baseline);
  }
});

test("簇定义在审核后变化会让最终 checker 拒绝回执", (t) => {
  const { root, contentRoot, graph } = workspace(t, { full: true });
  const index = readJson(path.join(contentRoot, "src", "data", "index.json"));
  writeApproval(root, "knowledge-points", index.points);
  writeApproval(root, "knowledge-graph", graph.points, graph);
  graph.clusters[0].description += "审核后修改";
  const graphPath = path.join(root, "pipeline", COURSE_ID, "clustered-graph.json");
  writeJson(graphPath, graph);

  const checked = run(
    CHECKER_SCRIPT,
    [contentRoot, graphPath, "--phase", "all", "--json"],
    root,
  );
  assert.notEqual(checked.status, 0);
  assert.ok(
    JSON.parse(checked.stdout).findings.some(
      (finding) => finding.code === "invalid-knowledge-graph-approval",
    ),
  );
});
