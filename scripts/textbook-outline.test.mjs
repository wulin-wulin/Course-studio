import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { textbookStructureSha256 } from "../skills/knowledge-pipeline-orchestrator/scripts/textbook-structure.mjs";

const SCRIPT = path.resolve("scripts", "validate-textbook-outline.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function markdownSlice(lines, lineStart, lineEnd) {
  const excerpt = lines.slice(lineStart - 1, lineEnd).join("\n");
  return excerpt + (lineEnd < lines.length ? "\n" : "");
}

function fixture(root) {
  const courseId = "textbook-demo";
  const courseRoot = path.join(root, "pipeline", courseId);
  const outline = {
    schema_version: "textbook-outline/1.0",
    document_id: "doc-123",
    course: { id: courseId, title: "教材演示" },
    source: { filename: "demo.pdf", sha256: "a".repeat(64), parser: "local-pdf" },
    chapters: [
      {
        id: "chapter-1",
        title: "第一章",
        order: 0,
        points: [
          { id: "alpha", title: "Alpha", order: 0, origin: "textbook", page: 3 },
          {
            id: "alpha-extension",
            title: "Alpha 扩展",
            order: 1,
            origin: "llm-extension",
            anchor_point_id: "alpha",
            extension_reason: "补充必要应用",
          },
        ],
      },
      {
        id: "chapter-2",
        title: "第二章",
        order: 1,
        points: [
          { id: "beta", title: "Beta", order: 0, origin: "textbook", page: 11 },
        ],
      },
    ],
  };
  const points = outline.chapters.flatMap((chapter) => chapter.points).map((point) => ({
    id: point.id,
    title: point.title,
  }));
  writeJson(path.join(courseRoot, "textbook-outline.json"), outline);
  writeJson(path.join(root, "textbook-input", outline.document_id, "outline.json"), {
    ...structuredClone(outline),
    chapters: outline.chapters.map((chapter) => ({
      ...structuredClone(chapter),
      points: chapter.points
        .filter((point) => point.origin === "textbook")
        .map((point, index) => ({ ...structuredClone(point), order: index })),
    })),
  });
  writeJson(path.join(courseRoot, "course-content", "src", "data", "index.json"), {
    schema_version: "course-content-index/1.0",
    courseId,
    points,
  });
  writeJson(path.join(courseRoot, "clustered-graph.json"), {
    schema_version: "clustered-graph/2.0",
    clusters: outline.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title })),
    points: outline.chapters.flatMap((chapter) => chapter.points.map((point) => ({
      id: point.id,
      clusterIds: [chapter.id],
    }))),
  });
  return { courseId, courseRoot, outline };
}

function markdownFixture(root) {
  const base = fixture(root);
  const { courseId, courseRoot } = base;
  const outlinePath = path.join(courseRoot, "textbook-outline.json");
  const outline = readJson(outlinePath);
  outline.source = {
    filename: "demo.md",
    sha256: "b".repeat(64),
    parser: "markdown-import",
  };
  // A standalone Markdown import has no trustworthy PDF page mapping.
  outline.chapters[0].points[0].page = null;
  outline.chapters[1].points[0].page = null;
  outline.chapters[0].points[0].source_refs = ["block-000001", "block-000002"];
  outline.chapters[1].points[0].source_refs = ["block-000003", "block-000004"];
  writeJson(outlinePath, outline);

  const inputOutline = structuredClone(outline);
  inputOutline.chapters = outline.chapters.map((chapter) => ({
    ...structuredClone(chapter),
    points: chapter.points
      .filter((point) => point.origin === "textbook")
      .map((point, index) => ({ ...structuredClone(point), order: index })),
  }));
  const documentRoot = path.join(root, "textbook-input", outline.document_id);
  writeJson(path.join(documentRoot, "outline.json"), inputOutline);

  const markdown = [
    "# 教材演示",
    "",
    "## 第一章",
    "第一章导言。",
    "",
    "### Alpha",
    "Alpha 是第一章的核心概念。",
    "",
    "## 第二章",
    "第二章导言。",
    "",
    "### Beta",
    "Beta 承接 Alpha 并形成完整流程。",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(documentRoot, "full.md"), markdown, "utf8");
  const lines = markdown.split("\n");
  const sectionSpecs = [
    ["block-000001", "第一章", 2, ["第一章"], 3, 5],
    ["block-000002", "Alpha", 3, ["第一章", "Alpha"], 6, 8],
    ["block-000003", "第二章", 2, ["第二章"], 9, 11],
    ["block-000004", "Beta", 3, ["第二章", "Beta"], 12, 14],
  ];
  const sections = sectionSpecs.map(([
    id,
    title,
    headingLevel,
    headingPath,
    lineStart,
    lineEnd,
  ], index) => ({
    id,
    order: index,
    type: "section",
    title,
    heading_level: headingLevel,
    heading_path: headingPath,
    line_start: lineStart,
    line_end: lineEnd,
    page: null,
    asset_refs: [],
    sha256: sha256(markdownSlice(lines, lineStart, lineEnd)),
  }));
  const chunks = sections.map((section, index) => ({
    id: `chunk-${String(index + 1).padStart(6, "0")}`,
    order: index,
    section_ids: [section.id],
    heading_path: [...section.heading_path],
    line_start: section.line_start,
    line_end: section.line_end,
    page: null,
    asset_refs: [],
    sha256: section.sha256,
  }));
  const material = {
    schema_version: "textbook-material/1.0",
    document_id: outline.document_id,
    source: {
      format: "markdown",
      filename: "demo.md",
      sha256: outline.source.sha256,
      parser: "markdown-import",
    },
    markdown: {
      path: "full.md",
      sha256: sha256(markdown),
      line_count: lines.length,
      character_count: [...markdown].length,
    },
    sections,
    chunks,
    point_sources: [
      {
        point_id: "alpha",
        section_ids: ["block-000001", "block-000002"],
        chunk_ids: ["chunk-000001", "chunk-000002"],
      },
      {
        point_id: "beta",
        section_ids: ["block-000003", "block-000004"],
        chunk_ids: ["chunk-000003", "chunk-000004"],
      },
    ],
  };
  const materialPath = path.join(documentRoot, "material.json");
  writeJson(materialPath, material);

  const materialRelative = `textbook-input/${outline.document_id}/material.json`;
  const markdownRelative = `textbook-input/${outline.document_id}/full.md`;
  writeJson(path.join(root, "textbook-binding.json"), {
    schema_version: "textbook-binding/1.0",
    document_id: outline.document_id,
    course_id: courseId,
    title: outline.course.title,
    structure_sha256: textbookStructureSha256(inputOutline, { courseId }),
    input_outline_path: `textbook-input/${outline.document_id}/outline.json`,
    output_outline_path: `pipeline/${courseId}/textbook-outline.json`,
    input_material_path: materialRelative,
    input_markdown_path: markdownRelative,
    chapter_count: outline.chapters.length,
    point_count: outline.chapters.flatMap((chapter) => chapter.points).length,
  });

  function sourceSpan(blockIds, headingPath, lineStart, lineEnd) {
    return {
      materialId: outline.document_id,
      blockIds,
      headingPath,
      lineStart,
      lineEnd,
      assetRefs: [],
      excerptSha256: sha256(markdownSlice(lines, lineStart, lineEnd)),
    };
  }
  const provenance = new Map([
    ["alpha", {
      origin: "textbook",
      sourceSpans: [sourceSpan(
        ["block-000001", "block-000002"],
        ["第一章"],
        3,
        8,
      )],
      modelEnriched: true,
    }],
    ["alpha-extension", {
      origin: "llm-extension",
      sourceSpans: [],
      modelEnriched: true,
    }],
    ["beta", {
      origin: "textbook",
      sourceSpans: [sourceSpan(
        ["block-000003", "block-000004"],
        ["第二章"],
        9,
        14,
      )],
      modelEnriched: true,
    }],
  ]);
  const outlinePoints = outline.chapters.flatMap((chapter) => chapter.points);
  const manifest = {
    schema_version: "course-content-generation/1.0",
    subject: { id: courseId },
    generation: {
      evidenceMode: "textbook-grounded",
      generatedAt: "2026-10-22",
      pointCount: outlinePoints.length,
    },
    sources: [{
      id: "src-textbook",
      type: "textbook",
      title: "教材演示",
      locator: materialRelative,
      accessedAt: "2026-10-22",
    }],
    pointEvidence: outlinePoints.map((point) => ({
      pointId: point.id,
      title: point.title,
      kind: "concept",
      sourceRefs: point.origin === "textbook" ? ["src-textbook"] : [],
      confidence: point.origin === "textbook" ? 0.9 : 0.7,
      scopeStatus: "core",
      ...structuredClone(provenance.get(point.id)),
    })),
    reviewQueue: [],
  };
  const manifestPath = path.join(courseRoot, "course-content", "generation", "manifest.json");
  writeJson(manifestPath, manifest);

  const pointsRoot = path.join(courseRoot, "course-content", "src", "data", "points");
  for (const point of outlinePoints) {
    writeJson(path.join(pointsRoot, `${point.id}.json`), {
      id: point.id,
      title: point.title,
      ...structuredClone(provenance.get(point.id)),
    });
  }

  const graphPath = path.join(courseRoot, "clustered-graph.json");
  const graph = readJson(graphPath);
  graph.points = graph.points.map((point) => ({
    ...point,
    ...structuredClone(provenance.get(point.id)),
  }));
  graph.sequences = {
    cluster: [{ fromId: "chapter-1", toId: "chapter-2" }],
    point: [{ fromId: "alpha", toId: "alpha-extension" }],
  };
  writeJson(graphPath, graph);

  const indexPath = path.join(courseRoot, "course-content", "src", "data", "index.json");
  const index = readJson(indexPath);
  index.points = index.points.map((point) => ({
    ...point,
    origin: provenance.get(point.id).origin,
  }));
  writeJson(indexPath, index);

  return {
    ...base,
    outline,
    documentRoot,
    materialPath,
    manifestPath,
    graphPath,
    pointsRoot,
  };
}

function upgradeMarkdownFixtureToTextbookContentV2(context) {
  const manifest = readJson(context.manifestPath);
  manifest.generation.contentContract = "textbook-content/2.0";
  const anchorSpans = structuredClone(manifest.pointEvidence[0].sourceSpans);
  const contentById = new Map();
  for (const evidence of manifest.pointEvidence) {
    if (evidence.sourceSpans.length === 0) {
      evidence.sourceSpans = structuredClone(anchorSpans);
    }
    delete evidence.modelEnriched;
    const content = {
      schema_version: "textbook-content/2.0",
      blocks: [
        {
          id: "textbook-context",
          kind: "explanation",
          title: evidence.origin === "textbook" ? "教材说明" : "教材锚点上下文",
          markdown: evidence.origin === "textbook"
            ? `教材对 ${evidence.title} 给出了定义与范围。`
            : `教材中的 Alpha 是扩展 ${evidence.title} 的上下文锚点。`,
          provenance: {
            origin: "textbook",
            representation: "paraphrase",
            sourceSpans: structuredClone(evidence.sourceSpans),
          },
        },
        {
          id: "model-example",
          kind: "example",
          title: "模型补充示例",
          markdown: `根据教材上下文补充 ${evidence.title} 的新示例。`,
          provenance: {
            origin: "model",
            basedOnBlockIds: ["textbook-context"],
          },
        },
      ],
    };
    contentById.set(evidence.pointId, content);
  }
  writeJson(context.manifestPath, manifest);

  for (const evidence of manifest.pointEvidence) {
    const pointPath = path.join(context.pointsRoot, `${evidence.pointId}.json`);
    const point = readJson(pointPath);
    delete point.sourceSpans;
    delete point.modelEnriched;
    point.content = structuredClone(contentById.get(evidence.pointId));
    writeJson(pointPath, point);
  }

  const graph = readJson(context.graphPath);
  graph.schema_version = "clustered-graph/3.0";
  graph.points = graph.points.map((point) => ({
    id: point.id,
    title: point.title,
    origin: manifest.pointEvidence.find((item) => item.pointId === point.id).origin,
    clusterIds: point.clusterIds,
    role: point.role,
    prerequisites: point.prerequisites ?? [],
    related: point.related ?? [],
  }));
  writeJson(context.graphPath, graph);
  return context;
}

function run(root, mode, courseId) {
  return spawnSync(process.execPath, [SCRIPT, mode, courseId], {
    cwd: root,
    encoding: "utf8",
  });
}

test("validates the frozen two-level outline and graph mapping", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId } = fixture(root);
    assert.equal(run(root, "outline", courseId).status, 0);
    assert.equal(run(root, "graph", courseId).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a bound legacy PDF valid without material, provenance, or sequences", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-pdf-"));
  try {
    const { courseId, outline } = fixture(root);
    const inputOutline = readJson(
      path.join(root, "textbook-input", outline.document_id, "outline.json"),
    );
    writeJson(path.join(root, "textbook-binding.json"), {
      schema_version: "textbook-binding/1.0",
      document_id: outline.document_id,
      course_id: courseId,
      title: outline.course.title,
      structure_sha256: textbookStructureSha256(inputOutline, { courseId }),
      input_outline_path: `textbook-input/${outline.document_id}/outline.json`,
      output_outline_path: `pipeline/${courseId}/textbook-outline.json`,
      chapter_count: outline.chapters.length,
      point_count: outline.chapters.flatMap((chapter) => chapter.points).length,
    });
    const outlineResult = run(root, "outline", courseId);
    assert.equal(outlineResult.status, 0, outlineResult.stderr);
    const graphResult = run(root, "graph", courseId);
    assert.equal(graphResult.status, 0, graphResult.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validates Markdown material, grounded provenance, point details, and sequences", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-markdown-"));
  try {
    const { courseId } = markdownFixture(root);
    const outlineResult = run(root, "outline", courseId);
    assert.equal(outlineResult.status, 0, outlineResult.stderr);
    const graphResult = run(root, "graph", courseId);
    assert.equal(graphResult.status, 0, graphResult.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validates textbook-content/2.0 block spans against the bound Markdown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-content-v2-"));
  try {
    const context = upgradeMarkdownFixtureToTextbookContentV2(markdownFixture(root));
    const outlineResult = run(root, "outline", context.courseId);
    assert.equal(outlineResult.status, 0, outlineResult.stderr);
    const graphResult = run(root, "graph", context.courseId);
    assert.equal(graphResult.status, 0, graphResult.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a textbook-content/2.0 block span whose digest drifts from full.md", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-content-v2-"));
  try {
    const context = upgradeMarkdownFixtureToTextbookContentV2(markdownFixture(root));
    const pointPath = path.join(context.pointsRoot, "alpha.json");
    const point = readJson(pointPath);
    point.content.blocks[0].provenance.sourceSpans[0].excerptSha256 = "f".repeat(64);
    writeJson(pointPath, point);
    const result = run(root, "graph", context.courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /excerptSha256 与 full\.md 对应行不一致/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a textbook-content/2.0 evidence plan that omits mapped textbook sections", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-content-v2-coverage-"));
  try {
    const context = upgradeMarkdownFixtureToTextbookContentV2(markdownFixture(root));
    const manifest = readJson(context.manifestPath);
    const span = manifest.pointEvidence[0].sourceSpans[0];
    span.blockIds = ["block-000001"];
    span.lineStart = 3;
    span.lineEnd = 5;
    const lines = fs.readFileSync(path.join(context.documentRoot, "full.md"), "utf8").split("\n");
    span.excerptSha256 = sha256(markdownSlice(lines, span.lineStart, span.lineEnd));
    writeJson(context.manifestPath, manifest);

    const result = run(root, "outline", context.courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /必须按 material\.point_sources 顺序完整覆盖.*section_ids/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a textbook-content/2.0 evidence plan that cites but only partially reads a section", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-content-v2-lines-"));
  try {
    const context = upgradeMarkdownFixtureToTextbookContentV2(markdownFixture(root));
    const manifest = readJson(context.manifestPath);
    const span = manifest.pointEvidence[0].sourceSpans[0];
    span.lineEnd = 7;
    const lines = fs.readFileSync(path.join(context.documentRoot, "full.md"), "utf8").split("\n");
    span.excerptSha256 = sha256(markdownSlice(lines, span.lineStart, span.lineEnd));
    writeJson(context.manifestPath, manifest);

    const result = run(root, "outline", context.courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未完整覆盖教材知识点 alpha 的 section block-000002 正文行/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires full textbook coverage in textbook blocks rather than model-only citations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-content-v2-blocks-"));
  try {
    const context = upgradeMarkdownFixtureToTextbookContentV2(markdownFixture(root));
    const lines = fs.readFileSync(path.join(context.documentRoot, "full.md"), "utf8").split("\n");
    const combined = readJson(context.manifestPath).pointEvidence[0].sourceSpans[0];
    const first = {
      ...structuredClone(combined),
      blockIds: ["block-000001"],
      lineStart: 3,
      lineEnd: 5,
      excerptSha256: sha256(markdownSlice(lines, 3, 5)),
    };
    const second = {
      ...structuredClone(combined),
      blockIds: ["block-000002"],
      headingPath: ["第一章", "Alpha"],
      lineStart: 6,
      lineEnd: 8,
      excerptSha256: sha256(markdownSlice(lines, 6, 8)),
    };

    const manifest = readJson(context.manifestPath);
    manifest.pointEvidence[0].sourceSpans = [first, second];
    writeJson(context.manifestPath, manifest);
    const pointPath = path.join(context.pointsRoot, "alpha.json");
    const point = readJson(pointPath);
    point.content.blocks[0].provenance.sourceSpans = [first];
    point.content.blocks[1].provenance.sourceSpans = [second];
    writeJson(pointPath, point);

    const result = run(root, "graph", context.courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材内容块\s+必须按 material\.point_sources 顺序完整覆盖/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a Markdown binding that declares only one material path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-markdown-"));
  try {
    const { courseId } = markdownFixture(root);
    const bindingPath = path.join(root, "textbook-binding.json");
    const binding = readJson(bindingPath);
    delete binding.input_markdown_path;
    writeJson(bindingPath, binding);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /同时声明 input_material_path 和 input_markdown_path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const testCase of [
  {
    name: "rejects the wrong material schema",
    mutate({ materialPath }) {
      const material = readJson(materialPath);
      material.schema_version = "textbook-material/9.9";
      writeJson(materialPath, material);
    },
    pattern: /material\.schema_version/,
  },
  {
    name: "rejects a material document id that differs from the outline",
    mutate({ materialPath }) {
      const material = readJson(materialPath);
      material.document_id = "doc-other";
      writeJson(materialPath, material);
    },
    pattern: /material\.document_id/,
  },
  {
    name: "rejects a Markdown digest that does not match full.md",
    mutate({ materialPath }) {
      const material = readJson(materialPath);
      material.markdown.sha256 = "c".repeat(64);
      writeJson(materialPath, material);
    },
    pattern: /material\.markdown\.sha256/,
  },
  {
    name: "rejects a Markdown line count that does not match full.md",
    mutate({ materialPath }) {
      const material = readJson(materialPath);
      material.markdown.line_count += 1;
      writeJson(materialPath, material);
    },
    pattern: /material\.markdown\.line_count/,
  },
  {
    name: "rejects a section line range outside full.md",
    mutate({ materialPath }) {
      const material = readJson(materialPath);
      material.sections[0].line_end = 999;
      writeJson(materialPath, material);
    },
    pattern: /line_start\/line_end/,
  },
  {
    name: "rejects a section digest that does not match its Markdown lines",
    mutate({ materialPath }) {
      const material = readJson(materialPath);
      material.sections[0].sha256 = "d".repeat(64);
      writeJson(materialPath, material);
    },
    pattern: /material\.sections\[0\]\.sha256/,
  },
  {
    name: "rejects a chunk that references an unknown section",
    mutate({ materialPath }) {
      const material = readJson(materialPath);
      material.chunks[0].section_ids = ["block-missing"];
      writeJson(materialPath, material);
    },
    pattern: /chunks\[0\]\.section_ids/,
  },
  {
    name: "rejects point_sources that reference an unknown chunk",
    mutate({ materialPath }) {
      const material = readJson(materialPath);
      material.point_sources[0].chunk_ids = ["chunk-missing"];
      writeJson(materialPath, material);
    },
    pattern: /point_sources\[0\]\.chunk_ids/,
  },
]) {
  test(testCase.name, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-material-"));
    try {
      const context = markdownFixture(root);
      testCase.mutate(context);
      const result = run(root, "outline", context.courseId);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, testCase.pattern);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("rejects textbook source_refs that do not hit the point_sources mapping", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-material-"));
  try {
    const { courseId, courseRoot } = markdownFixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = readJson(outlinePath);
    outline.chapters[0].points[0].source_refs = ["block-000003"];
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source_refs 必须全部来自对应 point_sources/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects textbook source_refs that mix mapped and unrelated blocks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-material-"));
  try {
    const { courseId, courseRoot } = markdownFixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = readJson(outlinePath);
    outline.chapters[0].points[0].source_refs = ["block-000001", "block-000003"];
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source_refs 必须全部来自对应 point_sources/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const testCase of [
  {
    name: "rejects a Markdown manifest without textbook-grounded mode",
    mutate(manifest) {
      manifest.generation.evidenceMode = "model-only";
    },
    pattern: /evidenceMode=textbook-grounded/,
  },
  {
    name: "rejects manifest origin that differs from the outline",
    mutate(manifest) {
      manifest.pointEvidence[0].origin = "llm-extension";
    },
    pattern: /pointEvidence\[0\]\.origin/,
  },
  {
    name: "rejects a textbook point without model enrichment",
    mutate(manifest) {
      manifest.pointEvidence[0].modelEnriched = false;
    },
    pattern: /pointEvidence\[0\]\.modelEnriched 必须为 true/,
  },
  {
    name: "rejects an LLM extension point without model enrichment",
    mutate(manifest) {
      manifest.pointEvidence[1].modelEnriched = false;
    },
    pattern: /pointEvidence\[1\]\.modelEnriched 必须为 true/,
  },
  {
    name: "rejects a textbook point without a textbook sourceRef",
    mutate(manifest) {
      manifest.pointEvidence[0].sourceRefs = [];
    },
    pattern: /textbook sourceRef/,
  },
  {
    name: "rejects a textbook point without a sourceSpan",
    mutate(manifest) {
      manifest.pointEvidence[0].sourceSpans = [];
    },
    pattern: /至少需要一个 sourceSpan/,
  },
  {
    name: "rejects a sourceSpan for another material id",
    mutate(manifest) {
      manifest.pointEvidence[0].sourceSpans[0].materialId = "doc-other";
    },
    pattern: /materialId 必须等于教材 document_id/,
  },
  {
    name: "rejects a sourceSpan that references an unknown block",
    mutate(manifest) {
      manifest.pointEvidence[0].sourceSpans[0].blockIds = ["block-missing"];
    },
    pattern: /blockIds 引用了不存在的 material block/,
  },
  {
    name: "rejects a sourceSpan that mixes mapped and unrelated blocks",
    mutate(manifest, context) {
      const span = manifest.pointEvidence[0].sourceSpans[0];
      span.blockIds = ["block-000001", "block-000003"];
      span.lineStart = 3;
      span.lineEnd = 11;
      const lines = fs.readFileSync(path.join(context.documentRoot, "full.md"), "utf8").split("\n");
      span.excerptSha256 = sha256(markdownSlice(lines, span.lineStart, span.lineEnd));
    },
    pattern: /blockIds 必须全部来自知识点 alpha 的 point_sources/,
  },
  {
    name: "rejects a sourceSpan line range outside its blocks",
    mutate(manifest) {
      manifest.pointEvidence[0].sourceSpans[0].lineStart = 1;
    },
    pattern: /行范围与 blockIds 不一致/,
  },
  {
    name: "rejects a sourceSpan digest that does not match full.md",
    mutate(manifest) {
      manifest.pointEvidence[0].sourceSpans[0].excerptSha256 = "e".repeat(64);
    },
    pattern: /excerptSha256 与 full\.md 对应行不一致/,
  },
]) {
  test(testCase.name, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-provenance-"));
    try {
      const context = markdownFixture(root);
      const manifest = readJson(context.manifestPath);
      testCase.mutate(manifest, context);
      writeJson(context.manifestPath, manifest);
      const result = run(root, "outline", context.courseId);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, testCase.pattern);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const testCase of [
  {
    name: "rejects graph provenance that differs from the manifest",
    mutate(context) {
      const graph = readJson(context.graphPath);
      graph.points[0].modelEnriched = false;
      writeJson(context.graphPath, graph);
    },
    pattern: /图谱知识点 alpha 的 modelEnriched 与 manifest 不一致/,
  },
  {
    name: "rejects point detail provenance that differs from the manifest",
    mutate(context) {
      const pointPath = path.join(context.pointsRoot, "alpha.json");
      const point = readJson(pointPath);
      point.sourceSpans = [];
      writeJson(pointPath, point);
    },
    pattern: /知识点详情 alpha 的 sourceSpans 与 manifest 不一致/,
  },
  {
    name: "rejects a point detail without the model enrichment declared by the manifest",
    mutate(context) {
      const pointPath = path.join(context.pointsRoot, "alpha.json");
      const point = readJson(pointPath);
      point.modelEnriched = false;
      writeJson(pointPath, point);
    },
    pattern: /知识点详情 alpha 的 modelEnriched 与 manifest 不一致/,
  },
  {
    name: "rejects a graph without adjacent chapter sequence coverage",
    mutate(context) {
      const graph = readJson(context.graphPath);
      graph.sequences.cluster = [];
      writeJson(context.graphPath, graph);
    },
    pattern: /sequences\.cluster 缺少相邻章节顺序/,
  },
  {
    name: "rejects a graph without adjacent in-chapter point sequence coverage",
    mutate(context) {
      const graph = readJson(context.graphPath);
      graph.sequences.point = [];
      writeJson(context.graphPath, graph);
    },
    pattern: /sequences\.point 缺少同章相邻知识点顺序/,
  },
]) {
  test(testCase.name, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-graph-"));
    try {
      const context = markdownFixture(root);
      testCase.mutate(context);
      const result = run(root, "graph", context.courseId);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, testCase.pattern);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("rejects an index order that diverges from the textbook tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const indexPath = path.join(courseRoot, "course-content", "src", "data", "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.points.reverse();
    writeJson(indexPath, index);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /顺序、ID 或标题不一致/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an index origin that diverges from the textbook tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const indexPath = path.join(courseRoot, "course-content", "src", "data", "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.points[0].origin = "llm-extension";
    writeJson(indexPath, index);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /顺序、ID 或标题不一致/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects graph clustering that changes a textbook chapter", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const graphPath = path.join(courseRoot, "clustered-graph.json");
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
    graph.points[0].clusterIds = ["chapter-2"];
    writeJson(graphPath, graph);
    const result = run(root, "graph", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /主知识簇不是教材章节/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects changing an original textbook title while keeping the sidecar valid", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
    outline.chapters[0].points[0].title = "被改写的教材点";
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材原始结构不可变校验失败/);
    assert.match(result.stderr, /ID、顺序、标题或 origin/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects changing an original textbook page locator", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
    outline.chapters[0].points[0].page = 99;
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材原始结构不可变校验失败/);
    assert.match(result.stderr, /page 已被修改/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects changing the numeric order of an original textbook point", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
    outline.chapters[0].points[0].order = 1;
    outline.chapters[0].points[1].order = 2;
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材原始结构不可变校验失败/);
    assert.match(result.stderr, /被移动到其他章节|顺序/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a new point that pretends to be textbook content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, courseRoot } = fixture(root);
    const outlinePath = path.join(courseRoot, "textbook-outline.json");
    const outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
    outline.chapters[1].points.push({
      id: "invented-textbook-point",
      title: "伪造教材点",
      order: 1,
      origin: "textbook",
    });
    writeJson(outlinePath, outline);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材原始结构不可变校验失败/);
    assert.match(result.stderr, /受控扩展/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a tampered immutable input order even when the workflow sidecar is unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, outline } = fixture(root);
    const inputPath = path.join(root, "textbook-input", outline.document_id, "outline.json");
    const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    input.chapters[0].points[0].order = 9;
    writeJson(inputPath, input);
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /教材输入知识点 .*order/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked textbook input parent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-outline-"));
  try {
    const { courseId, outline } = fixture(root);
    const inputRoot = path.join(root, "textbook-input");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "textbook-input-outside-"));
    const outsideDocumentRoot = path.join(outside, outline.document_id);
    fs.mkdirSync(outsideDocumentRoot, { recursive: true });
    fs.copyFileSync(
      path.join(inputRoot, outline.document_id, "outline.json"),
      path.join(outsideDocumentRoot, "outline.json"),
    );
    fs.rmSync(inputRoot, { recursive: true, force: true });
    try {
      // Junctions are available on Windows without requiring Developer Mode;
      // on platforms without symlink support this regression is skipped.
      fs.symlinkSync(outside, inputRoot, "junction");
    } catch (error) {
      t.skip(`symbolic links unavailable: ${error.message}`);
      return;
    }
    const result = run(root, "outline", courseId);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不允许符号链接/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
