import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { buildAnimationRegistry } from "../skills/candidate-knowledge-point-generator/scripts/build_animation_registry.mjs";
import { createCourseFixture } from "../skills/candidate-knowledge-point-generator/scripts/test-fixture.mjs";
import {
  ANIMATION_ACCEPTANCE_SCHEMA,
  animationAcceptancePath,
  computeAnimationArtifactHash,
} from "./animation-acceptance.mjs";

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

function assertNoPublishingDirectories(workspace) {
  const coursesDirectory = path.join(workspace, "courses");
  if (!existsSync(coursesDirectory)) return;
  assert.deepEqual(
    readdirSync(coursesDirectory).filter((name) => name.startsWith(".publishing-")),
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

function writeAnimationAcceptance(workspace, courseId, contentRoot) {
  const animationManifest = readJson(
    path.join(contentRoot, "generation", "animation-manifest.json"),
  );
  writeJson(animationAcceptancePath(workspace, courseId), {
    schema_version: ANIMATION_ACCEPTANCE_SCHEMA,
    courseId,
    status: "accepted",
    animationCount: animationManifest.animations.length,
    artifactHash: computeAnimationArtifactHash(contentRoot),
    acceptedAt: "2026-07-24T00:00:00.000Z",
    conversationId: "test-conversation",
    requestId: "test-question",
    attestation: ["已完成实际动画验收"],
  });
}

function preparePublishFixture(t, { withAnimation, withAcceptance = withAnimation }) {
  const workspace = makeWorkspace(t, "course-pipeline-publish-");
  installSessionSkills(workspace);
  const fixture = createCourseFixture(t, { withAnimation });
  buildAnimationRegistry(fixture.root);
  const courseId = "state-machines";
  const contentRoot = path.join(workspace, "pipeline", courseId, "course-content");
  copyDirectory(fixture.root, contentRoot);
  const graph = makeGraph(contentRoot);
  writeJson(path.join(workspace, "pipeline", courseId, "clustered-graph.json"), graph);
  if (withAcceptance) {
    writeAnimationAcceptance(workspace, courseId, contentRoot);
  }
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
      { id: "first-point" },
      { id: "second-point" },
    ],
  });
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

test("v2 动画内容包缺少系统签发的 G5 验收凭据时拒绝发布", (t) => {
  const { workspace, courseId } = preparePublishFixture(t, {
    withAnimation: true,
    withAcceptance: false,
  });

  const result = run(PUBLISH_SCRIPT, [courseId], workspace);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /G5 动画验收未完成/);
  assert.equal(existsSync(path.join(workspace, "courses", courseId)), false);
});

test("v2 动画源码在验收后变化会使 G5 凭据失效", (t) => {
  const { workspace, courseId, contentRoot } = preparePublishFixture(t, {
    withAnimation: true,
  });
  const component = readJson(
    path.join(contentRoot, "generation", "animation-manifest.json"),
  ).animations[0].component;
  const cssPath = path.join(contentRoot, "src", "animations", `${component}.css`);
  writeFileSync(cssPath, `${readFileSync(cssPath, "utf8")}\n/* changed */\n`, "utf8");

  const result = run(PUBLISH_SCRIPT, [courseId], workspace);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /G5 动画验收凭据已失效/);
  assert.equal(existsSync(path.join(workspace, "courses", courseId)), false);
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
  writeAnimationAcceptance(workspace, courseId, contentRoot);

  const result = run(PUBLISH_SCRIPT, [courseId], workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未授权依赖/);
  assert.equal(existsSync(path.join(workspace, "courses", courseId)), false);
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
