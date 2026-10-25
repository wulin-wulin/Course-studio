import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildAnimationRegistry } from '../../candidate-knowledge-point-generator/scripts/build_animation_registry.mjs';
import {
  createCourseFixture,
  readJson,
  writeJson,
} from '../../candidate-knowledge-point-generator/scripts/test-fixture.mjs';
import { checkPipeline } from './check-pipeline.mjs';

const LEGACY_CONTENT_FIELDS = [
  'coreIdea', 'principles', 'formula', 'comparisons', 'applications', 'aliases',
  'intuition', 'misconceptions', 'history', 'yearIntroduced', 'prosCons', 'qa',
  'visualType', 'visualSuggestion', 'sourceSpans', 'modelEnriched',
];

function span(index) {
  return {
    materialId: 'doc-textbook',
    blockIds: [`block-${index + 1}`],
    headingPath: ['第一章', `知识点 ${index + 1}`],
    lineStart: index * 10 + 1,
    lineEnd: index * 10 + 8,
    page: index + 1,
    assetRefs: [],
    excerptSha256: String(index + 1).repeat(64),
  };
}

function configureTextbookV2(root) {
  const manifest = readJson(root, 'generation/manifest.json');
  manifest.generation.evidenceMode = 'textbook-grounded';
  manifest.generation.contentContract = 'textbook-content/2.0';
  manifest.sources = [{
    id: 'src-textbook',
    type: 'textbook',
    title: '状态机教材',
    locator: 'doc-textbook',
    accessedAt: '2026-10-22',
  }];
  manifest.pointEvidence.forEach((evidence, index) => {
    evidence.sourceRefs = ['src-textbook'];
    evidence.confidence = 0.9;
    evidence.origin = 'textbook';
    evidence.sourceSpans = [span(index)];
    delete evidence.modelEnriched;

    const relativePath = `src/data/points/${evidence.pointId}.json`;
    const point = readJson(root, relativePath);
    for (const field of LEGACY_CONTENT_FIELDS) delete point[field];
    point.origin = 'textbook';
    point.content = {
      schema_version: 'textbook-content/2.0',
      learningDesign: {
        primaryPattern: 'concept-example-check',
        adaptationLevel: 'balanced',
        editorialPolicy: '保持教材事实与边界，围绕迁移目标补充例题。',
        estimatedMinutes: 10,
        outcomes: [{ id: 'explain-concept', text: '解释概念及其适用边界。' }],
        misconceptions: [],
        modules: [{
          id: 'concept-and-example',
          title: '概念与示例',
          outcomeRefs: ['explain-concept'],
          order: 0,
        }],
        completion: {
          outcomeRefs: ['explain-concept'],
          method: '说明定义，并判断新情境是否满足适用条件。',
          successCriteria: ['定义准确', '判断依据清楚'],
        },
      },
      blocks: [
        {
          id: 'textbook-explanation',
          moduleId: 'concept-and-example',
          depth: 'core',
          kind: 'explanation',
          title: '教材说明',
          markdown: `教材解释了${point.title}的定义、边界和适用条件。`,
          provenance: {
            origin: 'textbook',
            representation: 'paraphrase',
            sourceSpans: [span(index)],
          },
        },
        {
          id: 'model-example',
          moduleId: 'concept-and-example',
          depth: 'core',
          kind: 'example',
          title: '补充示例',
          markdown: `使用一个新情境演示${point.title}，并说明容易混淆的边界。`,
          provenance: {
            origin: 'model',
            basedOnBlockIds: ['textbook-explanation'],
          },
        },
      ],
    };
    writeJson(root, relativePath, point);
  });
  writeJson(root, 'generation/manifest.json', manifest);
  buildAnimationRegistry(root);
  return manifest;
}

function makeThinGraph(root, manifest) {
  const index = readJson(root, 'src/data/index.json');
  const points = index.points.map(({ id }, pointIndex) => {
    const point = readJson(root, `src/data/points/${id}.json`);
    return {
      id,
      title: point.title,
      origin: point.origin,
      clusterIds: ['chapter-one'],
      role: pointIndex === 0 ? 'trunk' : 'branch',
      prerequisites: [...point.prerequisites],
      related: [],
    };
  });
  // Avoid referring to the array while it is being initialized.
  points.forEach((point, indexValue) => {
    point.role = indexValue === 0 ? 'trunk' : indexValue === points.length - 1 ? 'leaf' : 'branch';
  });
  return {
    schema_version: 'clustered-graph/3.0',
    subject: manifest.subject,
    generation: {
      generatedAt: '2026-10-22',
      sourceCourseId: index.courseId,
      pointCount: points.length,
      clusterCount: 1,
      brokenCycleEdges: [],
      refinedPrerequisiteEdges: [],
    },
    clusters: [{
      id: 'chapter-one',
      title: '第一章',
      subtitle: '状态过程基础',
      description: '按教材顺序解释状态、转移与终止。',
      order: 0,
    }],
    sequences: {
      cluster: [],
      point: points.slice(1).map((point, indexValue) => ({
        fromId: points[indexValue].id,
        toId: point.id,
      })),
    },
    points,
  };
}

function writeGraphFixture(t, graph) {
  const graphRoot = mkdtempSync(path.join(tmpdir(), 'check-pipeline-v3-graph-'));
  t.after(() => rmSync(graphRoot, { recursive: true, force: true }));
  writeJson(graphRoot, 'clustered-graph.json', graph);
  return path.join(graphRoot, 'clustered-graph.json');
}

test('pipeline 接受 textbook-content/2.0 与 clustered-graph/3.0 薄关系图', (t) => {
  const { root } = createCourseFixture(t, { withAnimation: false });
  const manifest = configureTextbookV2(root);
  const graph = makeThinGraph(root, manifest);
  const graphFile = writeGraphFixture(t, graph);

  const result = checkPipeline(root, graphFile, 'all', { reviewMode: 'skip' });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.counts.graphPoints, 3);
  assert.equal(result.counts.clusters, 1);
});

test('pipeline 拒绝在 clustered-graph/3.0 中复制 canonical 正文', (t) => {
  const { root } = createCourseFixture(t, { withAnimation: false });
  const manifest = configureTextbookV2(root);
  const graph = makeThinGraph(root, manifest);
  graph.points[0].content = readJson(
    root,
    `src/data/points/${graph.points[0].id}.json`,
  ).content;
  const graphFile = writeGraphFixture(t, graph);

  const result = checkPipeline(root, graphFile, 'all', { reviewMode: 'skip' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.code === 'point-shape-changed'));
});

test('pipeline 拒绝 textbook-content/2.0 搭配旧 clustered-graph/2.0', (t) => {
  const { root } = createCourseFixture(t, { withAnimation: false });
  const manifest = configureTextbookV2(root);
  const graph = makeThinGraph(root, manifest);
  graph.schema_version = 'clustered-graph/2.0';
  const graphFile = writeGraphFixture(t, graph);

  const result = checkPipeline(root, graphFile, 'all', { reviewMode: 'skip' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => (
    finding.code === 'textbook-content-v2-requires-thin-graph'
  )));
});

test('pipeline 将单向 related 作为阻断错误', (t) => {
  const { root } = createCourseFixture(t, { withAnimation: false });
  const manifest = configureTextbookV2(root);
  const graph = makeThinGraph(root, manifest);
  graph.points[0].related = [graph.points[1].id];
  const graphFile = writeGraphFixture(t, graph);

  const result = checkPipeline(root, graphFile, 'all', { reviewMode: 'skip' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => (
    finding.code === 'related-not-symmetric' && finding.severity === 'error'
  )));
});

test('pipeline 拒绝同一点对同时为 related 和 prerequisite', (t) => {
  const { root } = createCourseFixture(t, { withAnimation: false });
  const manifest = configureTextbookV2(root);
  const graph = makeThinGraph(root, manifest);
  graph.points[0].related = [graph.points[1].id];
  graph.points[1].related = [graph.points[0].id];
  graph.points[1].prerequisites = [graph.points[0].id];
  graph.generation.refinedPrerequisiteEdges = [{
    op: 'add',
    from: graph.points[1].id,
    to: graph.points[0].id,
    reason: '测试关系类型互斥。',
  }];
  const graphFile = writeGraphFixture(t, graph);

  const result = checkPipeline(root, graphFile, 'all', { reviewMode: 'skip' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => (
    finding.code === 'relation-type-conflict'
  )));
});
