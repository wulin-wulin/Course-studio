#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const COURSE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CONTENT_SCRIPT_ROOT = [
  ".opencode",
  "skills",
  "candidate-knowledge-point-generator",
  "scripts",
];
const GRAPH_SCRIPT_ROOT = [
  ".opencode",
  "skills",
  "knowledge-cluster-builder",
  "knowledge-cluster-builder",
  "scripts",
];
const ORCHESTRATOR_SCRIPT_ROOT = [
  ".opencode",
  "skills",
  "knowledge-pipeline-orchestrator",
  "scripts",
];

function contentPaths(courseId) {
  return {
    contentRoot: `pipeline/${courseId}/course-content`,
    graphFile: `pipeline/${courseId}/clustered-graph.json`,
  };
}

const ACTIONS = new Map([
  ...["index", "points", "animations", "all"].map((phase) => [
    `validate-${phase}`,
    {
      script: [...CONTENT_SCRIPT_ROOT, "validate_output.mjs"],
      args: ({ contentRoot }) => ["--root", contentRoot, "--phase", phase],
    },
  ]),
  [
    "sync-index",
    {
      script: [...CONTENT_SCRIPT_ROOT, "sync_index_from_points.mjs"],
      args: ({ contentRoot }) => ["--root", contentRoot],
    },
  ],
  [
    "sync-index-check",
    {
      script: [...CONTENT_SCRIPT_ROOT, "sync_index_from_points.mjs"],
      args: ({ contentRoot }) => ["--root", contentRoot, "--check"],
    },
  ],
  [
    "build-animation-registry",
    {
      script: [...CONTENT_SCRIPT_ROOT, "build_animation_registry.mjs"],
      args: ({ contentRoot }) => ["--root", contentRoot],
    },
  ],
  [
    "assemble-graph",
    {
      script: [...GRAPH_SCRIPT_ROOT, "assemble-graph-points.mjs"],
      args: ({ contentRoot, graphFile }) => [contentRoot, graphFile],
    },
  ],
  [
    "assemble-graph-check",
    {
      script: [...GRAPH_SCRIPT_ROOT, "assemble-graph-points.mjs"],
      args: ({ contentRoot, graphFile }) => [contentRoot, graphFile, "--check"],
    },
  ],
  [
    "check-graph",
    {
      script: [...GRAPH_SCRIPT_ROOT, "check-graph.mjs"],
      args: ({ graphFile }) => [graphFile],
    },
  ],
  [
    "check-graph-json",
    {
      script: [...GRAPH_SCRIPT_ROOT, "check-graph.mjs"],
      args: ({ graphFile }) => [graphFile, "--json"],
    },
  ],
  [
    "check-content-all",
    {
      script: [...ORCHESTRATOR_SCRIPT_ROOT, "check-pipeline.mjs"],
      args: ({ contentRoot }) => [contentRoot, "--phase", "all"],
    },
  ],
  [
    "check-pipeline-json",
    {
      script: [...ORCHESTRATOR_SCRIPT_ROOT, "check-pipeline.mjs"],
      args: ({ contentRoot, graphFile }) => [contentRoot, graphFile, "--json"],
    },
  ],
  [
    "check-pipeline-all",
    {
      script: [...ORCHESTRATOR_SCRIPT_ROOT, "check-pipeline.mjs"],
      args: ({ contentRoot, graphFile }) => [contentRoot, graphFile, "--phase", "all"],
    },
  ],
  [
    "check-pipeline-all-json",
    {
      script: [...ORCHESTRATOR_SCRIPT_ROOT, "check-pipeline.mjs"],
      args: ({ contentRoot, graphFile }) => [
        contentRoot,
        graphFile,
        "--phase",
        "all",
        "--json",
      ],
    },
  ],
]);

function fail(message) {
  throw new Error(message);
}

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    fail(`拒绝访问当前课程会话之外的路径：${target}`);
  }
}

function assertNoSymlink(root, target, label) {
  ensureInside(root, target);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      fail(`${label}路径不允许符号链接：${current}`);
    }
  }
}

export function pipelineStepActions() {
  return [...ACTIONS.keys()];
}

export function buildPipelineStepInvocation(action, courseId, root = process.cwd()) {
  if (!ACTIONS.has(action) || !COURSE_ID_PATTERN.test(courseId ?? "")) {
    fail(
      "用法：node .opencode/tools/run-course-pipeline-step.mjs "
      + `<${pipelineStepActions().join("|")}> <course-id>`,
    );
  }
  const workspaceRoot = path.resolve(root);
  const definition = ACTIONS.get(action);
  const paths = contentPaths(courseId);
  const script = path.resolve(workspaceRoot, ...definition.script);
  const courseRoot = path.resolve(workspaceRoot, "pipeline", courseId);
  ensureInside(workspaceRoot, script);
  ensureInside(workspaceRoot, courseRoot);
  return {
    action,
    courseId,
    workspaceRoot,
    courseRoot,
    script,
    args: definition.args(paths),
  };
}

export function runPipelineStep(argv = process.argv.slice(2)) {
  const [action, courseId, ...extra] = argv;
  if (extra.length > 0) fail(`未知额外参数：${extra.join(" ")}`);
  const invocation = buildPipelineStepInvocation(action, courseId);
  assertNoSymlink(invocation.workspaceRoot, invocation.script, "受信脚本");
  assertNoSymlink(invocation.workspaceRoot, invocation.courseRoot, "课程流水线");
  if (!fs.existsSync(invocation.script) || !fs.lstatSync(invocation.script).isFile()) {
    fail(`缺少受信流水线脚本：${invocation.script}`);
  }

  const result = spawnSync(process.execPath, [invocation.script, ...invocation.args], {
    cwd: invocation.workspaceRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) fail(`流水线步骤启动失败：${result.error.message}`);
  if (result.signal) fail(`流水线步骤被信号 ${result.signal} 终止`);
  return Number.isInteger(result.status) ? result.status : 1;
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  try {
    process.exitCode = runPipelineStep();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
