import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_SCRIPT = path.join(PROJECT_ROOT, "scripts", "gen_opencode_config.py");

function loadPolicy() {
  const source = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('course_config', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps({'permission': module.PERMISSION, 'agents': module._course_agents()}, ensure_ascii=False))",
  ].join("\n");
  const result = spawnSync("python", ["-c", source, CONFIG_SCRIPT], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("outline agent stops at the G2 structured review boundary", () => {
  const { agents } = loadPolicy();
  const outline = agents["course-outline-creator"].permission;
  assert.equal(outline.task, "deny");
  assert.equal(outline.edit["**"], "deny");
  assert.equal(outline.edit["**/pipeline/*/course-content/src/data/index.json"], "allow");
  assert.equal(outline.edit["**/pipeline/*/course-content/src/data/points/*.json"], undefined);
  assert.equal(outline.bash, "deny");
  assert.equal(outline.course_pipeline, "allow");
});

test("full creator uses fixed pipeline tool while workers and default are denied", () => {
  const { permission, agents } = loadPolicy();
  const creator = agents["course-creator"].permission;
  assert.equal(creator.edit["**/pipeline/*/course-content/**"], undefined);
  assert.equal(creator.edit["**/pipeline/*/clustered-graph.json"], "allow");
  assert.equal(creator.task["course-content-worker"], "allow");
  assert.equal(creator.task["course-animation-worker"], "allow");
  assert.equal(creator.bash, "deny");
  assert.equal(creator.course_pipeline, "allow");
  assert.equal(permission.course_pipeline, "deny");
  for (const name of ["course-content-worker", "course-animation-worker"]) {
    assert.equal(agents[name].permission.bash, "deny");
    assert.equal(agents[name].permission.course_pipeline, "deny");
  }
});

test("all configured agents deny hidden doom-loop prompts", () => {
  const { agents } = loadPolicy();
  for (const agent of Object.values(agents)) {
    assert.equal(agent.permission.doom_loop, "deny");
  }
});
