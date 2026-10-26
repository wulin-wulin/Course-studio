#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  formatErrors,
  isDirectRun,
  isRecord,
  listSymbolicLinks,
} from './lib/common.mjs';
import {
  ID_PATTERN,
  TEXTBOOK_CONTENT_SCHEMA,
  checkAnimationManifest,
} from './lib/contracts.mjs';
import {
  safeWriteTransaction,
  serializeJson,
} from './lib/safe-write.mjs';
import {
  buildSourceSpanRefMap,
  sourceSpanRef,
} from './lib/source-span-refs.mjs';
import {
  DEFAULT_WORKER_CONCURRENCY,
  MAX_WORKER_CONCURRENCY,
  planWorkerWaves,
  resolveWorkerConcurrency,
  serializeWorkerPlan,
} from './lib/worker-plan.mjs';

export {
  DEFAULT_WORKER_CONCURRENCY,
  MAX_WORKER_CONCURRENCY,
  planWorkerWaves,
  resolveWorkerConcurrency,
};

export const WORKER_TASK_SCHEMA = 'course-worker-task/1.0';
export const WORKER_PLAN_SCHEMA = 'course-worker-plan/1.0';
export const WORKER_REGISTRY_SCHEMA = 'course-worker-registry/1.0';

const CONTENT_CANARY_SIZE = 3;
const ANIMATION_CANARY_SIZE = 1;
const KINDS = new Set(['content', 'animations']);
const SKILL_ROOT = '.opencode/skills/candidate-knowledge-point-generator';

function fail(message) {
  throw new Error(message);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function isInside(root, target) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot !== ''
    && pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
  );
}

// 从会话根目录逐段检查到目标：拒绝符号链接，祖先必须是目录；尚不存在的后缀段放行。
function assertSafeChain(sessionRoot, target, label) {
  if (!isInside(sessionRoot, target)) {
    fail(`${label}越过课程会话目录: ${target}`);
  }
  const segments = relative(sessionRoot, target).split(sep).filter(Boolean);
  let current = sessionRoot;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = lstatOrNull(current);
    if (stat === null) return;
    if (stat.isSymbolicLink()) fail(`${label}路径不允许符号链接: ${current}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      fail(`${label}路径的祖先不是目录: ${current}`);
    }
  }
}

function sessionPath(workspace, target) {
  return relative(workspace.sessionRoot, target).split(sep).join('/');
}

function assertRegularFile(workspace, target, label) {
  assertSafeChain(workspace.sessionRoot, target, label);
  const stat = lstatOrNull(target);
  if (stat === null) fail(`缺少${label}: ${sessionPath(workspace, target)}`);
  if (!stat.isFile()) fail(`${label}必须是普通文件: ${sessionPath(workspace, target)}`);
}

function readSafeJson(workspace, target, label) {
  assertRegularFile(workspace, target, label);
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    fail(`${label}不是有效 JSON: ${sessionPath(workspace, target)}: ${error.message}`);
  }
}

function resolveWorkspace(contentRoot) {
  if (typeof contentRoot !== 'string' || contentRoot.trim() === '') {
    fail('--root 必须是非空目录');
  }
  const resolvedContent = resolve(contentRoot);
  const courseRoot = dirname(resolvedContent);
  const pipelineRoot = dirname(courseRoot);
  const courseId = basename(courseRoot);
  if (
    basename(resolvedContent) !== 'course-content'
    || !ID_PATTERN.test(courseId)
    || basename(pipelineRoot) !== 'pipeline'
  ) {
    fail('任务包只接受 pipeline/<course-id>/course-content 标准工作区');
  }
  const sessionRoot = dirname(pipelineRoot);
  assertSafeChain(sessionRoot, resolvedContent, '内容包');
  const contentStat = lstatOrNull(resolvedContent);
  if (contentStat === null || !contentStat.isDirectory()) {
    fail(`内容包不是目录: pipeline/${courseId}/course-content`);
  }
  const symbolicLinks = listSymbolicLinks(resolvedContent);
  if (symbolicLinks.length > 0) {
    fail(`内容包必须自包含，不允许符号链接: ${symbolicLinks.join(', ')}`);
  }

  const tasksRoot = join(courseRoot, 'worker-tasks');
  assertSafeChain(sessionRoot, tasksRoot, '任务包目录');
  return {
    sessionRoot,
    courseRoot,
    contentRoot: resolvedContent,
    tasksRoot,
    courseId,
    contentRel: `pipeline/${courseId}/course-content`,
    tasksRel: `pipeline/${courseId}/worker-tasks`,
  };
}

function readJsonPlaceholderState(workspace, target, label) {
  assertSafeChain(workspace.sessionRoot, target, label);
  const stat = lstatOrNull(target);
  if (stat === null) return 'missing';
  if (!stat.isFile()) fail(`${label}必须是普通文件: ${sessionPath(workspace, target)}`);
  try {
    const value = JSON.parse(readFileSync(target, 'utf8'));
    return isRecord(value) && Object.keys(value).length === 0
      ? 'placeholder'
      : 'started';
  } catch {
    // 无法解析说明 worker 已经开始写入；错误交给草稿校验报告。
    return 'started';
  }
}

function readTextPlaceholderState(workspace, target, label) {
  assertSafeChain(workspace.sessionRoot, target, label);
  const stat = lstatOrNull(target);
  if (stat === null) return 'missing';
  if (!stat.isFile()) fail(`${label}必须是普通文件: ${sessionPath(workspace, target)}`);
  return readFileSync(target, 'utf8').trim() === '{}' ? 'placeholder' : 'started';
}

function loadIndex(workspace) {
  const course = readSafeJson(
    workspace,
    join(workspace.contentRoot, 'src/data/course.json'),
    '课程元数据',
  );
  const index = readSafeJson(
    workspace,
    join(workspace.contentRoot, 'src/data/index.json'),
    '课程索引',
  );
  if (!isRecord(course) || course.id !== workspace.courseId) {
    fail('src/data/course.json 的 id 必须与课程目录一致');
  }
  if (
    !isRecord(index)
    || index.courseId !== workspace.courseId
    || !Array.isArray(index.points)
    || index.points.length < 1
  ) {
    fail('src/data/index.json 必须属于当前课程且至少包含 1 个知识点');
  }
  const seen = new Set();
  index.points.forEach((point, position) => {
    if (
      !isRecord(point)
      || typeof point.id !== 'string'
      || !ID_PATTERN.test(point.id)
      || seen.has(point.id)
      || typeof point.title !== 'string'
      || point.title.trim() === ''
    ) {
      fail(`src/data/index.json.points[${position}] 的 id/title 非法或重复`);
    }
    seen.add(point.id);
  });
  return { course, index };
}

function existingSessionFiles(workspace, relativePaths) {
  return relativePaths.filter((relativePath) => (
    lstatOrNull(join(workspace.sessionRoot, ...relativePath.split('/'))) !== null
  ));
}

// worker 永远不得写入的共享文件；任务包自身和计划也属于受信产物。
function sharedForbiddenPaths(workspace) {
  const content = workspace.contentRel;
  return [
    `${content}/src/data/course.json`,
    `${content}/src/data/index.json`,
    `${content}/src/data/courseKnowledge.ts`,
    `${content}/src/components/AnimationBlock.tsx`,
    `${content}/src/components/AnimationBlock.css`,
    `${content}/generation/manifest.json`,
    `${content}/generation/animation-manifest.json`,
    `pipeline/${workspace.courseId}/clustered-graph.json`,
    ...existingSessionFiles(workspace, [
      `pipeline/${workspace.courseId}/textbook-outline.json`,
    ]),
    `${workspace.tasksRel}/registry.json`,
  ];
}

function assertContractFiles(workspace, contracts) {
  for (const contract of contracts) {
    const target = join(workspace.sessionRoot, ...contract.split('/'));
    assertSafeChain(workspace.sessionRoot, target, '任务合同');
    const stat = lstatOrNull(target);
    if (stat === null || !stat.isFile()) {
      fail(
        `缺少任务合同文件: ${contract}；请确认课程会话已同步最新的 candidate-knowledge-point-generator Skill`,
      );
    }
  }
}

function contentContracts(manifest) {
  return [
    `${SKILL_ROOT}/SKILL.md`,
    `${SKILL_ROOT}/content-worker-brief.md`,
    `${SKILL_ROOT}/data-contract.md`,
    `${SKILL_ROOT}/animation-contract.md`,
    `${SKILL_ROOT}/schemas/point.schema.json`,
    `${SKILL_ROOT}/schemas/animation-request.schema.json`,
    ...(manifest.generation.contentContract === TEXTBOOK_CONTENT_SCHEMA
      ? [`${SKILL_ROOT}/schemas/textbook-content.schema.json`]
      : []),
  ];
}

function animationContracts() {
  return [
    `${SKILL_ROOT}/SKILL.md`,
    `${SKILL_ROOT}/animation-worker-brief.md`,
    `${SKILL_ROOT}/animation-contract.md`,
  ];
}

function isSafeDocumentId(value) {
  return (
    typeof value === 'string'
    && value.trim() !== ''
    && value === value.trim()
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..'
  );
}

// 按 validate-textbook-outline.mjs 的方式定位绑定教材：textbook-binding.json 的
// input_markdown_path 必须指向 textbook-input/<outline.document_id>/full.md。
function loadTextbookEvidenceContext(workspace, manifest) {
  if (manifest.generation.evidenceMode !== 'textbook-grounded') return null;
  const outline = readSafeJson(
    workspace,
    join(workspace.courseRoot, 'textbook-outline.json'),
    '教材结构',
  );
  const documentId = isRecord(outline) ? outline.document_id : null;
  if (!isSafeDocumentId(documentId)) {
    fail('教材结构 document_id 不能用于定位教材正文');
  }
  const binding = readSafeJson(
    workspace,
    join(workspace.sessionRoot, 'textbook-binding.json'),
    '教材绑定记录',
  );
  const markdownPath = `textbook-input/${documentId}/full.md`;
  if (
    !isRecord(binding)
    || binding.document_id !== documentId
    || binding.input_markdown_path !== markdownPath
  ) {
    fail(`教材绑定记录必须把 input_markdown_path 指向 ${markdownPath}`);
  }
  assertRegularFile(
    workspace,
    join(workspace.sessionRoot, 'textbook-input', documentId, 'full.md'),
    '教材 Markdown 正文',
  );

  const anchors = new Map();
  for (const chapter of Array.isArray(outline.chapters) ? outline.chapters : []) {
    for (const point of Array.isArray(chapter?.points) ? chapter.points : []) {
      if (
        isRecord(point)
        && typeof point.id === 'string'
        && typeof point.anchor_point_id === 'string'
      ) {
        anchors.set(point.id, point.anchor_point_id);
      }
    }
  }
  const evidenceById = new Map();
  for (const evidence of Array.isArray(manifest.pointEvidence) ? manifest.pointEvidence : []) {
    if (isRecord(evidence) && typeof evidence.pointId === 'string') {
      evidenceById.set(evidence.pointId, evidence);
    }
  }
  return {
    documentId,
    markdownPath,
    anchors,
    evidenceById,
    usesTextbookContentV2: (
      manifest.generation.contentContract === TEXTBOOK_CONTENT_SCHEMA
    ),
  };
}

function buildPointEvidence(context, pointId) {
  const evidence = context.evidenceById.get(pointId);
  if (!isRecord(evidence)) {
    fail(`generation/manifest.json 缺少知识点 ${pointId} 的 pointEvidence`);
  }
  const label = `generation/manifest.json pointEvidence(${pointId}).sourceSpans`;
  const errors = [];
  buildSourceSpanRefMap(evidence.sourceSpans, label, errors);
  if (errors.length > 0) fail(errors.join('；'));

  const spans = evidence.sourceSpans.map((span, index) => {
    if (
      span.materialId !== context.documentId
      || !Array.isArray(span.headingPath)
      || !Array.isArray(span.assetRefs)
      || !Number.isInteger(span.lineStart)
      || !Number.isInteger(span.lineEnd)
    ) {
      fail(`${label}[${index}] 不是指向当前教材 ${context.documentId} 的有效 span`);
    }
    return {
      ref: sourceSpanRef(span),
      headingPath: structuredClone(span.headingPath),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      assetRefs: structuredClone(span.assetRefs),
    };
  });

  const result = { origin: evidence.origin };
  const anchorPointId = typeof evidence.anchorPointId === 'string'
    ? evidence.anchorPointId
    : context.anchors.get(pointId);
  if (typeof anchorPointId === 'string') result.anchorPointId = anchorPointId;
  result.markdownPath = context.markdownPath;
  result.spans = spans;
  if (!context.usesTextbookContentV2) {
    // 旧版教材契约要求在 point 顶层逐字复制 sourceSpans，finalize 不会为它展开 ref。
    result.sourceSpans = structuredClone(evidence.sourceSpans);
  }
  return result;
}

// 普通 researched 课程：把本点 pointEvidence 单项与其 sourceRefs 指向的来源记录原样写入任务包，
// worker 无需为了核对来源去读整份 manifest。
function buildResearchSourceEvidence(manifest, pointId) {
  const evidence = (Array.isArray(manifest.pointEvidence) ? manifest.pointEvidence : [])
    .find((item) => isRecord(item) && item.pointId === pointId);
  if (!isRecord(evidence) || !Array.isArray(evidence.sourceRefs)) {
    fail(`generation/manifest.json 缺少知识点 ${pointId} 的 pointEvidence.sourceRefs`);
  }
  const sourceById = new Map(
    (Array.isArray(manifest.sources) ? manifest.sources : [])
      .filter((source) => isRecord(source) && typeof source.id === 'string')
      .map((source) => [source.id, source]),
  );
  const sources = evidence.sourceRefs.map((sourceId) => {
    const source = sourceById.get(sourceId);
    if (source === undefined) {
      fail(`generation/manifest.json pointEvidence(${pointId}).sourceRefs 指向不存在的来源: ${sourceId}`);
    }
    return structuredClone(source);
  });
  return { pointEvidence: structuredClone(evidence), sources };
}

function serializeRegistry(courseId, points) {
  const lines = points.map((point) => `    ${JSON.stringify({
    id: point.id,
    title: point.title,
    difficulty: point.difficulty,
    shortSummary: point.shortSummary,
  })}`);
  return [
    '{',
    `  "schema_version": ${JSON.stringify(WORKER_REGISTRY_SCHEMA)},`,
    `  "courseId": ${JSON.stringify(courseId)},`,
    '  "points": [',
    lines.join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

function readExistingText(target) {
  const stat = lstatOrNull(target);
  if (stat === null || !stat.isFile()) return null;
  return readFileSync(target, 'utf8');
}

// 原子写入变化的产物，再删除任务目录中已不属于当前 index/清单的旧任务包。
function commitOutputs(workspace, outputs, taskDirectory) {
  for (const output of outputs) {
    assertSafeChain(workspace.sessionRoot, output.path, '任务包');
  }
  const expectedNames = new Set(
    outputs
      .filter((output) => dirname(output.path) === taskDirectory)
      .map((output) => basename(output.path)),
  );
  const stale = [];
  const directoryStat = lstatOrNull(taskDirectory);
  if (directoryStat !== null) {
    if (!directoryStat.isDirectory()) {
      fail(`任务包目录不是目录: ${sessionPath(workspace, taskDirectory)}`);
    }
    for (const entry of readdirSync(taskDirectory, { withFileTypes: true })) {
      const target = join(taskDirectory, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        fail(`任务包目录只能包含普通文件: ${sessionPath(workspace, target)}`);
      }
      if (!expectedNames.has(entry.name)) stale.push(target);
    }
  }

  const writes = outputs.filter((output) => (
    readExistingText(output.path) !== output.contents
  ));
  if (writes.length > 0) safeWriteTransaction(workspace.courseRoot, writes);
  for (const target of stale) {
    if (lstatOrNull(target)?.isFile()) unlinkSync(target);
  }
  return { changedFiles: writes.length, removedTasks: stale.length };
}

function prepareContentTasks(workspace, concurrency) {
  const { course, index } = loadIndex(workspace);
  const manifest = readSafeJson(
    workspace,
    join(workspace.contentRoot, 'generation/manifest.json'),
    '生成清单',
  );
  if (
    !isRecord(manifest)
    || !isRecord(manifest.subject)
    || !isRecord(manifest.generation)
  ) {
    fail('generation/manifest.json 必须包含 subject 与 generation');
  }

  const pending = [];
  const started = [];
  const missing = [];
  for (const point of index.points) {
    const pointState = readJsonPlaceholderState(
      workspace,
      join(workspace.contentRoot, 'src/data/points', `${point.id}.json`),
      '知识点详情',
    );
    const requestState = readJsonPlaceholderState(
      workspace,
      join(workspace.contentRoot, 'generation/animation-requests', `${point.id}.json`),
      '动画请求',
    );
    if (pointState === 'missing' || requestState === 'missing') {
      missing.push(point.id);
    } else if (pointState === 'placeholder' && requestState === 'placeholder') {
      pending.push(point);
    } else {
      started.push(point.id);
    }
  }
  if (missing.length > 0) {
    fail(
      `缺少 ${missing.length} 个知识点的详情或动画请求占位（例如 ${missing.slice(0, 3).join(', ')}），请先运行 init-points`,
    );
  }

  const contracts = contentContracts(manifest);
  assertContractFiles(workspace, contracts);
  const evidenceContext = loadTextbookEvidenceContext(workspace, manifest);
  const scope = {
    ...manifest.subject,
    evidenceMode: manifest.generation.evidenceMode,
    ...('contentContract' in manifest.generation
      ? { contentContract: manifest.generation.contentContract }
      : {}),
  };
  const registryPath = `${workspace.tasksRel}/registry.json`;
  const planPath = `${workspace.tasksRel}/content-plan.json`;
  const taskDir = `${workspace.tasksRel}/content`;
  const positionById = new Map(index.points.map((point, position) => [point.id, position]));
  const sharedForbidden = sharedForbiddenPaths(workspace);

  const outputs = [{
    path: join(workspace.tasksRoot, 'registry.json'),
    contents: serializeRegistry(workspace.courseId, index.points),
  }];
  // 为 index 中全部知识点生成任务包，计划只调度占位点：已开始的点在修复、恢复、全局复核或
  // G5 返工时，repair task 仍能读取同一份可信任务包，主智能体无需在提示中粘贴上下文。
  for (const point of index.points) {
    const position = positionById.get(point.id);
    const taskPath = `${taskDir}/${point.id}.json`;
    const task = {
      schema_version: WORKER_TASK_SCHEMA,
      kind: 'content',
      courseId: workspace.courseId,
      pointId: point.id,
      title: point.title,
      ownership: {
        write: [
          `${workspace.contentRel}/src/data/points/${point.id}.json`,
          `${workspace.contentRel}/generation/animation-requests/${point.id}.json`,
        ],
      },
      forbidden: [
        ...sharedForbidden,
        planPath,
        taskPath,
        ...(evidenceContext ? [evidenceContext.markdownPath] : []),
      ],
      contracts,
      course,
      scope,
      indexEntry: point,
      sequence: {
        order: position + 1,
        previousPointId: index.points[position - 1]?.id ?? null,
        nextPointId: index.points[position + 1]?.id ?? null,
      },
      registryPath,
    };
    if (evidenceContext) {
      task.evidence = buildPointEvidence(evidenceContext, point.id);
    } else if (manifest.generation.evidenceMode === 'researched') {
      task.sourceEvidence = buildResearchSourceEvidence(manifest, point.id);
    }
    outputs.push({
      path: join(workspace.tasksRoot, 'content', `${point.id}.json`),
      contents: serializeJson(task),
    });
  }

  const pendingIds = pending.map((point) => point.id);
  const { canary, waves } = planWorkerWaves(
    pendingIds,
    concurrency,
    CONTENT_CANARY_SIZE,
  );
  outputs.push({
    path: join(workspace.tasksRoot, 'content-plan.json'),
    contents: serializeWorkerPlan({
      schema_version: WORKER_PLAN_SCHEMA,
      courseId: workspace.courseId,
      kind: 'content',
      concurrency,
      canary,
      waves,
      started,
      taskDir,
    }),
  });
  const committed = commitOutputs(
    workspace,
    outputs,
    join(workspace.tasksRoot, 'content'),
  );
  return {
    courseId: workspace.courseId,
    kind: 'content',
    concurrency,
    points: index.points.length,
    tasks: index.points.length,
    pending: pendingIds.length,
    started: started.length,
    canary,
    waves: waves.length,
    taskDir,
    plan: planPath,
    registry: registryPath,
    ...committed,
  };
}

function prepareAnimationTasks(workspace, concurrency) {
  const { index } = loadIndex(workspace);
  const manifestLabel = 'generation/animation-manifest.json';
  const manifest = readSafeJson(
    workspace,
    join(workspace.contentRoot, manifestLabel),
    '动画清单',
  );
  const manifestErrors = [];
  checkAnimationManifest(manifest, manifestLabel, manifestErrors);
  if (manifestErrors.length > 0) {
    fail(formatErrors('动画清单不合法，不能生成动画任务包', manifestErrors));
  }

  const pointById = new Map(index.points.map((point) => [point.id, point]));
  const pending = [];
  const started = [];
  const missing = [];
  for (const animation of manifest.animations) {
    for (const binding of animation.bindings) {
      if (!pointById.has(binding.pointId)) {
        fail(`动画 ${animation.component} 绑定了 index 中不存在的知识点: ${binding.pointId}`);
      }
      const pointState = readJsonPlaceholderState(
        workspace,
        join(workspace.contentRoot, 'src/data/points', `${binding.pointId}.json`),
        '知识点详情',
      );
      if (pointState !== 'started') {
        fail(`动画 ${animation.component} 绑定的知识点 ${binding.pointId} 尚未生成详情`);
      }
    }
    const tsxState = readTextPlaceholderState(
      workspace,
      join(workspace.contentRoot, 'src/animations', `${animation.component}.tsx`),
      '动画组件',
    );
    const cssState = readTextPlaceholderState(
      workspace,
      join(workspace.contentRoot, 'src/animations', `${animation.component}.css`),
      '动画样式',
    );
    if (tsxState === 'missing' || cssState === 'missing') {
      missing.push(animation.component);
    } else if (tsxState === 'placeholder' && cssState === 'placeholder') {
      pending.push(animation);
    } else {
      started.push(animation.component);
    }
  }
  if (missing.length > 0) {
    fail(
      `缺少 ${missing.length} 个动画组件的 TSX/CSS 占位（例如 ${missing.slice(0, 3).join(', ')}），请先运行 init-animations`,
    );
  }

  const contracts = animationContracts();
  assertContractFiles(workspace, contracts);
  const planPath = `${workspace.tasksRel}/animation-plan.json`;
  const taskDir = `${workspace.tasksRel}/animations`;
  const sharedForbidden = sharedForbiddenPaths(workspace);
  const outputs = [];
  // 与内容任务相同：清单中每个组件都有任务包，计划只调度 TSX/CSS 仍为占位的组件。
  for (const animation of manifest.animations) {
    const component = animation.component;
    const boundPoints = animation.bindings.map((binding) => ({
      id: binding.pointId,
      title: pointById.get(binding.pointId).title,
      pointFile: `${workspace.contentRel}/src/data/points/${binding.pointId}.json`,
    }));
    outputs.push({
      path: join(workspace.tasksRoot, 'animations', `${component}.json`),
      contents: serializeJson({
        schema_version: WORKER_TASK_SCHEMA,
        kind: 'animation',
        courseId: workspace.courseId,
        component,
        title: animation.title,
        ownership: {
          write: [
            `${workspace.contentRel}/src/animations/${component}.tsx`,
            `${workspace.contentRel}/src/animations/${component}.css`,
          ],
        },
        forbidden: [
          ...sharedForbidden,
          planPath,
          `${taskDir}/${component}.json`,
          ...boundPoints.flatMap((point) => [
            point.pointFile,
            `${workspace.contentRel}/generation/animation-requests/${point.id}.json`,
          ]),
        ],
        contracts,
        animation,
        boundPoints,
      }),
    });
  }

  const pendingComponents = pending.map((animation) => animation.component);
  const { canary, waves } = planWorkerWaves(
    pendingComponents,
    concurrency,
    ANIMATION_CANARY_SIZE,
  );
  outputs.push({
    path: join(workspace.tasksRoot, 'animation-plan.json'),
    contents: serializeWorkerPlan({
      schema_version: WORKER_PLAN_SCHEMA,
      courseId: workspace.courseId,
      kind: 'animation',
      concurrency,
      canary,
      waves,
      started,
      taskDir,
    }),
  });
  const committed = commitOutputs(
    workspace,
    outputs,
    join(workspace.tasksRoot, 'animations'),
  );
  return {
    courseId: workspace.courseId,
    kind: 'animation',
    concurrency,
    components: manifest.animations.length,
    tasks: manifest.animations.length,
    pending: pendingComponents.length,
    started: started.length,
    canary,
    waves: waves.length,
    taskDir,
    plan: planPath,
    ...committed,
  };
}

export function prepareWorkerTasks(contentRoot, { kind, env = process.env } = {}) {
  if (!KINDS.has(kind)) fail('--kind 只能是 content 或 animations');
  const workspace = resolveWorkspace(contentRoot);
  const { concurrency, warning } = resolveWorkerConcurrency(env);
  const summary = kind === 'content'
    ? prepareContentTasks(workspace, concurrency)
    : prepareAnimationTasks(workspace, concurrency);
  return { ...summary, warnings: warning ? [warning] : [] };
}

export function parseArgs(argv) {
  let root = null;
  let kind = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--kind') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} 需要参数`);
      }
      if (argument === '--root') root = value;
      else kind = value;
      index += 1;
    } else if (argument.startsWith('--root=')) {
      root = argument.slice('--root='.length);
    } else if (argument.startsWith('--kind=')) {
      kind = argument.slice('--kind='.length);
    } else if (argument === '--help' || argument === '-h') {
      return { help: true, root, kind };
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('--root 为必填目录');
  }
  if (!KINDS.has(kind)) throw new Error('--kind 只能是 content 或 animations');
  return { help: false, root, kind };
}

function printUsage() {
  console.log(`用法:
  node scripts/prepare_worker_tasks.mjs --root <pipeline/<course-id>/course-content> --kind content|animations

content 为 index 中全部知识点生成 worker-tasks/content/*.json 与 registry.json，
content-plan.json 只调度仍是 {} 占位的知识点；
animations 为清单中全部组件生成 worker-tasks/animations/*.json，
animation-plan.json 只调度 TSX/CSS 仍是 {} 占位的组件。
并发数读取 COURSE_WORKER_CONCURRENCY（1–${MAX_WORKER_CONCURRENCY}，默认 ${DEFAULT_WORKER_CONCURRENCY}）。`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printUsage();
    return;
  }
  try {
    const summary = prepareWorkerTasks(options.root, { kind: options.kind });
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(`任务包生成失败: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
