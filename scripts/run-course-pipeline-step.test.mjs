import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPipelineStepInvocation,
  pipelineStepActions,
} from "./run-course-pipeline-step.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(PROJECT_ROOT, "scripts", "run-course-pipeline-step.mjs");

test("pipeline step runner maps fixed actions to one course-local path", () => {
  const invocation = buildPipelineStepInvocation(
    "assemble-graph-check",
    "demo-course",
    PROJECT_ROOT,
  );
  assert.equal(
    invocation.script,
    path.join(
      PROJECT_ROOT,
      ".opencode",
      "skills",
      "knowledge-cluster-builder",
      "knowledge-cluster-builder",
      "scripts",
      "assemble-graph-points.mjs",
    ),
  );
  assert.deepEqual(invocation.args, [
    "pipeline/demo-course/course-content",
    "pipeline/demo-course/clustered-graph.json",
    "--check",
  ]);
  assert.equal(invocation.courseRoot, path.join(PROJECT_ROOT, "pipeline", "demo-course"));
});

test("every pipeline action is fixed and rejects attacker-controlled path syntax", () => {
  assert.ok(pipelineStepActions().length >= 10);
  for (const action of pipelineStepActions()) {
    const invocation = buildPipelineStepInvocation(action, "safe-course", PROJECT_ROOT);
    assert.ok(invocation.script.startsWith(path.join(PROJECT_ROOT, ".opencode", "skills")));
    assert.ok(invocation.args.every((argument) => !argument.includes("..")));
    assert.ok(
      invocation.args.every(
        (argument) => !argument.includes("/") || argument.includes("pipeline/safe-course/"),
      ),
    );
  }

  for (const courseId of [
    "../other-session",
    "nested/course",
    "demo_course",
    "$(node-e)",
    "`payload`",
    "demo>AGENTS.md",
    "demo course",
    "-demo",
    "demo-",
  ]) {
    assert.throws(
      () => buildPipelineStepInvocation("validate-index", courseId, PROJECT_ROOT),
      /\u7528\u6cd5/,
      courseId,
    );
  }
  assert.throws(
    () => buildPipelineStepInvocation("unknown", "demo-course", PROJECT_ROOT),
    /\u7528\u6cd5/,
  );
});

test("pipeline step CLI rejects extra arguments before dispatch", () => {
  const result = spawnSync(
    process.execPath,
    [RUNNER, "validate-index", "demo-course", "extra"],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\u672a\u77e5\u989d\u5916\u53c2\u6570/);
});
