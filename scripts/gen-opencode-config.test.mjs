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

function buildProviders(document) {
  const source = [
    "import contextlib, importlib.util, io, json, sys",
    "spec = importlib.util.spec_from_file_location('course_config', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "document = json.loads(sys.argv[2])",
    "with contextlib.redirect_stdout(io.StringIO()) as output:",
    "    models = module._models_from_file(document)",
    "config = module._build_config(models, document['default'])",
    "print(json.dumps({'provider': config['provider'], 'output': output.getvalue()}, ensure_ascii=False))",
  ].join("\n");
  const result = spawnSync("python", ["-c", source, CONFIG_SCRIPT, JSON.stringify(document)], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function modelEntry(id, extra = {}) {
  return { id, base_url: "https://model.example/v1", api_key: "test-key", ...extra };
}

test("declared model limits win while undeclared non-Kimi models stay unset", () => {
  const declared = { context: 131072, output: 8192 };
  const { provider, output } = buildProviders({
    default: "deepseek-v4-flash",
    models: [
      modelEntry("deepseek-v4-flash", { limit: declared }),
      modelEntry("kimi-k2.6"),
      modelEntry("kimi-k2.5", { limit: { context: 200000, output: 16000 } }),
      modelEntry("custom-model"),
      modelEntry("broken-model", { limit: { context: 131072, output: 0 } }),
    ],
  });
  const limitOf = (id) => provider[id].models[id].limit;
  assert.deepEqual(limitOf("deepseek-v4-flash"), declared);
  assert.deepEqual(limitOf("kimi-k2.6"), { context: 262144, output: 32768 });
  assert.deepEqual(limitOf("kimi-k2.5"), { context: 200000, output: 16000 });
  assert.equal(limitOf("custom-model"), undefined);
  assert.equal(limitOf("broken-model"), undefined);
  assert.match(output, /警告：模型 broken-model 的 limit 无效，已忽略：limit\.output 必须是正整数/);
});

test("outline agent stops at the G2 structured review boundary", () => {
  const { agents } = loadPolicy();
  const outline = agents["course-outline-creator"].permission;
  assert.equal(outline.task, "deny");
  assert.equal(outline.edit["**"], "deny");
  assert.equal(outline.edit["**/pipeline/*/course-content/src/data/index.json"], "allow");
  assert.equal(outline.edit["**/pipeline/*/course-content/generation/manifest.json"], "allow");
  assert.equal(outline.edit["**/pipeline/*/course-content/src/data/points/*.json"], undefined);
  assert.equal(outline.bash, "deny");
  assert.equal(outline.course_pipeline, "allow");
});

test("full creator uses fixed pipeline tool while workers and default are denied", () => {
  const { permission, agents } = loadPolicy();
  const creator = agents["course-creator"].permission;
  assert.equal(creator.edit["**/pipeline/*/course-content/**"], undefined);
  assert.equal(creator.edit["**/pipeline/*/course-content/generation/manifest.json"], "allow");
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

test("textbook primary agents cannot replace the trusted manifest", () => {
  const { agents } = loadPolicy();
  for (const name of ["textbook-outline-creator", "textbook-course-creator"]) {
    const configured = agents[name];
    assert.equal(configured.mode, "primary");
    assert.equal(
      configured.permission.edit["**/pipeline/*/course-content/generation/manifest.json"],
      undefined,
    );
    assert.equal(configured.permission.course_pipeline, "allow");
  }
});

test("all configured agents deny hidden doom-loop prompts", () => {
  const { agents } = loadPolicy();
  for (const agent of Object.values(agents)) {
    assert.equal(agent.permission.doom_loop, "deny");
  }
});
