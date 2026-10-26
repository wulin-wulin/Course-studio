import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { materializePointSourceSpans } from './finalize_point_drafts.mjs';
import { prepareWorkerTasks } from './prepare_worker_tasks.mjs';
import { validateProject } from './validate_output.mjs';
import {
  POINT_IDS,
  createCourseFixture,
  readJson,
  readText,
  writeJson,
  writeText,
} from './test-fixture.mjs';
import {
  appendPendingPoints,
  configureTextbookSession,
  createWorkerSession,
  writePlaceholders,
  writeTextbookDraft,
} from './worker-task-test-fixture.mjs';

const SCRIPT = fileURLToPath(new URL('./finalize_point_drafts.mjs', import.meta.url));
const VALIDATOR = fileURLToPath(new URL('./validate_output.mjs', import.meta.url));
const QUEUE_HINT = '其中若有本轮已派发的任务，说明 worker 没有写入文件，按失败处理';

function runCli(script, args, concurrency = '10') {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COURSE_WORKER_CONCURRENCY: concurrency },
  });
}

// 末点的第二个 span 由两个 block 组成，覆盖 "a+b" 形式的 ref。
const DRAFTED_IDS = [...POINT_IDS, 'pending-point-005'];

// 教材 v2 会话：四个点由 worker 按任务包 ref 写完，pending-point-004 仍是 {} 占位。
function createDraftedTextbookSession(t) {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  appendPendingPoints(session.contentRoot, 5);
  const manifest = configureTextbookSession(session);
  prepareWorkerTasks(session.contentRoot, { kind: 'content', env: {} });
  for (const pointId of DRAFTED_IDS) {
    const task = readJson(session.tasksRoot, `content/${pointId}.json`);
    writeTextbookDraft(
      session.contentRoot,
      pointId,
      task.evidence.spans.map((span) => span.ref),
      { origin: task.evidence.origin },
    );
  }
  return { ...session, manifest, pendingIds: ['pending-point-004'] };
}

function evidenceSpans(manifest, pointId) {
  return manifest.pointEvidence.find((evidence) => evidence.pointId === pointId).sourceSpans;
}

function snapshot(root, relativePaths) {
  return new Map(relativePaths.map((relativePath) => [relativePath, {
    text: readText(root, relativePath),
    mtimeMs: statSync(join(root, relativePath)).mtimeMs,
  }]));
}

test('未展开的 sourceSpans ref 在草稿校验中给出明确错误', (t) => {
  const { contentRoot } = createDraftedTextbookSession(t);

  const { errors } = validateProject(contentRoot, { phase: 'point-drafts' });
  // 每个点一条汇总错误；合法 ref 不再被逐项报成“必须是对象”。
  const refErrors = errors.filter((error) => error.includes('未展开的 sourceSpans ref'));
  assert.equal(refErrors.length, DRAFTED_IDS.length);
  assert.ok(refErrors.every((error) => error.includes('请先运行 finalize-point-drafts')));
  assert.ok(refErrors.some((error) => error.startsWith(
    'src/data/points/pending-point-005.json 包含 2 个未展开的 sourceSpans ref'
    + '（首个 "block-009" 位于 src/data/points/pending-point-005.json.content.blocks[0].provenance.sourceSpans[0]）',
  )));
  assert.equal(errors.some((error) => error.includes('必须是对象')), false);
  assert.equal(
    errors.some((error) => error.includes('派生的 sourceSpans 必须与 manifest.pointEvidence 一致')),
    false,
  );
  assert.ok(validateProject(contentRoot, { phase: 'points' }).errors.some((error) => (
    error.includes('未展开的 sourceSpans ref')
  )));
});

test('finalize 展开 ref 后与 validate-point-drafts 完全一致地通过', (t) => {
  const { contentRoot, manifest, pendingIds } = createDraftedTextbookSession(t);
  const placeholderPaths = pendingIds.flatMap((pointId) => [
    `src/data/points/${pointId}.json`,
    `generation/animation-requests/${pointId}.json`,
  ]);
  const requestPaths = DRAFTED_IDS.map((pointId) => `generation/animation-requests/${pointId}.json`);
  const untouched = snapshot(contentRoot, [
    ...placeholderPaths,
    ...requestPaths,
    'generation/manifest.json',
    'src/data/index.json',
  ]);

  const result = materializePointSourceSpans(contentRoot);
  assert.deepEqual(result, {
    applied: true,
    expandedPointIds: ['input-state', 'pending-point-005', 'state-transition', 'terminal-condition'],
    expandedRefs: 8,
    unknownRefPointIds: [],
    errors: [],
  });
  for (const pointId of DRAFTED_IDS) {
    const relativePath = `src/data/points/${pointId}.json`;
    const point = readJson(contentRoot, relativePath);
    assert.deepEqual(
      point.content.blocks[0].provenance.sourceSpans,
      evidenceSpans(manifest, pointId),
    );
    assert.equal(readText(contentRoot, relativePath), `${JSON.stringify(point, null, 2)}\n`);
  }
  for (const [relativePath, before] of untouched) {
    assert.equal(readText(contentRoot, relativePath), before.text, relativePath);
    assert.equal(statSync(join(contentRoot, relativePath)).mtimeMs, before.mtimeMs, relativePath);
  }

  const validation = validateProject(contentRoot, { phase: 'point-drafts' });
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.validatedPointIds, DRAFTED_IDS);
  assert.deepEqual(validation.pendingPointIds, pendingIds);
});

test('finalize 第二次运行没有任何改动', (t) => {
  const { contentRoot } = createDraftedTextbookSession(t);
  materializePointSourceSpans(contentRoot);
  const before = snapshot(contentRoot, DRAFTED_IDS.map((pointId) => `src/data/points/${pointId}.json`));

  const second = materializePointSourceSpans(contentRoot);
  assert.deepEqual(second, {
    applied: true,
    expandedPointIds: [],
    expandedRefs: 0,
    unknownRefPointIds: [],
    errors: [],
  });
  for (const [relativePath, entry] of before) {
    assert.equal(readText(contentRoot, relativePath), entry.text);
    assert.equal(statSync(join(contentRoot, relativePath)).mtimeMs, entry.mtimeMs);
  }
});

test('未知 ref 不改该文件且只由校验器报告真正的未知项，对象 span 与其他点照常处理', (t) => {
  const { contentRoot, manifest } = createDraftedTextbookSession(t);
  const spans = evidenceSpans(manifest, 'input-state');
  writeTextbookDraft(contentRoot, 'input-state', [spans[0].blockIds[0], 'block-999']);
  // 已展开的完整 span 对象与 ref 混写时，对象项保持原样。
  writeTextbookDraft(
    contentRoot,
    'state-transition',
    [structuredClone(evidenceSpans(manifest, 'state-transition')[0]), 'block-004'],
    { origin: 'llm-extension' },
  );
  const before = readText(contentRoot, 'src/data/points/input-state.json');

  const result = materializePointSourceSpans(contentRoot);
  assert.deepEqual(
    result.expandedPointIds,
    ['pending-point-005', 'state-transition', 'terminal-condition'],
  );
  assert.equal(result.expandedRefs, 5);
  assert.deepEqual(result.unknownRefPointIds, ['input-state']);
  assert.deepEqual(result.errors, []);
  assert.equal(readText(contentRoot, 'src/data/points/input-state.json'), before);
  // 同文件中合法的 block-001 不报错，也不提示“请先运行 finalize”或“必须是对象”。
  const { errors } = validateProject(contentRoot, { phase: 'point-drafts' });
  const inputErrors = errors.filter((error) => error.includes('input-state.json'));
  assert.equal(inputErrors.length, 1, inputErrors.join('\n'));
  assert.match(
    inputErrors[0],
    /^src\/data\/points\/input-state\.json\.content\.blocks\[0\]\.provenance\.sourceSpans\[1\] 引用了未知 sourceSpans ref "block-999"/,
  );
  assert.match(inputErrors[0], /不要手写 span 对象/);
  assert.doesNotMatch(inputErrors[0], /请先运行 finalize-point-drafts/);
  assert.deepEqual(
    readJson(contentRoot, 'src/data/points/state-transition.json')
      .content.blocks[0].provenance.sourceSpans,
    evidenceSpans(manifest, 'state-transition'),
  );
});

test('非教材 v2 课程跳过展开且不触碰任何文件', (t) => {
  const { root } = createCourseFixture(t);
  writeJson(root, 'src/data/points/terminal-condition.json', {});
  writeJson(root, 'generation/animation-requests/terminal-condition.json', {});
  const paths = POINT_IDS.flatMap((pointId) => [
    `src/data/points/${pointId}.json`,
    `generation/animation-requests/${pointId}.json`,
  ]);
  const before = snapshot(root, paths);

  assert.deepEqual(materializePointSourceSpans(root), {
    applied: false,
    expandedPointIds: [],
    expandedRefs: 0,
    unknownRefPointIds: [],
    errors: [],
  });
  for (const [relativePath, entry] of before) {
    assert.equal(readText(root, relativePath), entry.text);
    assert.equal(statSync(join(root, relativePath)).mtimeMs, entry.mtimeMs);
  }
});

test('finalize CLI 先打印草稿校验报告再附加展开摘要', (t) => {
  const { contentRoot } = createDraftedTextbookSession(t);

  const success = runCli(SCRIPT, ['--root', contentRoot]);
  assert.equal(success.status, 0, success.stderr);
  const lines = success.stdout.trim().split('\n');
  assert.deepEqual(lines, [
    '草稿批次：已校验 4 个知识点；待生成 1 个知识点',
    `待生成队首（按计划顺序前 1 个）：pending-point-004；${QUEUE_HINT}`,
    '校验通过：阶段 point-drafts；4 个知识点；动画类型 none',
    '溯源展开：写回 4 个知识点，展开 8 个 sourceSpans ref',
  ]);

  writeTextbookDraft(contentRoot, 'terminal-condition', ['block-404']);
  const failure = runCli(SCRIPT, ['--root', contentRoot]);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /校验失败/);
  assert.match(failure.stderr, /引用了未知 sourceSpans ref "block-404"/);
  assert.doesNotMatch(failure.stderr, /请先运行 finalize-point-drafts|必须是对象|溯源展开失败/);
  assert.match(failure.stdout, /1 个知识点含未知 ref 未展开（逐项位置见校验失败列表）/);
});

test('教材 v2 课程中 schema_version 不正确的草稿给出展开错误而不是空转提示', (t) => {
  const { contentRoot } = createDraftedTextbookSession(t);
  const point = readJson(contentRoot, 'src/data/points/input-state.json');
  delete point.content.schema_version;
  writeJson(contentRoot, 'src/data/points/input-state.json', point);

  const result = materializePointSourceSpans(contentRoot);
  assert.equal(result.expandedPointIds.includes('input-state'), false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /input-state\.json 的 content\.schema_version 不是 textbook-content\/2\.0/);

  const { errors } = validateProject(contentRoot, { phase: 'point-drafts' });
  assert.ok(errors.includes('src/data/points/input-state.json 必须使用 textbook-content/2.0'));
  assert.equal(
    errors.some((error) => error.includes('请先运行 finalize-point-drafts')),
    false,
  );
});

test('草稿报告按并发数列出待生成队首，暴露已派发却仍为占位的任务', (t) => {
  // canary 共 3 点、k=2：只写入首点后，队首依次是另外两个已派发的 canary 点。
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  appendPendingPoints(session.contentRoot, 6);
  const { root } = createCourseFixture(t);
  writeJson(
    session.contentRoot,
    'src/data/points/input-state.json',
    readJson(root, 'src/data/points/input-state.json'),
  );
  writeJson(
    session.contentRoot,
    'generation/animation-requests/input-state.json',
    readJson(root, 'generation/animation-requests/input-state.json'),
  );

  const result = runCli(VALIDATOR, ['--root', session.contentRoot, '--phase', 'point-drafts'], '2');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /草稿批次：已校验 1 个知识点；待生成 5 个知识点/);
  assert.ok(result.stdout.includes(
    `待生成队首（按计划顺序前 2 个）：state-transition, terminal-condition；${QUEUE_HINT}`,
  ));
});

test('动画草稿报告按清单顺序列出待生成组件队首', (t) => {
  const { root } = createCourseFixture(t, { withAnimation: true });
  writeText(root, 'src/animations/StateTransition.tsx', '{}\n');
  writeText(root, 'src/animations/StateTransition.css', '{}\n');

  const result = runCli(VALIDATOR, ['--root', root, '--phase', 'animation-drafts']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(
    `动画待生成队首（按计划顺序前 1 个）：StateTransition；${QUEUE_HINT}`,
  ));
  assert.deepEqual(
    validateProject(root, { phase: 'animation-drafts' }).pendingAnimationComponents,
    ['StateTransition'],
  );
});

test('finalize CLI 对普通课程只做草稿校验', (t) => {
  const { root } = createCourseFixture(t);

  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /草稿批次：已校验 3 个知识点；待生成 0 个知识点/);
  assert.match(result.stdout, /溯源展开：跳过（课程未声明 textbook-content\/2\.0）/);
});
