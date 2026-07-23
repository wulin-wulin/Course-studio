import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_SOURCE = path.join(PROJECT_ROOT, ".opencode", "tools", "course_pipeline.ts");

test("course_pipeline enforces agent actions and fixed no-shell argv", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "course-pipeline-tool-"));
  try {
    const toolsRoot = path.join(temporaryRoot, ".opencode", "tools");
    const pluginRoot = path.join(temporaryRoot, "node_modules", "@opencode-ai", "plugin");
    fs.mkdirSync(toolsRoot, { recursive: true });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.copyFileSync(TOOL_SOURCE, path.join(toolsRoot, "course_pipeline.ts"));
    for (const script of [
      "init-course-pipeline.mjs",
      "prepare-course-review.mjs",
      "run-course-pipeline-step.mjs",
      "publish-course-pipeline.mjs",
    ]) {
      fs.writeFileSync(path.join(toolsRoot, script), "// test fixture\n");
    }
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ name: "@opencode-ai/plugin", type: "module", exports: "./index.js" }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      [
        "const schema = { describe() { return this }, regex() { return this } }",
        "export function tool(definition) { return definition }",
        "tool.schema = { enum() { return Object.create(schema) }, string() { return Object.create(schema) } }",
      ].join("\n"),
    );

    const harness = path.join(temporaryRoot, "harness.mjs");
    fs.writeFileSync(harness, `
      import assert from "node:assert/strict"
      import path from "node:path"

      const calls = []
      globalThis.Bun = {
        spawn(argv, options) {
          calls.push({ argv, options })
          return {
            stdout: new Blob([JSON.stringify({ ok: true })]),
            stderr: new Blob([]),
            exited: Promise.resolve(0),
          }
        },
      }
      const definition = (await import("./.opencode/tools/course_pipeline.ts")).default
      const context = (agent) => ({ agent, directory: ${JSON.stringify(temporaryRoot)} })

      await definition.execute(
        { action: "init", courseId: "demo-course" },
        context("course-outline-creator"),
      )
      assert.deepEqual(calls.at(-1).argv, [
        "node",
        path.join(${JSON.stringify(temporaryRoot)}, ".opencode/tools/init-course-pipeline.mjs"),
        "demo-course",
      ])
      assert.equal(calls.at(-1).options.cwd, ${JSON.stringify(temporaryRoot)})
      assert.equal("shell" in calls.at(-1).options, false)

      await definition.execute(
        { action: "review-knowledge-points", courseId: "demo-course" },
        context("course-outline-creator"),
      )
      assert.deepEqual(calls.at(-1).argv.slice(-2), ["knowledge-points", "demo-course"])

      for (const action of ["init-points", "review-knowledge-graph", "publish"]) {
        await assert.rejects(
          definition.execute({ action, courseId: "demo-course" }, context("course-outline-creator")),
          /无权执行/,
        )
      }
      await assert.rejects(
        definition.execute(
          { action: "validate-index", courseId: "demo-course" },
          context("course-content-worker"),
        ),
        /无权执行/,
      )
      await assert.rejects(
        definition.execute({ action: "init", courseId: "../escape" }, context("course-creator")),
        /参数不合法/,
      )

      const creatorCases = [
        ["init-points", "init-course-pipeline.mjs", ["demo-course", "--stage", "points"]],
        ["review-knowledge-graph", "prepare-course-review.mjs", ["knowledge-graph", "demo-course"]],
        ["assemble-graph-check", "run-course-pipeline-step.mjs", ["assemble-graph-check", "demo-course"]],
        ["publish", "publish-course-pipeline.mjs", ["demo-course"]],
      ]
      for (const [action, script, trailingArgs] of creatorCases) {
        await definition.execute({ action, courseId: "demo-course" }, context("course-creator"))
        assert.equal(path.basename(calls.at(-1).argv[1]), script)
        assert.deepEqual(calls.at(-1).argv.slice(2), trailingArgs)
        assert.equal("shell" in calls.at(-1).options, false)
      }
    `);

    const result = spawnSync(process.execPath, ["--experimental-strip-types", harness], {
      cwd: temporaryRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("orchestrator instructions route trusted scripts through course_pipeline", () => {
  const source = fs.readFileSync(
    path.join(PROJECT_ROOT, "skills", "knowledge-pipeline-orchestrator", "SKILL.md"),
    "utf8",
  );
  assert.match(source, /course_pipeline/);
  assert.doesNotMatch(source, /```bash/);
  assert.doesNotMatch(source, /node\s+[^\n]*\.opencode\//);
});

test("both OpenCode launchers provision the custom-tool runtime dependency", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, "scripts", "opencode-tool-package.json"),
    "utf8",
  ));
  assert.equal(manifest.type, "module");
  assert.equal(manifest.dependencies["@opencode-ai/plugin"], "1.18.1");

  const bashLauncher = fs.readFileSync(
    path.join(PROJECT_ROOT, "scripts", "opencode.sh"),
    "utf8",
  );
  assert.match(bashLauncher, /opencode-tool-package\.json/);
  assert.match(bashLauncher, /\.opencode\/package\.json/);
  assert.match(bashLauncher, /NPM_CONFIG_CACHE/);

  const powershellLauncher = fs.readFileSync(
    path.join(PROJECT_ROOT, "scripts", "opencode.ps1"),
    "utf8",
  );
  assert.match(powershellLauncher, /opencode-tool-package\.json/);
  assert.match(powershellLauncher, /"package\.json"/);
  assert.match(powershellLauncher, /NPM_CONFIG_CACHE/);
});
