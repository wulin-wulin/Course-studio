import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-graph.mjs');

function point(id, prerequisites = [], related = []) {
  return {
    id,
    title: id,
    origin: 'textbook',
    clusterIds: ['chapter-1'],
    role: 'trunk',
    prerequisites,
    related,
  };
}

function runGraph(t, points) {
  const root = mkdtempSync(join(tmpdir(), 'check-graph-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const graphPath = join(root, 'clustered-graph.json');
  writeFileSync(graphPath, `${JSON.stringify({
    schema_version: 'clustered-graph/3.0',
    course: {
      id: 'demo-course',
      title: '测试课程',
      description: '用于关系校验的测试课程。',
      language: 'zh-CN',
      version: '1.0.0',
      updatedAt: '2026-10-22',
    },
    clusters: [{ id: 'chapter-1', title: '第一章', order: 1 }],
    points,
    sequences: { cluster: [], point: [] },
    generation: {
      refinedPrerequisiteEdges: [],
      brokenCycleEdges: [],
    },
  }, null, 2)}\n`, 'utf8');
  return spawnSync(process.execPath, [SCRIPT, graphPath, '--json'], {
    encoding: 'utf8',
  });
}

test('check-graph rejects a pair that is both related and prerequisite', (t) => {
  const result = runGraph(t, [
    point('basic-point', [], ['advanced-point']),
    point('advanced-point', ['basic-point'], ['basic-point']),
  ]);

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const conflicts = report.findings.filter((finding) => (
    finding.code === 'related-prerequisite-conflict'
  ));
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].message, /同时存在 related 和 prerequisite/);
});
test('check-graph rejects one-way related declarations', (t) => {
  const result = runGraph(t, [
    point('first-point', [], ['second-point']),
    point('second-point'),
  ]);

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.ok(report.findings.some((finding) => (
    finding.code === 'related-not-symmetric'
  )));
});
