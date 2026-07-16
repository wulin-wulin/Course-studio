import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { test } from 'node:test';
import {
  parseArgs,
  syncIndexFromPoints,
} from './sync_index_from_points.mjs';
import { validateProject } from './validate_output.mjs';
import {
  createCourseFixture,
  fixturePath,
  readJson,
  readText,
  writeJson,
} from './test-fixture.mjs';

test('回写四项元数据并保持冻结字段和索引顺序', (t) => {
  const { root, pointIds } = createCourseFixture(t);
  const before = readJson(root, 'src/data/index.json');

  pointIds.forEach((id, index) => {
    const point = readJson(root, `src/data/points/${id}.json`);
    point.shortSummary = `${point.shortSummary}并补充同步后的教学边界。`;
    point.difficulty = ['中等', '进阶', '进阶'][index];
    point.importance = 0.61 + index * 0.1;
    point.keyTerms = [...point.keyTerms, `同步术语${index + 1}`];
    writeJson(root, `src/data/points/${id}.json`, point);
  });

  const result = syncIndexFromPoints(root);
  const after = readJson(root, 'src/data/index.json');

  assert.equal(result.pointCount, pointIds.length);
  assert.equal(result.changed, true);
  assert.equal(result.changedFields.length, pointIds.length * 4);
  assert.deepEqual(
    after.points.map(({ id, title }) => ({ id, title })),
    before.points.map(({ id, title }) => ({ id, title })),
  );
  assert.deepEqual(
    after.points.map((point) => point.id),
    pointIds,
  );
  for (const meta of after.points) {
    const point = readJson(root, `src/data/points/${meta.id}.json`);
    for (const key of [
      'shortSummary',
      'difficulty',
      'importance',
      'keyTerms',
    ]) {
      assert.deepEqual(meta[key], point[key]);
    }
  }
  assert.match(readText(root, 'src/data/index.json'), /\n$/);
});

test('--check 检测漂移且不写入 index', (t) => {
  const { root } = createCourseFixture(t);
  const point = readJson(root, 'src/data/points/state-transition.json');
  point.importance = 0.87;
  writeJson(root, 'src/data/points/state-transition.json', point);
  const before = readText(root, 'src/data/index.json');
  const options = parseArgs(['--root', root, '--check']);

  assert.equal(options.check, true);
  assert.throws(
    () => syncIndexFromPoints(options.root, { check: options.check }),
    /index\.json 尚未与详情同步/,
  );
  assert.equal(readText(root, 'src/data/index.json'), before);
});

test('拒绝详情修改冻结 title', (t) => {
  const { root } = createCourseFixture(t);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.title = '被修改的输入状态';
  writeJson(root, 'src/data/points/input-state.json', point);

  assert.throws(
    () => syncIndexFromPoints(root),
    /title 已冻结/,
  );
});

test('拒绝详情文件集合与 index 不一致', (t) => {
  const { root } = createCourseFixture(t);
  unlinkSync(fixturePath(root, 'src/data/points/terminal-condition.json'));
  const orphan = readJson(root, 'src/data/points/input-state.json');
  orphan.id = 'orphan-point';
  orphan.title = '孤立知识点';
  orphan.shortSummary = '该孤立知识点只用于验证详情文件集合必须与规划索引保持严格的一一对应关系。';
  writeJson(root, 'src/data/points/orphan-point.json', orphan);

  assert.throws(
    () => syncIndexFromPoints(root),
    (error) => {
      assert.match(error.message, /缺少详情文件: terminal-condition\.json/);
      assert.match(error.message, /详情文件未进入 index\.json: orphan-point\.json/);
      return true;
    },
  );
});

test('反转 index 顺序时 validator 与同步器都拒绝', (t) => {
  const { root } = createCourseFixture(t);
  const index = readJson(root, 'src/data/index.json');
  index.points.reverse();
  writeJson(root, 'src/data/index.json', index);

  const validation = validateProject(root, { phase: 'index' });
  assert.ok(
    validation.errors.some((error) => (
      error.includes('pointEvidence[0].pointId')
      && error.includes('同序一致')
    )),
  );
  assert.throws(
    () => syncIndexFromPoints(root),
    /pointEvidence\[0\]\.pointId.*同序一致/,
  );
});

test('修改 index title 时 validator 与同步器都拒绝', (t) => {
  const { root } = createCourseFixture(t);
  const index = readJson(root, 'src/data/index.json');
  index.points[0].title = '被篡改的输入状态';
  writeJson(root, 'src/data/index.json', index);

  const validation = validateProject(root, { phase: 'index' });
  assert.ok(
    validation.errors.some((error) => (
      error.includes('pointEvidence[0].title')
      && error.includes('同序一致')
    )),
  );
  assert.throws(
    () => syncIndexFromPoints(root),
    /pointEvidence\[0\]\.title.*同序一致/,
  );
});
