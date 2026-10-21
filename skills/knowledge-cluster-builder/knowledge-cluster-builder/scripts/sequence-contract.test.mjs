import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  sequenceCounts,
  validateSequences,
} from './sequence-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_GRAPH = path.join(HERE, 'check-graph.mjs');
const CLUSTER_IDS = new Set(['chapter-one', 'chapter-two', 'chapter-three']);
const POINT_IDS = new Set(['point-one', 'point-two', 'point-three']);

function validate(sequences) {
  return validateSequences(sequences, {
    clusterIds: CLUSTER_IDS,
    pointIds: POINT_IDS,
  });
}

function codes(sequences) {
  return validate(sequences).map((finding) => finding.code);
}

function point(id, clusterId) {
  return {
    id,
    title: id,
    shortSummary: `${id} 是用于校验顺序关系契约的完整知识点摘要，确保命令行图校验器能够接受合法输入。`,
    coreIdea: `${id} 的核心思想`,
    principles: ['原则一', '原则二'],
    keyTerms: ['术语一', '术语二'],
    applications: ['应用场景'],
    aliases: [],
    intuition: '直觉说明',
    misconceptions: ['常见误区'],
    qa: [
      { q: '问题一', a: '回答一' },
      { q: '问题二', a: '回答二' },
    ],
    animationType: 'none',
    difficulty: '基础',
    importance: 0.8,
    prerequisites: [],
    clusterIds: [clusterId],
    role: 'trunk',
    related: [],
  };
}

function graph(sequences) {
  const value = {
    schema_version: 'clustered-graph/2.0',
    clusters: [...CLUSTER_IDS].map((id, order) => ({ id, order })),
    points: [
      point('point-one', 'chapter-one'),
      point('point-two', 'chapter-two'),
      point('point-three', 'chapter-three'),
    ],
  };
  if (sequences !== undefined) value.sequences = sequences;
  return value;
}

function runCheck(t, value) {
  const root = mkdtempSync(path.join(tmpdir(), 'sequence-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const graphPath = path.join(root, 'clustered-graph.json');
  writeFileSync(graphPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return spawnSync(process.execPath, [CHECK_GRAPH, graphPath, '--json'], {
    encoding: 'utf8',
  });
}

test('合法 cluster 与 point sequence 通过契约并计入图校验统计', (t) => {
  const sequences = {
    cluster: [
      { fromId: 'chapter-one', toId: 'chapter-two' },
      { fromId: 'chapter-two', toId: 'chapter-three' },
    ],
    point: [
      { fromId: 'point-one', toId: 'point-two' },
      { fromId: 'point-two', toId: 'point-three' },
    ],
  };

  assert.deepEqual(validate(sequences), []);
  assert.deepEqual(sequenceCounts(sequences), {
    clusterSequenceEdges: 2,
    pointSequenceEdges: 2,
  });

  const result = runCheck(t, graph(sequences));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.stats.clusterSequenceEdges, 2);
  assert.equal(report.stats.pointSequenceEdges, 2);
});

test('缺少 sequences 的旧图继续通过并按零条顺序边统计', (t) => {
  assert.deepEqual(validate(undefined), []);
  assert.deepEqual(sequenceCounts(undefined), {
    clusterSequenceEdges: 0,
    pointSequenceEdges: 0,
  });

  const result = runCheck(t, graph(undefined));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.stats.clusterSequenceEdges, 0);
  assert.equal(report.stats.pointSequenceEdges, 0);
});

test('拒绝引用未知簇或知识点的 sequence', () => {
  const findings = validate({
    cluster: [{ fromId: 'chapter-one', toId: 'missing-chapter' }],
    point: [{ fromId: 'missing-point', toId: 'point-two' }],
  });

  assert.equal(
    findings.filter((finding) => finding.code === 'dangling-sequence-edge').length,
    2,
  );
  assert.deepEqual(
    findings.map((finding) => finding.field),
    ['sequences.cluster[0]', 'sequences.point[0]'],
  );
});

test('拒绝 cluster 与 point sequence 自环', () => {
  assert.deepEqual(codes({
    cluster: [{ fromId: 'chapter-one', toId: 'chapter-one' }],
    point: [{ fromId: 'point-one', toId: 'point-one' }],
  }), ['sequence-self-loop', 'sequence-self-loop']);
});

test('拒绝完全重复的 sequence 边', () => {
  assert.deepEqual(codes({
    cluster: [
      { fromId: 'chapter-one', toId: 'chapter-two' },
      { fromId: 'chapter-one', toId: 'chapter-two' },
    ],
    point: [
      { fromId: 'point-one', toId: 'point-two' },
      { fromId: 'point-one', toId: 'point-two' },
    ],
  }), ['duplicate-sequence-edge', 'duplicate-sequence-edge']);
});

test('拒绝 cluster sequence 有向环', () => {
  const findings = validate({
    cluster: [
      { fromId: 'chapter-one', toId: 'chapter-two' },
      { fromId: 'chapter-two', toId: 'chapter-three' },
      { fromId: 'chapter-three', toId: 'chapter-one' },
    ],
    point: [],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'sequence-cycle');
  assert.equal(findings[0].field, 'sequences.cluster');
});

test('拒绝 point sequence 有向环', () => {
  const findings = validate({
    cluster: [],
    point: [
      { fromId: 'point-one', toId: 'point-two' },
      { fromId: 'point-two', toId: 'point-three' },
      { fromId: 'point-three', toId: 'point-one' },
    ],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'sequence-cycle');
  assert.equal(findings[0].field, 'sequences.point');
});
