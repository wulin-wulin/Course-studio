import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  createCourseFixture,
  readJson,
  writeJson,
  writeText,
} from './test-fixture.mjs';

export const COURSE_ID = 'state-machines';
export const DOCUMENT_ID = 'doc-state-machines';
export const SKILL_ROOT = '.opencode/skills/candidate-knowledge-point-generator';

const CONTRACT_FILES = [
  'SKILL.md',
  'content-worker-brief.md',
  'animation-worker-brief.md',
  'data-contract.md',
  'animation-contract.md',
  'schemas/point.schema.json',
  'schemas/animation-request.schema.json',
  'schemas/textbook-content.schema.json',
];

const MECHANISM = {
  inputs: '当前状态与触发条件',
  changingState: '系统当前状态',
  transitionRule: '满足触发条件后应用确定的状态转移规则',
  terminalState: '到达没有后续转移的终止状态',
  replayMode: 'restart',
};

// 把单包 fixture 放进真实会话布局：<session>/pipeline/<course-id>/course-content。
export function createWorkerSession(t) {
  const { root: fixtureRoot } = createCourseFixture(t);
  const sessionRoot = mkdtempSync(join(tmpdir(), 'worker-tasks-test-'));
  t.after(() => rmSync(sessionRoot, { recursive: true, force: true }));
  const contentRoot = join(sessionRoot, 'pipeline', COURSE_ID, 'course-content');
  mkdirSync(dirname(contentRoot), { recursive: true });
  cpSync(fixtureRoot, contentRoot, { recursive: true });
  for (const file of CONTRACT_FILES) {
    writeText(sessionRoot, `${SKILL_ROOT}/${file}`, `# ${file}\n`);
  }
  return {
    sessionRoot,
    contentRoot,
    courseRoot: dirname(contentRoot),
    tasksRoot: join(dirname(contentRoot), 'worker-tasks'),
  };
}

export function writePlaceholders(contentRoot, pointIds) {
  for (const pointId of pointIds) {
    writeJson(contentRoot, `src/data/points/${pointId}.json`, {});
    writeJson(contentRoot, `generation/animation-requests/${pointId}.json`, {});
  }
}

// 追加成对 {} 占位的知识点，使 index、manifest 与占位保持一致。
export function appendPendingPoints(contentRoot, totalPointCount) {
  const index = readJson(contentRoot, 'src/data/index.json');
  const manifest = readJson(contentRoot, 'generation/manifest.json');
  const pendingIds = [];
  for (
    let pointNumber = index.points.length + 1;
    pointNumber <= totalPointCount;
    pointNumber += 1
  ) {
    const suffix = String(pointNumber).padStart(3, '0');
    const id = `pending-point-${suffix}`;
    const title = `待生成知识点 ${suffix}`;
    pendingIds.push(id);
    index.points.push({ ...structuredClone(index.points[0]), id, title });
    manifest.pointEvidence.push({
      pointId: id,
      title,
      kind: 'concept',
      sourceRefs: [],
      confidence: 0.6,
      scopeStatus: 'core',
    });
  }
  manifest.generation.pointCount = index.points.length;
  writeJson(contentRoot, 'src/data/index.json', index);
  writeJson(contentRoot, 'generation/manifest.json', manifest);
  writePlaceholders(contentRoot, pendingIds);
  return pendingIds;
}

export function textbookSpan(blockIds, lineStart) {
  return {
    materialId: DOCUMENT_ID,
    blockIds,
    headingPath: ['状态机基础', `正文 ${lineStart}`],
    lineStart,
    lineEnd: lineStart + 3,
    page: 2,
    assetRefs: lineStart === 1 ? ['images/state.png'] : [],
    excerptSha256: lineStart.toString(16).padStart(64, '0'),
  };
}

// 配置 textbook-content/2.0 教材会话：每点两个 span，第二个点为扩展点，最后一个点的
// 第二个 span 由两个 block 组成，用来覆盖 "a+b" 形式的 ref。
export function configureTextbookSession(session) {
  const { sessionRoot, contentRoot, courseRoot } = session;
  const manifest = readJson(contentRoot, 'generation/manifest.json');
  manifest.generation.evidenceMode = 'textbook-grounded';
  manifest.generation.contentContract = 'textbook-content/2.0';
  manifest.sources = [{
    id: 'src-textbook',
    type: 'textbook',
    title: '状态机基础教材',
    locator: `textbook-input/${DOCUMENT_ID}/full.md`,
    accessedAt: '2026-07-16',
  }];
  const lastIndex = manifest.pointEvidence.length - 1;
  manifest.pointEvidence.forEach((evidence, index) => {
    evidence.sourceRefs = ['src-textbook'];
    evidence.origin = index === 1 ? 'llm-extension' : 'textbook';
    evidence.confidence = 0.8;
    delete evidence.modelEnriched;
    const firstLine = index * 10 + 1;
    evidence.sourceSpans = [
      textbookSpan([`block-${String(index * 2 + 1).padStart(3, '0')}`], firstLine),
      textbookSpan(
        index === lastIndex
          ? [`block-${String(index * 2 + 2).padStart(3, '0')}`, `block-${String(index * 2 + 3).padStart(3, '0')}`]
          : [`block-${String(index * 2 + 2).padStart(3, '0')}`],
        firstLine + 5,
      ),
    ];
  });
  writeJson(contentRoot, 'generation/manifest.json', manifest);

  const index = readJson(contentRoot, 'src/data/index.json');
  writeJson(courseRoot, 'textbook-outline.json', {
    schema_version: 'textbook-outline/1.0',
    document_id: DOCUMENT_ID,
    course: { id: COURSE_ID, title: '状态机基础' },
    chapters: [{
      id: 'chapter-1',
      title: '状态机',
      order: 0,
      points: index.points.map((point, position) => ({
        id: point.id,
        title: point.title,
        order: position,
        origin: position === 1 ? 'llm-extension' : 'textbook',
        ...(position === 1 ? { anchor_point_id: index.points[0].id } : {}),
      })),
    }],
  });
  writeJson(sessionRoot, 'textbook-binding.json', {
    schema_version: 'textbook-binding/1.0',
    document_id: DOCUMENT_ID,
    course_id: COURSE_ID,
    output_outline_path: `pipeline/${COURSE_ID}/textbook-outline.json`,
    input_material_path: `textbook-input/${DOCUMENT_ID}/material.json`,
    input_markdown_path: `textbook-input/${DOCUMENT_ID}/full.md`,
  });
  writeText(sessionRoot, `textbook-input/${DOCUMENT_ID}/full.md`, '# 状态机基础\n\n正文。\n');
  return manifest;
}

function addTeachingPlan(point) {
  point.content.blocks.forEach((block) => {
    block.moduleId = 'concept-and-practice';
    block.depth = 'core';
  });
  point.content.learningDesign = {
    primaryPattern: 'concept-example-check',
    adaptationLevel: 'balanced',
    editorialPolicy: '保持教材事实与边界，围绕迁移目标补充例题。',
    estimatedMinutes: 12,
    outcomes: [
      { id: 'explain-concept', text: '解释概念及其边界。' },
      { id: 'apply-concept', text: '在新情境中应用概念。' },
    ],
    misconceptions: ['把边界之外的情形也视为该概念。'],
    modules: [{
      id: 'concept-and-practice',
      title: '概念与练习',
      role: 'worked-example',
      outcomeRefs: ['explain-concept', 'apply-concept'],
      order: 0,
    }],
    completion: {
      exerciseBlockId: 'model-example',
      outcomeRefs: ['explain-concept', 'apply-concept'],
      method: '完成迁移练习。',
      successCriteria: ['结论正确', '依据清楚'],
    },
  };
  point.content.learningAssets = [{
    id: 'concept-check',
    type: 'formative-check',
    anchorBlockId: 'model-example',
    moduleId: 'concept-and-practice',
    depth: 'core',
    outcomeRefs: ['apply-concept'],
    learningPurpose: '检查学习者能否迁移教材概念。',
    grounding: { basedOnBlockIds: ['textbook-context'] },
    config: { attempts: 2 },
    fallback: { type: 'markdown', markdown: '请写出判断和教材依据。' },
  }];
}

// 模拟 worker 按任务包写入教材 v2 详情：教材块 sourceSpans 写成 ref 字符串（或任意 span 项）。
export function writeTextbookDraft(contentRoot, pointId, sourceSpans, { origin = 'textbook' } = {}) {
  const index = readJson(contentRoot, 'src/data/index.json');
  const entry = index.points.find((point) => point.id === pointId);
  const point = {
    ...structuredClone(entry),
    animationType: 'none',
    prerequisites: [],
    origin,
    content: {
      schema_version: 'textbook-content/2.0',
      blocks: [
        {
          id: 'textbook-context',
          kind: 'explanation',
          title: '教材上下文',
          markdown: `教材对${entry.title}给出了定义、条件和适用范围。`,
          provenance: {
            origin: 'textbook',
            representation: 'paraphrase',
            sourceSpans,
          },
        },
        {
          id: 'model-example',
          kind: 'example',
          title: '补充示例',
          markdown: `用一个新的情境说明${entry.title}如何应用，并指出边界。`,
          provenance: {
            origin: 'model',
            basedOnBlockIds: ['textbook-context'],
          },
        },
      ],
    },
  };
  addTeachingPlan(point);
  writeJson(contentRoot, `src/data/points/${pointId}.json`, point);
  writeJson(contentRoot, `generation/animation-requests/${pointId}.json`, {
    schema_version: 'animation-request/1.0',
    pointId,
    needed: false,
    rationale: '该知识点以静态定义和边界说明为主，不需要独立动画。',
  });
  return point;
}

export function animationEntry(type, component, pointId) {
  return {
    type,
    component,
    title: `${component} 过程`,
    mechanism: structuredClone(MECHANISM),
    bindings: [{ pointId, suggestion: `展示 ${pointId} 的状态如何逐步变化。` }],
  };
}
