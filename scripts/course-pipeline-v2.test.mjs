import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
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
const INIT_SCRIPT = path.join(PROJECT_ROOT, "scripts", "init-course-pipeline.mjs");
const PUBLISH_SCRIPT = path.join(PROJECT_ROOT, "scripts", "publish-course-pipeline.mjs");

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function writeKnowledgePointApproval(workspace, courseId, points) {
  writeJson(
    path.join(workspace, ".course-review-approvals", courseId, "knowledge-points.json"),
    {
      schema_version: "course-review-approval/1.0",
      review_id: `review-${courseId}-knowledge-points`,
      course_id: courseId,
      kind: "knowledge-points",
      gate: "G2_IDENTITY_REVIEW",
      identity_sha256: sha256(points.map((point) => [point.id, point.title.trim()])),
      approved_at: "2026-07-23T00:00:00.000Z",
      operation_count: 0,
      submitted_operations: [],
    },
  );
}

function normalizedReviewAudit(graph) {
  return graph.generation.refinedPrerequisiteEdges.map((entry) => ({
    op: String(entry.op ?? "").trim(),
    from: String(entry.from ?? "").trim(),
    to: String(entry.to ?? "").trim(),
    reason: String(entry.reason ?? "").trim(),
  }));
}

function writePrerequisiteApproval(workspace, courseId, graph) {
  const { points } = graph;
  const edges = points
    .flatMap((point) => point.prerequisites.map((prerequisite) => [point.id, prerequisite]))
    .sort(([leftDependent, leftPrerequisite], [rightDependent, rightPrerequisite]) => (
      compareText(leftDependent, rightDependent)
      || compareText(leftPrerequisite, rightPrerequisite)
    ));
  writeJson(
    path.join(workspace, ".course-review-approvals", courseId, "prerequisites.json"),
    {
      schema_version: "course-review-approval/1.0",
      review_id: `review-${courseId}-prerequisites`,
      course_id: courseId,
      kind: "prerequisites",
      gate: "G6_PREREQUISITE_REVIEW",
      identity_sha256: sha256(points.map((point) => [point.id, point.title.trim()])),
      prerequisites_sha256: sha256(edges),
      review_audit_sha256: sha256(normalizedReviewAudit(graph)),
      approved_at: "2026-07-23T00:00:00.000Z",
      operation_count: 0,
      submitted_operations: [],
    },
  );
}

function run(script, args, cwd, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      COURSE_STUDIO_PROJECT_ROOT: PROJECT_ROOT,
      ...extraEnv,
    },
  });
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function assertNoPublishingDirectories(workspace, courseId = "state-machines") {
  const coursesDirectory = path.join(workspace, "courses");
  if (existsSync(coursesDirectory)) {
    assert.deepEqual(
      readdirSync(coursesDirectory).filter((name) => name.startsWith(".publishing-")),
      [],
    );
  }
  assert.deepEqual(
    readdirSync(tmpdir()).filter((name) => name.startsWith(`course-studio-publish-${courseId}-`)),
    [],
  );
}

function makeWorkspace(t, prefix) {
  const generatedRoot = path.join(PROJECT_ROOT, "packages", "backend", "generated");
  mkdirSync(generatedRoot, { recursive: true });
  const root = mkdtempSync(path.join(generatedRoot, prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function copyDirectory(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isSymbolicLink() || lstatSync(sourcePath).isSymbolicLink()) {
      throw new Error(`测试不复制符号链接：${sourcePath}`);
    }
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else if (entry.isFile()) copyFileSync(sourcePath, targetPath);
    else throw new Error(`测试遇到不支持的目录项：${sourcePath}`);
  }
}

function installSessionSkills(workspace) {
  const target = path.join(workspace, ".opencode", "skills");
  mkdirSync(target, { recursive: true });
  for (const name of [
    "candidate-knowledge-point-generator",
    "knowledge-cluster-builder",
    "knowledge-pipeline-orchestrator",
  ]) {
    copyDirectory(path.join(PROJECT_ROOT, "skills", name), path.join(target, name));
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
      sourceCourseId: index.courseId,
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
    points: points.map((point, indexValue) => ({
      ...point,
      clusterIds: ["state-process"],
      role: indexValue === 0 ? "trunk" : indexValue === 2 ? "leaf" : "branch",
      related: [],
    })),
  };
}

function preparePublishFixture(t, { withAnimation }) {
  const workspace = makeWorkspace(t, "course-pipeline-publish-");
  installSessionSkills(workspace);
  const fixture = createCourseFixture(t, { withAnimation });
  buildAnimationRegistry(fixture.root);
  const courseId = "state-machines";
  const contentRoot = path.join(workspace, "pipeline", courseId, "course-content");
  copyDirectory(fixture.root, contentRoot);
  const graph = makeGraph(contentRoot);
  writeJson(path.join(workspace, "pipeline", courseId, "clustered-graph.json"), graph);
  writeKnowledgePointApproval(workspace, courseId, graph.points);
  writePrerequisiteApproval(workspace, courseId, graph);
  return { workspace, courseId, contentRoot, graph };
}

test("v2 初始化器分阶段创建动态占位且不会覆盖已有内容", (t) => {
  const workspace = makeWorkspace(t, "course-pipeline-init-");
  const courseId = "test-course";
  assertSuccess(run(INIT_SCRIPT, [courseId], workspace));

  const contentRoot = path.join(workspace, "pipeline", courseId, "course-content");
  assert.ok(existsSync(path.join(contentRoot, "src", "data", "course.json")));
  assert.ok(existsSync(path.join(contentRoot, "generation", "manifest.json")));
  assert.ok(existsSync(path.join(workspace, "pipeline", courseId, "clustered-graph.json")));
  assert.equal(existsSync(path.join(workspace, "pipeline", courseId, "candidate-points.json")), false);

  writeJson(path.join(contentRoot, "src", "data", "index.json"), {
    schema_version: "course-content-index/1.0",
    courseId,
    points: [
      { id: "first-point", title: "第一个知识点" },
      { id: "second-point", title: "第二个知识点" },
    ],
  });
  const blocked = run(INIT_SCRIPT, [courseId, "--stage", "points"], workspace);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /尚未获得用户审核/);
  const blockedManifest = run(
    INIT_SCRIPT,
    [courseId, "--stage", "animation-manifest"],
    workspace,
  );
  assert.notEqual(blockedManifest.status, 0);
  assert.match(blockedManifest.stderr, /尚未获得用户审核/);
  assert.equal(
    existsSync(path.join(contentRoot, "generation", "animation-manifest.json")),
    false,
  );
  writeKnowledgePointApproval(
    workspace,
    courseId,
    readJson(path.join(contentRoot, "src", "data", "index.json")).points,
  );
  assertSuccess(run(INIT_SCRIPT, [courseId, "--stage", "points"], workspace));
  const firstPoint = path.join(contentRoot, "src", "data", "points", "first-point.json");
  const firstRequest = path.join(contentRoot, "generation", "animation-requests", "first-point.json");
  assert.ok(existsSync(firstPoint));
  assert.ok(existsSync(firstRequest));
  writeFileSync(firstPoint, "preserve-me\n", "utf8");
  assertSuccess(run(INIT_SCRIPT, [courseId, "--stage=points"], workspace));
  assert.equal(readFileSync(firstPoint, "utf8"), "preserve-me\n");

  assertSuccess(run(INIT_SCRIPT, [courseId, "--stage", "animation-manifest"], workspace));
  writeJson(path.join(contentRoot, "generation", "animation-manifest.json"), {
    schema_version: "course-content-animations/1.0",
    animations: [{ component: "ExampleAnimation" }],
  });
  assertSuccess(run(INIT_SCRIPT, [courseId, "--stage", "animations"], workspace));
  assert.ok(existsSync(path.join(contentRoot, "src", "animations", "ExampleAnimation.tsx")));
  assert.ok(existsSync(path.join(contentRoot, "src", "animations", "ExampleAnimation.css")));
});

test("v2 所有 post-G2 脚手架阶段都会拒绝过期知识点回执", (t) => {
  const workspace = makeWorkspace(t, "course-pipeline-stale-g2-");
  const courseId = "test-course";
  assertSuccess(run(INIT_SCRIPT, [courseId], workspace));
  const contentRoot = path.join(workspace, "pipeline", courseId, "course-content");
  const indexPath = path.join(contentRoot, "src", "data", "index.json");
  writeJson(indexPath, {
    schema_version: "course-content-index/1.0",
    courseId,
    points: [{ id: "first-point", title: "审核时标题" }],
  });
  writeKnowledgePointApproval(workspace, courseId, readJson(indexPath).points);
  writeJson(indexPath, {
    schema_version: "course-content-index/1.0",
    courseId,
    points: [{ id: "first-point", title: "审核后标题" }],
  });

  for (const stage of ["points", "animation-manifest", "animations"]) {
    const result = run(INIT_SCRIPT, [courseId, "--stage", stage], workspace);
    assert.notEqual(result.status, 0, `${stage} unexpectedly passed`);
    assert.match(result.stderr, /id\/title\/顺序变化而失效/);
  }
  assert.deepEqual(
    readdirSync(path.join(contentRoot, "src", "data", "points")),
    [],
  );
  assert.deepEqual(
    readdirSync(path.join(contentRoot, "generation", "animation-requests")),
    [],
  );
  assert.equal(
    existsSync(path.join(contentRoot, "generation", "animation-manifest.json")),
    false,
  );
});

test("v2 无动画内容包可发布并完整保留正文、关系与主簇适配", (t) => {
  const { workspace, courseId, graph } = preparePublishFixture(t, { withAnimation: false });
  const result = run(PUBLISH_SCRIPT, [courseId], workspace);
  assertSuccess(result);

  const output = path.join(workspace, "courses", courseId);
  const course = readJson(path.join(output, "course.json"));
  const index = readJson(path.join(output, "index.json"));
  const source = graph.points[0];
  const detail = readJson(path.join(output, "points", `${source.id}.json`));
  assert.equal(course.version, "0.1.0");
  assert.equal(course.revision, "0.1.0");
  assert.deepEqual(detail.principles, source.principles);
  assert.equal(detail.coreIdea, source.coreIdea);
  assert.deepEqual(detail.clusterIds, ["state-process"]);
  assert.equal(detail.clusterId, "state-process");
  assert.equal(detail.kind, "concept");
  assert.ok(Array.isArray(detail.pos));
  assert.ok(detail.scale > 0);
  assert.equal(index.points[0].clusterId, "state-process");
  assert.ok(index.clusters[0].polygon.length >= 5);
});

test("v2 target 已落盘但上层未提交时可幂等恢复且不会覆盖不同内容", (t) => {
  const { workspace, courseId } = preparePublishFixture(t, { withAnimation: false });
  const first = run(PUBLISH_SCRIPT, [courseId], workspace);
  assertSuccess(first);
  assert.equal(JSON.parse(first.stdout).recovered, false);

  // The filesystem state after rename is identical whether the caller received
  // the result or crashed before committing the workspace.
  const targetDirectory = path.join(workspace, "courses", courseId);
  const coursePath = path.join(targetDirectory, "course.json");
  const publishedCourse = readFileSync(coursePath, "utf8");
  const recovered = run(PUBLISH_SCRIPT, [courseId], workspace);
  assertSuccess(recovered);
  assert.equal(JSON.parse(recovered.stdout).recovered, true);
  assert.equal(readFileSync(coursePath, "utf8"), publishedCourse);

  const conflictingCourse = readJson(coursePath);
  conflictingCourse.title = "不能被重试覆盖的已有课程";
  writeJson(coursePath, conflictingCourse);
  const conflict = run(PUBLISH_SCRIPT, [courseId], workspace);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /内容与当前已审核流水线生成结果不同/);
  assert.equal(readJson(coursePath).title, "不能被重试覆盖的已有课程");
  assertNoPublishingDirectories(workspace, courseId);
});

test("v2 动画内容包会编译成带完整性清单的沙箱运行时", (t) => {
  const { workspace, courseId } = preparePublishFixture(t, { withAnimation: true });
  const result = run(PUBLISH_SCRIPT, [courseId], workspace);
  assertSuccess(result);

  const animationRoot = path.join(workspace, "courses", courseId, "animations");
  const manifest = readJson(path.join(animationRoot, "manifest.json"));
  assert.equal(manifest.schema_version, "course-animation-runtime/1.0");
  assert.equal(manifest.format, "sandboxed-iframe");
  assert.equal(manifest.animations.length, 1);
  for (const fileName of ["runtime.js", "runtime.css"]) {
    const filePath = path.join(animationRoot, fileName);
    assert.ok(existsSync(filePath));
    assert.ok(readFileSync(filePath).length > 0);
    assert.equal(manifest.assets[fileName].bytes, readFileSync(filePath).length);
    assert.match(manifest.assets[fileName].sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(existsSync(path.join(animationRoot, "ProcessFlow.tsx")), false);
});

test("v2 动画源码引用未授权依赖时发布原子失败", (t) => {
  const { workspace, courseId, contentRoot } = preparePublishFixture(t, { withAnimation: true });
  const component = readJson(
    path.join(contentRoot, "generation", "animation-manifest.json"),
  ).animations[0].component;
  const componentPath = path.join(contentRoot, "src", "animations", `${component}.tsx`);
  writeFileSync(
    componentPath,
    `import unsafe from "unapproved-package";\n${readFileSync(componentPath, "utf8")}\nvoid unsafe;\n`,
    "utf8",
  );

  const result = run(PUBLISH_SCRIPT, [courseId], workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未授权依赖/);
  assert.equal(existsSync(path.join(workspace, "courses", courseId)), false);
});

test("v2 缺少或过期的依赖审核回执会在发布前阻断", (t) => {
  const missing = preparePublishFixture(t, { withAnimation: false });
  rmSync(
    path.join(
      missing.workspace,
      ".course-review-approvals",
      missing.courseId,
      "prerequisites.json",
    ),
  );
  const missingResult = run(PUBLISH_SCRIPT, [missing.courseId], missing.workspace);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /依赖关系.*尚未获得用户审核/);
  assert.equal(existsSync(path.join(missing.workspace, "courses", missing.courseId)), false);

  const stale = preparePublishFixture(t, { withAnimation: false });
  const approvalPath = path.join(
    stale.workspace,
    ".course-review-approvals",
    stale.courseId,
    "prerequisites.json",
  );
  const approval = readJson(approvalPath);
  approval.prerequisites_sha256 = "0".repeat(64);
  writeJson(approvalPath, approval);
  const staleResult = run(PUBLISH_SCRIPT, [stale.courseId], stale.workspace);
  assert.notEqual(staleResult.status, 0);
  assert.match(staleResult.stderr, /审核回执已经失效/);
  assert.equal(existsSync(path.join(stale.workspace, "courses", stale.courseId)), false);

  const staleAudit = preparePublishFixture(t, { withAnimation: false });
  const staleAuditApprovalPath = path.join(
    staleAudit.workspace,
    ".course-review-approvals",
    staleAudit.courseId,
    "prerequisites.json",
  );
  const staleAuditApproval = readJson(staleAuditApprovalPath);
  staleAuditApproval.review_audit_sha256 = "0".repeat(64);
  writeJson(staleAuditApprovalPath, staleAuditApproval);
  const staleAuditResult = run(PUBLISH_SCRIPT, [staleAudit.courseId], staleAudit.workspace);
  assert.notEqual(staleAuditResult.status, 0);
  assert.match(staleAuditResult.stderr, /审核回执已经失效/);
  assert.equal(
    existsSync(path.join(staleAudit.workspace, "courses", staleAudit.courseId)),
    false,
  );
});

test("v2 缺少或过期的知识点审核回执会在发布前阻断", (t) => {
  const missing = preparePublishFixture(t, { withAnimation: false });
  rmSync(
    path.join(
      missing.workspace,
      ".course-review-approvals",
      missing.courseId,
      "knowledge-points.json",
    ),
  );
  const missingResult = run(PUBLISH_SCRIPT, [missing.courseId], missing.workspace);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /知识点清单.*尚未获得用户审核/);
  assert.equal(existsSync(path.join(missing.workspace, "courses", missing.courseId)), false);

  const stale = preparePublishFixture(t, { withAnimation: false });
  const approvalPath = path.join(
    stale.workspace,
    ".course-review-approvals",
    stale.courseId,
    "knowledge-points.json",
  );
  const approval = readJson(approvalPath);
  approval.identity_sha256 = "0".repeat(64);
  writeJson(approvalPath, approval);
  const staleResult = run(PUBLISH_SCRIPT, [stale.courseId], stale.workspace);
  assert.notEqual(staleResult.status, 0);
  assert.match(staleResult.stderr, /知识点审核后.*审核回执已经失效/);
  assert.equal(existsSync(path.join(stale.workspace, "courses", stale.courseId)), false);
});

test("v2 发布器要求 G7 报告明确验证两份结构化审核", (t) => {
  const { workspace, courseId } = preparePublishFixture(t, { withAnimation: false });
  const checkerPath = path.join(
    workspace,
    ".opencode",
    "skills",
    "knowledge-pipeline-orchestrator",
    "scripts",
    "check-pipeline.mjs",
  );
  writeFileSync(
    checkerPath,
    'console.log(JSON.stringify({ ok: true, counts: { reviewApprovals: 0 } }));\n',
    "utf8",
  );

  const result = run(PUBLISH_SCRIPT, [courseId], workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未确认当前快照和两份有效结构化审核回执/);
  assert.equal(existsSync(path.join(workspace, "courses", courseId)), false);
});

test("v2 G7 拒绝通过符号链接伪造审批回执", (t) => {
  const { workspace, courseId } = preparePublishFixture(t, { withAnimation: false });
  const approvalPath = path.join(
    workspace,
    ".course-review-approvals",
    courseId,
    "knowledge-points.json",
  );
  const linkedTarget = path.join(workspace, "linked-knowledge-approval.json");
  writeFileSync(linkedTarget, readFileSync(approvalPath));
  rmSync(approvalPath);
  try {
    symlinkSync(linkedTarget, approvalPath, "file");
  } catch (error) {
    t.skip(`当前平台不能创建测试符号链接：${error.message}`);
    return;
  }

  const result = run(PUBLISH_SCRIPT, [courseId], workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /符号链接/);
  assert.equal(existsSync(path.join(workspace, "courses", courseId)), false);
});

test("v2 发布器拒绝 graph 叶子和 pipeline 祖先符号链接", (t) => {
  const graphLinked = preparePublishFixture(t, { withAnimation: false });
  const graphPath = path.join(
    graphLinked.workspace,
    "pipeline",
    graphLinked.courseId,
    "clustered-graph.json",
  );
  const graphTarget = path.join(graphLinked.workspace, "linked-graph.json");
  writeFileSync(graphTarget, readFileSync(graphPath));
  rmSync(graphPath);
  try {
    symlinkSync(graphTarget, graphPath, "file");
  } catch (error) {
    t.skip(`当前平台不能创建测试符号链接：${error.message}`);
    return;
  }
  const graphResult = run(PUBLISH_SCRIPT, [graphLinked.courseId], graphLinked.workspace);
  assert.notEqual(graphResult.status, 0);
  assert.match(graphResult.stderr, /符号链接/);
  assert.equal(
    existsSync(path.join(graphLinked.workspace, "courses", graphLinked.courseId)),
    false,
  );

  const ancestorLinked = preparePublishFixture(t, { withAnimation: false });
  const pipelinePath = path.join(ancestorLinked.workspace, "pipeline");
  const pipelineTarget = path.join(ancestorLinked.workspace, "real-pipeline");
  renameSync(pipelinePath, pipelineTarget);
  symlinkSync(pipelineTarget, pipelinePath, "dir");
  const ancestorResult = run(
    PUBLISH_SCRIPT,
    [ancestorLinked.courseId],
    ancestorLinked.workspace,
  );
  assert.notEqual(ancestorResult.status, 0);
  assert.match(ancestorResult.stderr, /符号链接/);
  assert.equal(
    existsSync(path.join(ancestorLinked.workspace, "courses", ancestorLinked.courseId)),
    false,
  );
});

test("v2 发布在 G7 期间原工作区变化时仍从同一不可变快照读取课程和动画", (t) => {
  const { workspace, courseId, contentRoot } = preparePublishFixture(t, { withAnimation: true });
  const sourceCoursePath = path.join(contentRoot, "src", "data", "course.json");
  const originalTitle = readJson(sourceCoursePath).title;
  const component = readJson(
    path.join(contentRoot, "generation", "animation-manifest.json"),
  ).animations[0].component;
  const sourceAnimationPath = path.join(contentRoot, "src", "animations", `${component}.tsx`);
  const checkerPath = path.join(
    workspace,
    ".opencode",
    "skills",
    "knowledge-pipeline-orchestrator",
    "scripts",
    "check-pipeline.mjs",
  );
  writeFileSync(
    checkerPath,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      `const sourceCoursePath = ${JSON.stringify(sourceCoursePath)};`,
      `const sourceAnimationPath = ${JSON.stringify(sourceAnimationPath)};`,
      'const sourceCourse = JSON.parse(fs.readFileSync(sourceCoursePath, "utf8"));',
      'sourceCourse.title = "校验后被并发改写的标题";',
      'fs.writeFileSync(sourceCoursePath, `${JSON.stringify(sourceCourse, null, 2)}\\n`, "utf8");',
      'fs.writeFileSync(sourceAnimationPath, `import unsafe from "unapproved-package";\\n${fs.readFileSync(sourceAnimationPath, "utf8")}\\nvoid unsafe;\\n`, "utf8");',
      'console.log(JSON.stringify({',
      '  ok: true,',
      '  phase: "all",',
      '  contentRoot: path.resolve(process.argv[2]),',
      '  graphFile: path.resolve(process.argv[3]),',
      '  counts: { reviewApprovals: 2 },',
      '}));',
      '',
    ].join("\n"),
    "utf8",
  );

  const result = run(PUBLISH_SCRIPT, [courseId], workspace);
  assertSuccess(result);
  assert.equal(readJson(sourceCoursePath).title, "校验后被并发改写的标题");
  assert.match(readFileSync(sourceAnimationPath, "utf8"), /unapproved-package/);
  assert.equal(
    readJson(path.join(workspace, "courses", courseId, "course.json")).title,
    originalTitle,
  );
  assert.ok(existsSync(path.join(workspace, "courses", courseId, "animations", "manifest.json")));
  assertNoPublishingDirectories(workspace, courseId);
});

test("v2 发布拒绝 G7 校验器改写不可变快照", (t) => {
  const { workspace, courseId } = preparePublishFixture(t, { withAnimation: false });
  const checkerPath = path.join(
    workspace,
    ".opencode",
    "skills",
    "knowledge-pipeline-orchestrator",
    "scripts",
    "check-pipeline.mjs",
  );
  writeFileSync(
    checkerPath,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const contentRoot = path.resolve(process.argv[2]);',
      'const graphFile = path.resolve(process.argv[3]);',
      'const coursePath = path.join(contentRoot, "src", "data", "course.json");',
      'const course = JSON.parse(fs.readFileSync(coursePath, "utf8"));',
      'course.title = "G7 擅自改写快照";',
      'fs.chmodSync(coursePath, 0o600);',
      'fs.writeFileSync(coursePath, `${JSON.stringify(course, null, 2)}\\n`, "utf8");',
      'console.log(JSON.stringify({',
      '  ok: true,',
      '  phase: "all",',
      '  contentRoot,',
      '  graphFile,',
      '  counts: { reviewApprovals: 2 },',
      '}));',
      '',
    ].join("\n"),
    "utf8",
  );

  const result = run(PUBLISH_SCRIPT, [courseId], workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /发布快照发生变化/);
  assert.equal(existsSync(path.join(workspace, "courses", courseId)), false);
  assertNoPublishingDirectories(workspace, courseId);
});

test("v2 G7 校验超时会终止子进程并且不留下发布临时目录", (t) => {
  const { workspace, courseId } = preparePublishFixture(t, { withAnimation: false });
  const checkerPath = path.join(
    workspace,
    ".opencode",
    "skills",
    "knowledge-pipeline-orchestrator",
    "scripts",
    "check-pipeline.mjs",
  );
  writeFileSync(checkerPath, "setInterval(() => {}, 1_000);\n", "utf8");

  const result = run(PUBLISH_SCRIPT, [courseId], workspace, {
    COURSE_PIPELINE_G7_TIMEOUT_MS: "50",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /G7 流水线校验超时（50ms）/);
  assert.equal(existsSync(path.join(workspace, "courses", courseId)), false);
  assertNoPublishingDirectories(workspace);
});

test("v2 动画构建超时会取消构建并清理发布临时目录", (t) => {
  const { workspace, courseId } = preparePublishFixture(t, { withAnimation: true });
  const result = run(PUBLISH_SCRIPT, [courseId], workspace, {
    COURSE_ANIMATION_BUNDLE_TIMEOUT_MS: "1",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /教学动画构建超时（1ms）/);
  assert.equal(existsSync(path.join(workspace, "courses", courseId)), false);
  assertNoPublishingDirectories(workspace);
});
