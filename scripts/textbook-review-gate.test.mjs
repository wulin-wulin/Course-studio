import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
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

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREPARE_SCRIPT = path.join(PROJECT_ROOT, "scripts", "prepare-course-review.mjs");
// Keep the fixture's generated course id so the pipeline's own handoff
// contracts remain valid; the textbook sidecar is what this test exercises.
const COURSE_ID = "state-machines";

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function makeWorkspace(t, { full = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "textbook-review-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createCourseFixture(t, { withAnimation: false, includeDetails: full });
  if (full) buildAnimationRegistry(fixture.root);
  const contentRoot = path.join(root, "pipeline", COURSE_ID, "course-content");
  copyDirectory(fixture.root, contentRoot);
  return { root, contentRoot, courseRoot: path.dirname(contentRoot) };
}

function runPrepare(root, kind) {
  return spawnSync(process.execPath, [PREPARE_SCRIPT, kind, COURSE_ID], {
    cwd: root,
    encoding: "utf8",
  });
}

function validOutline() {
  return {
    schema_version: "textbook-outline/1.0",
    document_id: "document-1",
    course: { id: COURSE_ID, title: "教材课程" },
    source: { filename: "book.pdf", sha256: "a".repeat(64), parser: "local-pdf" },
    chapters: [
      {
        id: "chapter-one",
        title: "第一章",
        order: 0,
        points: [
          { id: "input-state", title: "输入状态", order: 0, origin: "textbook" },
          { id: "state-transition", title: "状态转移", order: 1, origin: "textbook" },
        ],
      },
      {
        id: "chapter-two",
        title: "第二章",
        order: 1,
        points: [
          { id: "terminal-condition", title: "终止条件", order: 0, origin: "textbook" },
        ],
      },
    ],
  };
}

function writeGraph(courseRoot, { badMapping = false } = {}) {
  const indexDocument = JSON.parse(readFileSync(
    path.join(courseRoot, "course-content", "src", "data", "index.json"),
    "utf8",
  ));
  const manifest = JSON.parse(readFileSync(
    path.join(courseRoot, "course-content", "generation", "manifest.json"),
    "utf8",
  ));
  const points = indexDocument.points.map((point, pointIndex) => ({
    ...point,
    prerequisites: pointIndex === 0 ? [] : [indexDocument.points[pointIndex - 1].id],
    clusterIds: [pointIndex < 2 ? "chapter-one" : (badMapping ? "chapter-one" : "chapter-two")],
    role: pointIndex === 0 ? "trunk" : pointIndex === 2 ? "leaf" : "branch",
    related: [],
  }));
  writeJson(path.join(courseRoot, "clustered-graph.json"), {
    schema_version: "clustered-graph/2.0",
    subject: manifest.subject,
    generation: {
      generatedAt: "2026-10-14",
      sourceCourseId: COURSE_ID,
      pointCount: points.length,
      clusterCount: 2,
      refinedPrerequisiteEdges: [],
      brokenCycleEdges: [],
    },
    clusters: [
      { id: "chapter-one", title: "第一章", subtitle: "", description: "", order: 0 },
      { id: "chapter-two", title: "第二章", subtitle: "", description: "", order: 1 },
    ],
    points,
  });
}

test("G2 review preparation hard-fails when a textbook outline is invalid", (t) => {
  const { root, courseRoot } = makeWorkspace(t);
  writeJson(path.join(courseRoot, "textbook-outline.json"), {
    schema_version: "textbook-outline/1.0",
    document_id: "document-1",
    course: { id: COURSE_ID, title: "教材课程" },
    source: { filename: "book.pdf", sha256: "a".repeat(64) },
    chapters: [],
  });

  const result = runPrepare(root, "knowledge-points");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /教材结构校验（validate-textbook-outline）未通过/);
  assert.doesNotMatch(result.stderr, /G1 知识点索引校验未通过/);
});

test("G6 review preparation hard-fails when a graph remaps a textbook point", (t) => {
  const { root, courseRoot } = makeWorkspace(t, { full: true });
  writeJson(path.join(courseRoot, "textbook-outline.json"), validOutline());
  writeGraph(courseRoot, { badMapping: true });

  const result = runPrepare(root, "knowledge-graph");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /教材图谱校验（validate-textbook-graph）未通过/);
  assert.match(result.stderr, /主知识簇不是教材章节/);
});
