import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCourseData,
  deriveCompatibilityMetadata,
  loadCanonicalPoints,
} from "./publish-course-pipeline.mjs";

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourceSpan() {
  return {
    materialId: "doc-textbook",
    blockIds: ["block-001"],
    headingPath: ["第一章", "有限状态"],
    lineStart: 10,
    lineEnd: 18,
    page: 3,
    assetRefs: [],
    excerptSha256: "a".repeat(64),
  };
}

function canonicalPoint(id = "finite-state") {
  const span = sourceSpan();
  return {
    id,
    title: "有限状态",
    shortSummary: "有限状态把系统在某一时刻所需的信息压缩为可区分、可验证并可参与后续转移的离散描述。",
    keyTerms: ["状态", "状态空间"],
    animationType: "none",
    difficulty: "基础",
    importance: 0.9,
    prerequisites: [],
    origin: "textbook",
    content: {
      schema_version: "textbook-content/2.0",
      blocks: [
        {
          id: "textbook-definition",
          kind: "definition",
          title: "教材定义",
          markdown: "教材将状态定义为足以决定后续行为的系统信息集合。",
          provenance: {
            origin: "textbook",
            representation: "paraphrase",
            sourceSpans: [span],
          },
        },
        {
          id: "model-example",
          kind: "example",
          title: "补充示例",
          markdown: "把交通灯颜色视为三个离散状态，可以直接列出所有合法转移。",
          provenance: {
            origin: "model",
            basedOnBlockIds: ["textbook-definition"],
            sourceSpans: [{
              excerptSha256: span.excerptSha256,
              assetRefs: [],
              page: 3,
              lineEnd: 18,
              lineStart: 10,
              headingPath: ["第一章", "有限状态"],
              blockIds: ["block-001"],
              materialId: "doc-textbook",
            }],
          },
        },
      ],
    },
  };
}

function graph() {
  return {
    schema_version: "clustered-graph/3.0",
    subject: {
      id: "state-machines",
      scope: "覆盖状态与转移的教材内容",
    },
    generation: {
      generatedAt: "2026-10-22",
      sourceCourseId: "state-machines",
      pointCount: 1,
      clusterCount: 1,
      brokenCycleEdges: [],
      refinedPrerequisiteEdges: [],
    },
    clusters: [{
      id: "chapter-one",
      title: "第一章",
      subtitle: "状态基础",
      description: "建立状态机的基本描述。",
      order: 0,
    }],
    sequences: { cluster: [], point: [] },
    points: [{
      id: "finite-state",
      title: "有限状态",
      origin: "textbook",
      clusterIds: ["chapter-one"],
      role: "trunk",
      prerequisites: [],
      related: [],
    }],
  };
}

test("发布边界从 content.blocks 稳定派生兼容证据字段", () => {
  const metadata = deriveCompatibilityMetadata(canonicalPoint());
  assert.deepEqual(metadata.sourceSpans, [sourceSpan()]);
  assert.equal(metadata.modelEnriched, true);
});

test("clustered-graph/3.0 发布时合并 canonical 正文与薄图关系且正文不变", () => {
  const canonical = canonicalPoint();
  const originalContent = structuredClone(canonical.content);
  const thinGraph = graph();
  const graphBefore = structuredClone(thinGraph);
  const sourceCourse = {
    id: "state-machines",
    title: "状态机基础",
    version: "0.2.0",
  };
  const manifest = {
    subject: thinGraph.subject,
    generation: { contentContract: "textbook-content/2.0" },
    pointEvidence: [{ pointId: canonical.id, kind: "concept" }],
  };

  const result = buildCourseData(
    "state-machines",
    sourceCourse,
    manifest,
    thinGraph,
    [canonical],
  );

  assert.equal(result.details.length, 1);
  const detail = result.details[0];
  assert.deepEqual(detail.content, originalContent);
  assert.deepEqual(canonical.content, originalContent);
  assert.deepEqual(thinGraph, graphBefore);
  assert.deepEqual(detail.sourceSpans, [sourceSpan()]);
  assert.equal(detail.modelEnriched, true);
  assert.equal(detail.clusterId, "chapter-one");
  assert.deepEqual(detail.clusterIds, ["chapter-one"]);
  assert.equal(detail.role, "trunk");
  assert.deepEqual(detail.prerequisites, []);
  assert.equal(detail.kind, "concept");
  assert.equal(result.index.points[0].shortSummary, canonical.shortSummary);
  assert.deepEqual(result.index.points[0].keyTerms, canonical.keyTerms);
});

test("publisher 按 canonical index 顺序读取 point 文件并拒绝图谱顺序漂移", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "publisher-canonical-points-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = canonicalPoint();
  writeJson(path.join(root, "src/data/index.json"), {
    courseId: "state-machines",
    points: [{ id: canonical.id, title: canonical.title }],
  });
  writeJson(path.join(root, "src/data/points", `${canonical.id}.json`), canonical);

  assert.deepEqual(loadCanonicalPoints(root, graph()), [canonical]);
  const changed = graph();
  changed.points[0].id = "different-point";
  assert.throws(
    () => loadCanonicalPoints(root, changed),
    /canonical index 保持相同知识点和顺序/,
  );
});
