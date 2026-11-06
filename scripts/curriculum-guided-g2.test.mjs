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

import {
  createCourseFixture,
} from "../skills/candidate-knowledge-point-generator/scripts/test-fixture.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUIDED_VALIDATOR = path.join(
  PROJECT_ROOT,
  "scripts",
  "validate-curriculum-guided-plan.mjs",
);
const PREPARE_REVIEW = path.join(
  PROJECT_ROOT,
  "scripts",
  "prepare-course-review.mjs",
);
const COURSE_ID = "state-machines";
const TEXTBOOK_ID = `doc-${"a".repeat(24)}`;
const CURRICULUM_ID = `curr-${"b".repeat(24)}`;

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
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function createGuidedWorkspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), "curriculum-guided-g2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const base = createCourseFixture(t, {
    withAnimation: false,
    includeDetails: false,
  });
  const contentRoot = path.join(root, "pipeline", COURSE_ID, "course-content");
  copyDirectory(base.root, contentRoot);
  const index = readJson(path.join(contentRoot, "src", "data", "index.json"));

  const textbookRoot = path.join(
    root,
    "curriculum-guided-input",
    "textbook",
    TEXTBOOK_ID,
  );
  const curriculumRoot = path.join(
    root,
    "curriculum-guided-input",
    "curriculum",
    CURRICULUM_ID,
  );
  const sourcePoints = index.points.map((point, order) => ({
    id: point.id,
    title: point.title,
    order,
    origin: "textbook",
  }));
  writeJson(path.join(textbookRoot, "outline.json"), {
    schema_version: "textbook-outline/1.0",
    document_id: TEXTBOOK_ID,
    course: { id: COURSE_ID, title: "状态机基础" },
    title: "状态机基础",
    source: {
      filename: "状态机教材.md",
      sha256: "1".repeat(64),
      parser: "markdown-import",
    },
    chapters: [{
      id: "chapter-foundations",
      title: "状态机基础",
      order: 0,
      points: sourcePoints,
    }],
  });

  const sections = sourcePoints.map((point, order) => ({
    id: `section-${order + 1}`,
    order,
    type: "section",
    title: point.title,
    heading_level: 2,
    heading_path: ["状态机基础", point.title],
    line_start: order * 3 + 1,
    line_end: order * 3 + 3,
    page: order + 1,
    asset_refs: [],
    sha256: String(order + 2).repeat(64),
  }));
  writeJson(path.join(textbookRoot, "material.json"), {
    schema_version: "textbook-material/1.0",
    document_id: TEXTBOOK_ID,
    source: {
      format: "markdown",
      filename: "状态机教材.md",
      sha256: "1".repeat(64),
      parser: "markdown-import",
    },
    sections,
    chunks: [],
    point_sources: sourcePoints.map((point, order) => ({
      point_id: point.id,
      section_ids: [sections[order].id],
      chunk_ids: [],
    })),
  });
  mkdirSync(textbookRoot, { recursive: true });
  writeFileSync(
    path.join(textbookRoot, "full.md"),
    "# 状态机基础\n\n输入状态、状态转移与终止条件。\n",
    "utf8",
  );

  const requirementIds = ["req-input", "req-transition", "req-terminal"];
  writeJson(path.join(curriculumRoot, "requirements.json"), {
    schema_version: "curriculum-requirements/1.0",
    document_id: CURRICULUM_ID,
    document_type: "curriculum-or-syllabus",
    title: "状态机课程教学大纲",
    source: {
      filename: "状态机课程教学大纲.docx",
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256: "2".repeat(64),
      parser: "curriculum-guidance/1.0",
    },
    course_goals: [{ text: "能够设计并检查有限状态过程。" }],
    prerequisites: [],
    content_units: [],
    requirements: requirementIds.map((id, order) => ({
      id,
      text: ["识别输入状态", "掌握状态转移", "判断终止条件"][order],
      level: order === 1 ? "mastery" : "understanding",
      level_label: order === 1 ? "掌握" : "理解",
      kind: "knowledge",
      priority: order === 1 ? "core" : "supporting",
      source: { type: "docx", block: order + 1 },
    })),
    experiments: [],
    warnings: [],
    summary: {
      goal_count: 1,
      unit_count: 0,
      topic_count: 0,
      requirement_count: requirementIds.length,
      experiment_count: 0,
    },
  });
  mkdirSync(curriculumRoot, { recursive: true });
  writeFileSync(
    path.join(curriculumRoot, "full.md"),
    "# 状态机课程教学大纲\n\n要求学习者掌握状态转移。\n",
    "utf8",
  );

  const planPoints = index.points.map((point, order) => ({
    id: point.id,
    title: point.title,
    order,
    action: "retain",
    sourcePointIds: [point.id],
    sourceRefs: [],
    requirementRefs: [requirementIds[order]],
    coverage: "covered",
    clusterIds: ["cluster-foundations"],
    changeReason: "教材知识点与培养要求直接对应，保留原知识身份。",
  }));
  writeJson(
    path.join(root, "pipeline", COURSE_ID, "curriculum-guided-plan.json"),
    {
      schema_version: "curriculum-guided-plan/1.0",
      course: { id: COURSE_ID, title: "状态机基础" },
      sources: {
        textbook_document_id: TEXTBOOK_ID,
        curriculum_document_id: CURRICULUM_ID,
      },
      clusters: [{
        id: "cluster-foundations",
        title: "状态机基础",
        order: 0,
        pointIds: planPoints.map((point) => point.id),
        requirementRefs: requirementIds,
        reason: "培养方案要求按状态过程的输入、转移和终止组织知识点。",
      }],
      points: planPoints,
      omittedSourcePoints: [],
    },
  );

  writeJson(path.join(root, "curriculum-guided-binding.json"), {
    schema_version: "curriculum-guided-binding/1.0",
    textbook_document_id: TEXTBOOK_ID,
    curriculum_document_id: CURRICULUM_ID,
    course_id: COURSE_ID,
    title: "状态机基础",
    textbook_sha256: "3".repeat(64),
    curriculum_sha256: "4".repeat(64),
    guidance_sha256: "5".repeat(64),
    textbook_outline_path:
      `curriculum-guided-input/textbook/${TEXTBOOK_ID}/outline.json`,
    textbook_material_path:
      `curriculum-guided-input/textbook/${TEXTBOOK_ID}/material.json`,
    textbook_markdown_path:
      `curriculum-guided-input/textbook/${TEXTBOOK_ID}/full.md`,
    curriculum_requirements_path:
      `curriculum-guided-input/curriculum/${CURRICULUM_ID}/requirements.json`,
    curriculum_markdown_path:
      `curriculum-guided-input/curriculum/${CURRICULUM_ID}/full.md`,
    output_plan_path: `pipeline/${COURSE_ID}/curriculum-guided-plan.json`,
    textbook_point_count: sourcePoints.length,
    requirement_count: requirementIds.length,
  });

  return { root, contentRoot, index };
}

test("教材加大纲的确定性短流程在 G2 知识点清单 pending 处停止", (t) => {
  const { root, contentRoot, index } = createGuidedWorkspace(t);

  const synced = run(GUIDED_VALIDATOR, ["manifest", COURSE_ID], root);
  assert.equal(synced.status, 0, `${synced.stdout}\n${synced.stderr}`);
  assert.equal(JSON.parse(synced.stdout).status, "valid");

  const validated = run(GUIDED_VALIDATOR, ["plan", COURSE_ID], root);
  assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`);
  assert.equal(JSON.parse(validated.stdout).pointCount, index.points.length);

  const delivered = run(
    PREPARE_REVIEW,
    ["knowledge-points", COURSE_ID],
    root,
  );
  assert.equal(delivered.status, 0, `${delivered.stdout}\n${delivered.stderr}`);
  const result = JSON.parse(delivered.stdout);
  assert.equal(result.status, "pending");
  assert.equal(result.gate, "G2_IDENTITY_REVIEW");
  assert.match(result.curriculumGuidanceSha256, /^[0-9a-f]{64}$/);

  const request = readJson(path.join(root, result.requestFile));
  assert.equal(request.kind, "knowledge-points");
  assert.equal(request.gate, "G2_IDENTITY_REVIEW");
  assert.equal(
    readJson(path.join(contentRoot, "generation", "manifest.json"))
      .generation.guidanceMode,
    "curriculum-guided",
  );
  assert.equal(
    readdirSync(path.join(root, "pipeline", COURSE_ID)).includes("clustered-graph.json"),
    false,
  );
});
