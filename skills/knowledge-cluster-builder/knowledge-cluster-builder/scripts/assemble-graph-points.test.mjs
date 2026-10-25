import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleGraphPoints } from './assemble-graph-points.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_GRAPH = path.join(HERE, 'check-graph.mjs');

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function point(id, title, prerequisites = []) {
  return {
    id,
    title,
    shortSummary: `${title}用于验证聚类图机械装配时完整保留上游课程内容字段，避免发布阶段才发现内容丢失。`,
    coreIdea: `${title}的核心思想`,
    principles: ['原则一', '原则二'],
    keyTerms: ['术语一', '术语二'],
    applications: ['应用场景'],
    aliases: [],
    intuition: '直觉说明',
    misconceptions: ['常见误区'],
    qa: [{ q: '问题一', a: '回答一' }, { q: '问题二', a: '回答二' }],
    animationType: 'none',
    difficulty: '基础',
    importance: 0.8,
    prerequisites,
  };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'assemble-graph-points-'));
  const contentRoot = path.join(root, 'course-content');
  const graphFile = path.join(root, 'clustered-graph.json');
  const manifestSubject = {
    id: 'fixture-course',
    input: '测试课程',
    normalizedTitle: '测试课程',
  };
  const first = point('first-point', '第一个知识点');
  const second = point('second-point', '第二个知识点', ['first-point']);
  writeJson(path.join(contentRoot, 'src/data/index.json'), {
    courseId: 'fixture-course',
    points: [
      { id: first.id, title: first.title },
      { id: second.id, title: second.title },
    ],
  });
  writeJson(path.join(contentRoot, 'generation/manifest.json'), {
    subject: manifestSubject,
  });
  writeJson(path.join(contentRoot, 'src/data/points', `${first.id}.json`), first);
  writeJson(path.join(contentRoot, 'src/data/points', `${second.id}.json`), second);
  const graph = {
    schema_version: 'clustered-graph/2.0',
    subject: {},
    generation: { pointCount: 0, clusterCount: 0 },
    clusters: [{
      id: 'foundations',
      title: '基础',
      subtitle: '基础主题',
      description: '基础主题描述',
      order: 1,
    }],
    points: [
      {
        id: second.id,
        prerequisites: [],
        clusterIds: ['foundations'],
        role: 'leaf',
        related: [],
      },
      {
        id: first.id,
        clusterIds: ['foundations'],
        role: 'trunk',
        related: [],
      },
    ],
  };
  writeJson(graphFile, graph);
  return { root, contentRoot, graphFile, graph, first, second, manifestSubject };
}

test('按 index 顺序机械补齐正文，并只覆盖关系字段和显式 prerequisites', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));

  const result = assembleGraphPoints(value.contentRoot, value.graphFile);
  assert.equal(result.changed, true);
  const output = JSON.parse(readFileSync(value.graphFile, 'utf8'));
  assert.deepEqual(output.points.map(({ id }) => id), ['first-point', 'second-point']);
  assert.deepEqual(output.points[0], {
    ...value.first,
    clusterIds: ['foundations'],
    role: 'trunk',
    related: [],
  });
  assert.deepEqual(output.points[1], {
    ...value.second,
    prerequisites: [],
    clusterIds: ['foundations'],
    role: 'leaf',
    related: [],
  });
  assert.equal(output.generation.pointCount, 2);
  assert.equal(output.generation.clusterCount, 1);
  assert.equal(output.generation.sourceCourseId, 'fixture-course');
  assert.deepEqual(output.subject, value.manifestSubject);

  const check = spawnSync(
    process.execPath,
    [path.join(HERE, 'assemble-graph-points.mjs'), value.contentRoot, value.graphFile, '--check', '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.equal(JSON.parse(check.stdout).ok, true);
});

test('规范化前置关系审计的方向，并只保留相对 canonical 的增删差异', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  value.graph.generation.refinedPrerequisiteEdges = [
    // Visual prerequisite -> dependent direction; the canonical audit is the
    // dependent point first, matching point.prerequisites and backend review.
    {
      op: 'remove',
      from: 'first-point',
      to: 'second-point',
      reason: '模型草稿方向',
    },
    // A stale "all final edges" entry is ignored because it is not a delta.
    {
      op: 'add',
      from: 'second-point',
      to: 'first-point',
      reason: '模型草稿列出最终边',
    },
  ];
  writeJson(value.graphFile, value.graph);

  assembleGraphPoints(value.contentRoot, value.graphFile);
  const output = JSON.parse(readFileSync(value.graphFile, 'utf8'));
  assert.deepEqual(output.generation.refinedPrerequisiteEdges, [{
    op: 'remove',
    from: 'second-point',
    to: 'first-point',
    reason: '模型草稿方向',
  }]);
});

test('规范化破环审计并合并重复的前置关系记录', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  value.graph.generation.refinedPrerequisiteEdges = [
    {
      op: 'remove',
      from: 'first-point',
      to: 'second-point',
      reason: '破环草稿方向',
    },
    {
      op: 'remove',
      from: 'second-point',
      to: 'first-point',
      reason: '重复的 canonical 记录',
    },
  ];
  value.graph.generation.brokenCycleEdges = [
    {
      from: 'first-point',
      to: 'second-point',
      reason: '破环草稿方向',
    },
    {
      from: 'unknown-point',
      to: 'first-point',
      reason: '过期记录',
    },
  ];
  writeJson(value.graphFile, value.graph);

  assembleGraphPoints(value.contentRoot, value.graphFile);
  const output = JSON.parse(readFileSync(value.graphFile, 'utf8'));
  assert.deepEqual(output.generation.refinedPrerequisiteEdges, [{
    op: 'remove',
    from: 'second-point',
    to: 'first-point',
    reason: '破环草稿方向',
  }]);
  assert.deepEqual(output.generation.brokenCycleEdges, [{
    from: 'second-point',
    to: 'first-point',
    reason: '破环草稿方向',
  }]);
});

test('自动丢弃图草稿对上游正文的改写', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  value.graph.points[0].coreIdea = '被图阶段擅自精简或改写的正文';
  writeJson(value.graphFile, value.graph);

  const result = assembleGraphPoints(value.contentRoot, value.graphFile);
  const output = JSON.parse(readFileSync(value.graphFile, 'utf8'));
  assert.equal(result.restoredContentFields, 1);
  assert.equal(output.points[1].coreIdea, value.second.coreIdea);
});

test('拒绝点集缺失，基础图校验器也会提前拦截精简 point 对象', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  value.graph.points.pop();
  writeJson(value.graphFile, value.graph);
  assert.throws(
    () => assembleGraphPoints(value.contentRoot, value.graphFile),
    /缺少: first-point/,
  );

  const check = spawnSync(process.execPath, [CHECK_GRAPH, value.graphFile, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(check.status, 1);
  const report = JSON.parse(check.stdout);
  assert.ok(report.findings.some((finding) => finding.code === 'point-missing-fields'));
});

function convertFixtureToThinTextbookGraph(value) {
  const manifestPath = path.join(value.contentRoot, 'generation/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.generation = { contentContract: 'textbook-content/2.0' };
  writeJson(manifestPath, manifest);

  for (const pointValue of [value.first, value.second]) {
    const canonical = {
      ...pointValue,
      origin: 'textbook',
      content: {
        schema_version: 'textbook-content/2.0',
        blocks: [{
          id: 'definition',
          kind: 'definition',
          markdown: `${pointValue.title}的教材定义。`,
          provenance: { origin: 'textbook', representation: 'paraphrase', sourceSpans: [] },
        }],
      },
    };
    writeJson(
      path.join(value.contentRoot, 'src/data/points', `${pointValue.id}.json`),
      canonical,
    );
  }
  value.graph.schema_version = 'clustered-graph/3.0';
  value.graph.points = value.graph.points.map((pointValue) => ({
    id: pointValue.id,
    ...(Object.hasOwn(pointValue, 'prerequisites')
      ? { prerequisites: pointValue.prerequisites }
      : {}),
    clusterIds: pointValue.clusterIds,
    role: pointValue.role,
    related: pointValue.related,
  }));
  writeJson(value.graphFile, value.graph);
}

test('textbook-content/2.0 机械装配 clustered-graph/3.0 薄关系点且不复制正文', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  convertFixtureToThinTextbookGraph(value);

  const result = assembleGraphPoints(value.contentRoot, value.graphFile);
  assert.equal(result.thinGraph, true);
  const output = JSON.parse(readFileSync(value.graphFile, 'utf8'));
  assert.deepEqual(output.points.map((pointValue) => Object.keys(pointValue)), [
    ['id', 'title', 'origin', 'clusterIds', 'role', 'prerequisites', 'related'],
    ['id', 'title', 'origin', 'clusterIds', 'role', 'prerequisites', 'related'],
  ]);
  assert.deepEqual(output.points[0], {
    id: 'first-point',
    title: '第一个知识点',
    origin: 'textbook',
    clusterIds: ['foundations'],
    role: 'trunk',
    prerequisites: [],
    related: [],
  });
  assert.deepEqual(output.points[1].prerequisites, []);
  assert.equal('content' in output.points[0], false);
  assert.equal('coreIdea' in output.points[0], false);

  const checked = spawnSync(process.execPath, [CHECK_GRAPH, value.graphFile, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal(JSON.parse(checked.stdout).ok, true);
});

test('clustered-graph/3.0 拒绝把 canonical content 复制进关系图', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  convertFixtureToThinTextbookGraph(value);
  value.graph = JSON.parse(readFileSync(value.graphFile, 'utf8'));
  value.graph.points[0].content = { blocks: [] };
  writeJson(value.graphFile, value.graph);

  assert.throws(
    () => assembleGraphPoints(value.contentRoot, value.graphFile),
    /(?:first|second)-point 含契约外字段: content/,
  );
});
