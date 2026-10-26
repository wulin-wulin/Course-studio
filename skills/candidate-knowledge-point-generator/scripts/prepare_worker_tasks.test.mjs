import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  planWorkerWaves,
  prepareWorkerTasks,
  resolveWorkerConcurrency,
} from './prepare_worker_tasks.mjs';
import {
  POINT_IDS,
  readJson,
  readText,
  writeJson,
  writeText,
} from './test-fixture.mjs';
import {
  COURSE_ID,
  DOCUMENT_ID,
  SKILL_ROOT,
  animationEntry,
  appendPendingPoints,
  configureTextbookSession,
  createWorkerSession,
  writePlaceholders,
} from './worker-task-test-fixture.mjs';

const SCRIPT = fileURLToPath(new URL('./prepare_worker_tasks.mjs', import.meta.url));
const CONTENT_REL = `pipeline/${COURSE_ID}/course-content`;
const TASKS_REL = `pipeline/${COURSE_ID}/worker-tasks`;

function env(concurrency) {
  return concurrency === undefined ? {} : { COURSE_WORKER_CONCURRENCY: String(concurrency) };
}

function prepareContent(session, concurrency) {
  return prepareWorkerTasks(session.contentRoot, { kind: 'content', env: env(concurrency) });
}

function listTaskFiles(session, directory) {
  const root = join(session.tasksRoot, directory);
  return existsSync(root) ? readdirSync(root).sort() : [];
}

test('planWorkerWaves 先切 canary，再按并发数分波且保持顺序', () => {
  const ids = Array.from({ length: 25 }, (_, index) => `p${index + 1}`);

  const ten = planWorkerWaves(ids, 10, 3);
  assert.deepEqual(ten.canary, ['p1', 'p2', 'p3']);
  assert.deepEqual(ten.waves.map((wave) => wave.length), [10, 10, 2]);
  assert.deepEqual([...ten.canary, ...ten.waves.flat()], ids);

  const three = planWorkerWaves(ids, 3, 3);
  assert.deepEqual(three.waves.map((wave) => wave.length), [3, 3, 3, 3, 3, 3, 3, 1]);
  assert.deepEqual([...three.canary, ...three.waves.flat()], ids);

  assert.deepEqual(planWorkerWaves(['only'], 10, 3), { canary: ['only'], waves: [] });
  assert.deepEqual(planWorkerWaves([], 10, 3), { canary: [], waves: [] });
});

test('COURSE_WORKER_CONCURRENCY 只接受 1–32 的整数，非法值回退到 10 并告警', () => {
  assert.deepEqual(resolveWorkerConcurrency({}), { concurrency: 10, warning: null });
  assert.deepEqual(
    resolveWorkerConcurrency({ COURSE_WORKER_CONCURRENCY: '' }),
    { concurrency: 10, warning: null },
  );
  for (const value of ['1', '3', '32']) {
    assert.deepEqual(
      resolveWorkerConcurrency({ COURSE_WORKER_CONCURRENCY: value }),
      { concurrency: Number(value), warning: null },
    );
  }
  for (const value of ['0', '33', '-1', '4.5', 'abc', '1e1', ' ']) {
    const result = resolveWorkerConcurrency({ COURSE_WORKER_CONCURRENCY: value });
    assert.equal(result.concurrency, 10, value);
    assert.match(result.warning, /COURSE_WORKER_CONCURRENCY/, value);
  }
});

test('prepare-content-tasks 按 k=10 与 k=3 写出 canary 和波次计划', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  const appended = appendPendingPoints(session.contentRoot, 25);
  const allIds = [...POINT_IDS, ...appended];

  const summary = prepareContent(session, 10);
  assert.equal(summary.concurrency, 10);
  assert.equal(summary.pending, 25);
  assert.equal(summary.started, 0);
  assert.deepEqual(summary.canary, allIds.slice(0, 3));
  assert.equal(summary.waves, 3);
  assert.deepEqual(summary.warnings, []);
  const plan = readJson(session.tasksRoot, 'content-plan.json');
  assert.deepEqual(plan, {
    schema_version: 'course-worker-plan/1.0',
    courseId: COURSE_ID,
    kind: 'content',
    concurrency: 10,
    canary: allIds.slice(0, 3),
    waves: [allIds.slice(3, 13), allIds.slice(13, 23), allIds.slice(23)],
    started: [],
    taskDir: `${TASKS_REL}/content`,
  });
  assert.deepEqual(
    listTaskFiles(session, 'content'),
    allIds.map((id) => `${id}.json`).sort(),
  );

  const rerun = prepareContent(session, 3);
  assert.equal(rerun.waves, 8);
  const smallPlan = readJson(session.tasksRoot, 'content-plan.json');
  assert.equal(smallPlan.concurrency, 3);
  assert.ok(smallPlan.waves.every((wave) => wave.length <= 3));
  assert.deepEqual([...smallPlan.canary, ...smallPlan.waves.flat()], allIds);
});

test('非法并发配置回退到 10 并在摘要中给出警告', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);

  const summary = prepareContent(session, 'many');
  assert.equal(summary.concurrency, 10);
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /已回退为 10/);
  assert.equal(readJson(session.tasksRoot, 'content-plan.json').concurrency, 10);
});

test('为全部知识点生成任务包，计划只调度成对 {} 占位点，已开始的点列入 started', (t) => {
  const session = createWorkerSession(t);
  // input-state 保持完整详情；state-transition 只开始了动画请求，也算已开始。
  writeJson(session.contentRoot, 'src/data/points/state-transition.json', {});
  writePlaceholders(session.contentRoot, ['terminal-condition']);
  const appended = appendPendingPoints(session.contentRoot, 5);

  const summary = prepareContent(session);
  assert.equal(summary.points, 5);
  assert.equal(summary.tasks, 5);
  assert.equal(summary.pending, 3);
  assert.equal(summary.started, 2);
  const plan = readJson(session.tasksRoot, 'content-plan.json');
  assert.deepEqual(plan.started, ['input-state', 'state-transition']);
  assert.deepEqual(plan.canary, ['terminal-condition', ...appended]);
  assert.deepEqual(plan.waves, []);
  // 已开始的点同样保留任务包，供修复、恢复和全局复核返工时的 repair task 读取。
  assert.deepEqual(
    listTaskFiles(session, 'content'),
    [
      'input-state.json',
      'pending-point-004.json',
      'pending-point-005.json',
      'state-transition.json',
      'terminal-condition.json',
    ],
  );
  assert.deepEqual(
    readJson(session.tasksRoot, 'content/input-state.json').ownership.write,
    [
      `${CONTENT_REL}/src/data/points/input-state.json`,
      `${CONTENT_REL}/generation/animation-requests/input-state.json`,
    ],
  );

  const task = readJson(session.tasksRoot, 'content/terminal-condition.json');
  const index = readJson(session.contentRoot, 'src/data/index.json');
  const manifest = readJson(session.contentRoot, 'generation/manifest.json');
  assert.equal(task.schema_version, 'course-worker-task/1.0');
  assert.equal(task.kind, 'content');
  assert.equal(task.pointId, 'terminal-condition');
  assert.equal(task.title, '终止条件');
  assert.deepEqual(task.ownership.write, [
    `${CONTENT_REL}/src/data/points/terminal-condition.json`,
    `${CONTENT_REL}/generation/animation-requests/terminal-condition.json`,
  ]);
  assert.ok(task.forbidden.includes(`${CONTENT_REL}/src/data/index.json`));
  assert.ok(task.forbidden.includes(`${CONTENT_REL}/generation/manifest.json`));
  assert.ok(task.forbidden.includes(`${TASKS_REL}/content/terminal-condition.json`));
  assert.deepEqual(task.contracts, [
    `${SKILL_ROOT}/SKILL.md`,
    `${SKILL_ROOT}/content-worker-brief.md`,
    `${SKILL_ROOT}/data-contract.md`,
    `${SKILL_ROOT}/animation-contract.md`,
    `${SKILL_ROOT}/schemas/point.schema.json`,
    `${SKILL_ROOT}/schemas/animation-request.schema.json`,
  ]);
  assert.deepEqual(task.course, readJson(session.contentRoot, 'src/data/course.json'));
  assert.deepEqual(task.scope, { ...manifest.subject, evidenceMode: 'model-only' });
  assert.deepEqual(task.indexEntry, index.points[2]);
  assert.deepEqual(task.sequence, {
    order: 3,
    previousPointId: 'state-transition',
    nextPointId: 'pending-point-004',
  });
  assert.equal(task.registryPath, `${TASKS_REL}/registry.json`);
  assert.equal('evidence' in task, false);
  assert.equal(
    readText(session.tasksRoot, 'content/terminal-condition.json'),
    `${JSON.stringify(task, null, 2)}\n`,
  );
  assert.deepEqual(
    readJson(session.tasksRoot, 'content/pending-point-005.json').sequence,
    { order: 5, previousPointId: 'pending-point-004', nextPointId: null },
  );
});

test('registry.json 每个知识点恰好占一行且可完整解析', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  appendPendingPoints(session.contentRoot, 6);
  const index = readJson(session.contentRoot, 'src/data/index.json');

  prepareContent(session);
  const text = readText(session.tasksRoot, 'registry.json');
  const expectedPoints = index.points.map((point) => ({
    id: point.id,
    title: point.title,
    difficulty: point.difficulty,
    shortSummary: point.shortSummary,
  }));
  assert.deepEqual(JSON.parse(text), {
    schema_version: 'course-worker-registry/1.0',
    courseId: COURSE_ID,
    points: expectedPoints,
  });
  const lines = text.split('\n');
  for (const point of expectedPoints) {
    const owners = lines.filter((line) => line.includes(`"id":"${point.id}"`));
    assert.equal(owners.length, 1, point.id);
    assert.deepEqual(JSON.parse(owners[0].trim().replace(/,$/, '')), point);
  }
  assert.ok(lines.every((line) => line.length < 2000));
  assert.ok(text.endsWith('}\n'));
});

test('教材 v2 任务包按 pointEvidence 顺序注入 ref 证据且不含哈希', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  const manifest = configureTextbookSession(session);

  const summary = prepareContent(session);
  assert.equal(summary.pending, 3);

  const extension = readJson(session.tasksRoot, 'content/state-transition.json');
  assert.equal(extension.scope.evidenceMode, 'textbook-grounded');
  assert.equal(extension.scope.contentContract, 'textbook-content/2.0');
  assert.equal(extension.contracts.at(-1), `${SKILL_ROOT}/schemas/textbook-content.schema.json`);
  assert.deepEqual(extension.evidence, {
    origin: 'llm-extension',
    anchorPointId: 'input-state',
    markdownPath: `textbook-input/${DOCUMENT_ID}/full.md`,
    spans: manifest.pointEvidence[1].sourceSpans.map((span) => ({
      ref: span.blockIds[0],
      headingPath: span.headingPath,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      assetRefs: span.assetRefs,
    })),
  });
  assert.ok(extension.forbidden.includes(`textbook-input/${DOCUMENT_ID}/full.md`));
  assert.ok(extension.forbidden.includes(`pipeline/${COURSE_ID}/textbook-outline.json`));

  const first = readJson(session.tasksRoot, 'content/input-state.json');
  assert.equal('anchorPointId' in first.evidence, false);
  assert.deepEqual(first.evidence.spans[0].assetRefs, ['images/state.png']);

  const last = readJson(session.tasksRoot, 'content/terminal-condition.json');
  assert.deepEqual(
    last.evidence.spans.map((span) => span.ref),
    ['block-005', 'block-006+block-007'],
  );
  const serialized = readText(session.tasksRoot, 'content/terminal-condition.json');
  assert.doesNotMatch(serialized, /excerptSha256|materialId/);
});

test('同一点内 sourceSpans ref 不唯一时失败且不写任何任务包', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  const manifest = configureTextbookSession(session);
  const evidence = manifest.pointEvidence[0];
  evidence.sourceSpans[1] = {
    ...evidence.sourceSpans[1],
    blockIds: [...evidence.sourceSpans[0].blockIds],
  };
  writeJson(session.contentRoot, 'generation/manifest.json', manifest);

  assert.throws(() => prepareContent(session), /ref 不唯一: block-001/);
  assert.equal(existsSync(session.tasksRoot), false);
});

test('教材课程缺少 Markdown 绑定时拒绝生成任务包', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  configureTextbookSession(session);
  const binding = readJson(session.sessionRoot, 'textbook-binding.json');
  binding.input_markdown_path = 'textbook-input/other/full.md';
  writeJson(session.sessionRoot, 'textbook-binding.json', binding);

  assert.throws(() => prepareContent(session), /input_markdown_path/);
});

test('重跑幂等：无变化不写文件，已开始的点保留任务包，只删除不在 index 中的旧任务包', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  appendPendingPoints(session.contentRoot, 4);
  const placeholderBefore = readText(session.contentRoot, 'src/data/points/input-state.json');

  const first = prepareContent(session);
  assert.equal(first.changedFiles, 6);
  assert.equal(first.removedTasks, 0);
  assert.equal(
    readText(session.contentRoot, 'src/data/points/input-state.json'),
    placeholderBefore,
  );

  const second = prepareContent(session);
  assert.equal(second.changedFiles, 0);
  assert.equal(second.removedTasks, 0);

  // 写坏的草稿也算已开始；它的任务包必须保留，repair task 才有可信输入。
  writeText(session.contentRoot, 'src/data/points/input-state.json', '{"id": "input-state",');
  const third = prepareContent(session);
  assert.equal(third.started, 1);
  assert.equal(third.removedTasks, 0);
  assert.equal(third.changedFiles, 1);
  assert.deepEqual(readJson(session.tasksRoot, 'content-plan.json').started, ['input-state']);
  assert.deepEqual(
    listTaskFiles(session, 'content'),
    [...POINT_IDS, 'pending-point-004'].map((id) => `${id}.json`).sort(),
  );

  const index = readJson(session.contentRoot, 'src/data/index.json');
  index.points = index.points.filter((point) => point.id !== 'pending-point-004');
  writeJson(session.contentRoot, 'src/data/index.json', index);
  writeText(session.tasksRoot, 'content/.stale-temporary', 'x');
  const fourth = prepareContent(session);
  assert.equal(fourth.removedTasks, 2);
  assert.deepEqual(
    listTaskFiles(session, 'content'),
    POINT_IDS.map((id) => `${id}.json`).sort(),
  );
});

test('计划文件每波一行，大课程在 k=1 时仍远低于 read 的行数与单行长度上限', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  const appended = appendPendingPoints(session.contentRoot, 600);
  const allIds = [...POINT_IDS, ...appended];
  // 一半知识点已开始，started 列表按字符预算折行而不是逐 ID 换行。
  for (const pointId of allIds.slice(300)) {
    writeJson(session.contentRoot, `src/data/points/${pointId}.json`, { id: pointId });
  }

  for (const concurrency of [1, 10]) {
    prepareContent(session, concurrency);
    const text = readText(session.tasksRoot, 'content-plan.json');
    const plan = JSON.parse(text);
    assert.deepEqual([...plan.canary, ...plan.waves.flat()], allIds.slice(0, 300));
    assert.deepEqual(plan.started, allIds.slice(300));
    const lines = text.split('\n');
    assert.ok(lines.length < plan.waves.length + 30, `${concurrency}: ${lines.length}`);
    assert.ok(lines.every((line) => line.length < 2000));
    assert.ok(text.endsWith('}\n'));
  }
  const plan = readText(session.tasksRoot, 'content-plan.json').split('\n');
  const waveLines = plan.filter((line) => line.startsWith('    ["'));
  assert.equal(waveLines.length, 30);
  assert.equal(JSON.parse(waveLines[0].trim().replace(/,$/, '')).length, 10);
});

test('researched 课程的任务包携带本点 pointEvidence 与对应来源记录', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  const manifest = readJson(session.contentRoot, 'generation/manifest.json');
  manifest.generation.evidenceMode = 'researched';
  manifest.sources = ['src-a', 'src-b', 'src-c'].map((id, position) => ({
    id,
    type: position === 0 ? 'textbook' : 'paper',
    title: `来源 ${id}`,
    locator: `https://example.com/${id}`,
    accessedAt: '2026-07-16',
  }));
  manifest.pointEvidence.forEach((evidence, position) => {
    evidence.sourceRefs = position === 1 ? ['src-c', 'src-a'] : ['src-b'];
  });
  writeJson(session.contentRoot, 'generation/manifest.json', manifest);

  prepareContent(session);
  const task = readJson(session.tasksRoot, 'content/state-transition.json');
  assert.equal('evidence' in task, false);
  assert.deepEqual(task.sourceEvidence, {
    pointEvidence: manifest.pointEvidence[1],
    sources: [manifest.sources[2], manifest.sources[0]],
  });

  manifest.pointEvidence[0].sourceRefs = ['src-missing'];
  writeJson(session.contentRoot, 'generation/manifest.json', manifest);
  assert.throws(() => prepareContent(session), /src-missing/);
});

test('缺少 init-points 占位或任务合同时给出明确错误', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  rmSync(join(session.contentRoot, 'generation/animation-requests/state-transition.json'));
  assert.throws(() => prepareContent(session), /请先运行 init-points/);

  writePlaceholders(session.contentRoot, ['state-transition']);
  rmSync(join(session.sessionRoot, SKILL_ROOT, 'content-worker-brief.md'));
  assert.throws(() => prepareContent(session), /content-worker-brief\.md/);
  assert.equal(existsSync(session.tasksRoot), false);
});

test('拒绝非标准内容目录与任务目录中的符号链接', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  assert.throws(
    () => prepareWorkerTasks(join(session.sessionRoot, 'pipeline'), { kind: 'content', env: {} }),
    /标准工作区/,
  );
  assert.throws(
    () => prepareWorkerTasks(session.contentRoot, { kind: 'points', env: {} }),
    /--kind/,
  );

  mkdirSync(join(session.tasksRoot, 'content'), { recursive: true });
  symlinkSync(
    join(session.contentRoot, 'src/data/index.json'),
    join(session.tasksRoot, 'content', 'input-state.json'),
  );
  assert.throws(() => prepareContent(session), /符号链接|普通文件/);
  rmSync(session.tasksRoot, { recursive: true, force: true });

  symlinkSync(join(session.sessionRoot, 'pipeline'), session.tasksRoot);
  assert.throws(() => prepareContent(session), /符号链接/);
});

test('prepare-animation-tasks 为全部组件生成任务包，计划只调度占位组件', (t) => {
  const session = createWorkerSession(t);
  const manifest = readJson(session.contentRoot, 'generation/animation-manifest.json');
  manifest.animations.push(
    animationEntry('inputSnapshot', 'InputSnapshot', 'input-state'),
    animationEntry('terminalCheck', 'TerminalCheck', 'terminal-condition'),
  );
  writeJson(session.contentRoot, 'generation/animation-manifest.json', manifest);
  for (const component of ['InputSnapshot', 'TerminalCheck']) {
    writeText(session.contentRoot, `src/animations/${component}.tsx`, '{}\n');
    writeText(session.contentRoot, `src/animations/${component}.css`, '{}\n');
  }

  const summary = prepareWorkerTasks(session.contentRoot, {
    kind: 'animations',
    env: env(1),
  });
  assert.deepEqual(
    {
      kind: summary.kind,
      components: summary.components,
      tasks: summary.tasks,
      pending: summary.pending,
      started: summary.started,
      canary: summary.canary,
      waves: summary.waves,
    },
    {
      kind: 'animation',
      components: 3,
      tasks: 3,
      pending: 2,
      started: 1,
      canary: ['InputSnapshot'],
      waves: 1,
    },
  );
  assert.deepEqual(readJson(session.tasksRoot, 'animation-plan.json'), {
    schema_version: 'course-worker-plan/1.0',
    courseId: COURSE_ID,
    kind: 'animation',
    concurrency: 1,
    canary: ['InputSnapshot'],
    waves: [['TerminalCheck']],
    started: ['StateTransition'],
    taskDir: `${TASKS_REL}/animations`,
  });
  assert.deepEqual(
    listTaskFiles(session, 'animations'),
    ['InputSnapshot.json', 'StateTransition.json', 'TerminalCheck.json'],
  );

  const task = readJson(session.tasksRoot, 'animations/TerminalCheck.json');
  assert.equal(task.schema_version, 'course-worker-task/1.0');
  assert.equal(task.kind, 'animation');
  assert.equal(task.component, 'TerminalCheck');
  assert.deepEqual(task.animation, manifest.animations[2]);
  assert.deepEqual(task.ownership.write, [
    `${CONTENT_REL}/src/animations/TerminalCheck.tsx`,
    `${CONTENT_REL}/src/animations/TerminalCheck.css`,
  ]);
  assert.deepEqual(task.boundPoints, [{
    id: 'terminal-condition',
    title: '终止条件',
    pointFile: `${CONTENT_REL}/src/data/points/terminal-condition.json`,
  }]);
  assert.deepEqual(task.contracts, [
    `${SKILL_ROOT}/SKILL.md`,
    `${SKILL_ROOT}/animation-worker-brief.md`,
    `${SKILL_ROOT}/animation-contract.md`,
  ]);
  assert.ok(task.forbidden.includes(`${CONTENT_REL}/src/data/points/terminal-condition.json`));
  assert.ok(task.forbidden.includes(`${CONTENT_REL}/generation/animation-manifest.json`));
  assert.ok(task.forbidden.includes(`${TASKS_REL}/animation-plan.json`));
  assert.equal(existsSync(join(session.tasksRoot, 'registry.json')), false);
});

test('prepare-animation-tasks 要求先运行 init-animations', (t) => {
  const session = createWorkerSession(t);
  const manifest = readJson(session.contentRoot, 'generation/animation-manifest.json');
  manifest.animations.push(animationEntry('inputSnapshot', 'InputSnapshot', 'input-state'));
  writeJson(session.contentRoot, 'generation/animation-manifest.json', manifest);

  assert.throws(
    () => prepareWorkerTasks(session.contentRoot, { kind: 'animations', env: {} }),
    /请先运行 init-animations/,
  );
});

test('CLI 只输出单行 JSON 摘要而不枚举全部知识点', (t) => {
  const session = createWorkerSession(t);
  writePlaceholders(session.contentRoot, POINT_IDS);
  appendPendingPoints(session.contentRoot, 20);

  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--root', session.contentRoot, '--kind', 'content'],
    {
      encoding: 'utf8',
      env: { ...process.env, COURSE_WORKER_CONCURRENCY: '4' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.concurrency, 4);
  assert.equal(summary.pending, 20);
  assert.equal(summary.waves, 5);
  assert.equal(summary.plan, `${TASKS_REL}/content-plan.json`);
  assert.doesNotMatch(result.stdout, /pending-point-020/);

  const failure = spawnSync(
    process.execPath,
    [SCRIPT, '--root', join(session.sessionRoot, 'pipeline'), '--kind', 'content'],
    { encoding: 'utf8' },
  );
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /任务包生成失败/);
});
