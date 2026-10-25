import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildAnimationRegistry } from './build_animation_registry.mjs';
import { validateProject } from './validate_output.mjs';
import {
  ANIMATION_COMPONENT,
  createCourseFixture,
  fixturePath,
  readJson,
  readText,
  writeJson,
  writeText,
} from './test-fixture.mjs';

test('完整有动画输出包通过 all 校验', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  buildAnimationRegistry(root);

  const result = validateProject(root, { phase: 'all' });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.animationTypes, ['stateTransition']);
  assert.equal(result.counts.indexPoints, 3);
  assert.equal(result.counts.pointFiles, 3);
  assert.equal(result.counts.animationRequests, 3);
  assert.equal(result.counts.animations, 1);
});

test('完整无动画输出包通过 all 校验', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: false,
  });
  buildAnimationRegistry(root);

  const result = validateProject(root, { phase: 'all' });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.animationTypes, []);
  assert.equal(result.counts.animations, 0);
});

test('index 阶段在尚无 points 和动画文件时通过', (t) => {
  const { root } = createCourseFixture(t, {
    includeDetails: false,
  });

  const result = validateProject(root, { phase: 'index' });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.validatedPointIds, [
    'input-state',
    'state-transition',
    'terminal-condition',
  ]);
});

function appendPendingPointPlaceholders(root, totalPointCount) {
  const index = readJson(root, 'src/data/index.json');
  const manifest = readJson(root, 'generation/manifest.json');
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
    index.points.push({
      ...structuredClone(index.points[0]),
      id,
      title,
    });
    manifest.pointEvidence.push({
      pointId: id,
      title,
      kind: 'concept',
      sourceRefs: [],
      confidence: 0.6,
      scopeStatus: 'core',
    });
    writeJson(root, `src/data/points/${id}.json`, {});
    writeJson(root, `generation/animation-requests/${id}.json`, {});
  }
  manifest.generation.pointCount = index.points.length;
  writeJson(root, 'src/data/index.json', index);
  writeJson(root, 'generation/manifest.json', manifest);
  return pendingIds;
}

test('point-drafts 校验已完成批次并跳过 87 个成对占位', (t) => {
  const { root, pointIds } = createCourseFixture(t);
  const pendingIds = appendPendingPointPlaceholders(root, 90);

  const result = validateProject(root, { phase: 'point-drafts' });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.validatedPointIds, pointIds);
  assert.deepEqual(result.pendingPointIds, pendingIds);
  assert.equal(result.validatedPoints, 3);
  assert.equal(result.pendingPoints, 87);
  assert.equal(result.counts.pointFiles, 90);
  assert.equal(result.counts.animationRequests, 90);
  assert.equal(result.counts.validatedPoints, 3);
  assert.equal(result.counts.pendingPoints, 87);

  const finalResult = validateProject(root, { phase: 'points' });
  assert.ok(finalResult.errors.length > 0);
  assert.ok(finalResult.errors.some((error) => (
    error.includes('pending-point-004')
  )));
});

test('point-drafts 拒绝只完成一侧的知识点与动画请求', (t) => {
  const { root } = createCourseFixture(t);
  writeJson(root, 'generation/animation-requests/input-state.json', {});

  const result = validateProject(root, { phase: 'point-drafts' });

  assert.ok(result.errors.some((error) => (
    error.includes('input-state')
    && error.includes('必须成对完成')
    && error.includes('动画请求仍为 {} 占位')
  )));
  assert.equal(result.validatedPoints, 2);
  assert.equal(result.pendingPoints, 0);
});

test('point-drafts 立即拒绝已开始批次中的非法正式字段', (t) => {
  const { root } = createCourseFixture(t);
  for (const id of ['state-transition', 'terminal-condition']) {
    writeJson(root, `src/data/points/${id}.json`, {});
    writeJson(root, `generation/animation-requests/${id}.json`, {});
  }
  const point = readJson(root, 'src/data/points/input-state.json');
  point.principles = [{ title: '错误的对象结构' }];
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'point-drafts' });

  assert.ok(result.errors.some((error) => (
    error.includes('input-state.json.principles')
  )));
  assert.equal(result.validatedPoints, 1);
  assert.equal(result.pendingPoints, 2);
  assert.equal(
    result.errors.some((error) => error.includes('state-transition.json')),
    false,
  );
  assert.equal(
    result.errors.some((error) => error.includes('terminal-condition.json')),
    false,
  );
});

test('animation-drafts 跳过成对占位且不要求提前构建注册层', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  writeText(root, 'src/animations/StateTransition.tsx', '{}\n');
  writeText(root, 'src/animations/StateTransition.css', '{}\n');

  const result = validateProject(root, { phase: 'animation-drafts' });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.animationTypes, []);
  assert.deepEqual(result.pendingAnimationTypes, ['stateTransition']);
  assert.equal(result.validatedAnimations, 0);
  assert.equal(result.pendingAnimations, 1);
});

test('animation-drafts 拒绝只完成 TSX 或 CSS 一侧', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  writeText(root, 'src/animations/StateTransition.css', '{}\n');

  const result = validateProject(root, { phase: 'animation-drafts' });

  assert.ok(result.errors.some((error) => (
    error.includes('StateTransition')
    && error.includes('TSX 与 CSS 必须成对完成')
    && error.includes('CSS 仍为 {} 占位')
  )));
  assert.equal(result.validatedAnimations, 0);
  assert.equal(result.pendingAnimations, 0);
});

test('animation-drafts 立即校验已完成组件的动画契约', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  writeText(
    root,
    'src/animations/StateTransition.tsx',
    `import './StateTransition.css';

export default function StateTransition() {
  return <div>静态占位</div>;
}
`,
  );

  const result = validateProject(root, { phase: 'animation-drafts' });

  assert.ok(result.errors.some((error) => error.includes('animation-stage')));
  assert.ok(result.errors.some((error) => error.includes('缺少真实动态信号')));
  assert.equal(result.validatedAnimations, 1);
  assert.equal(result.pendingAnimations, 0);
});

test('index 阶段接受严格 SemVer 并拒绝非法版本', (t) => {
  const { root } = createCourseFixture(t, {
    includeDetails: false,
  });
  const course = readJson(root, 'src/data/course.json');
  course.version = '0.2.0-beta.1';
  writeJson(root, 'src/data/course.json', course);

  assert.deepEqual(
    validateProject(root, { phase: 'index' }).errors,
    [],
  );

  for (const invalidVersion of [
    'second-draft',
    '01.0.0',
    '1.0.0-alpha..1',
  ]) {
    course.version = invalidVersion;
    writeJson(root, 'src/data/course.json', course);
    assert.ok(
      validateProject(root, { phase: 'index' }).errors.some((error) => (
        error.includes('version')
        && error.includes('SemVer 2.0')
      )),
      `应拒绝版本 ${invalidVersion}`,
    );
  }
});

test('points 阶段允许 index 的四项可同步元数据暂时漂移', (t) => {
  const { root } = createCourseFixture(t);
  const point = readJson(root, 'src/data/points/state-transition.json');
  point.shortSummary = `${point.shortSummary}并补充详情阶段校准后的适用边界。`;
  point.difficulty = '进阶';
  point.importance = 0.86;
  point.keyTerms = [...point.keyTerms, '后继状态'];
  writeJson(root, 'src/data/points/state-transition.json', point);

  const result = validateProject(root, { phase: 'points' });

  assert.deepEqual(result.errors, []);
});

test('points 阶段拒绝遗留 clusterId 字段', (t) => {
  const { root } = createCourseFixture(t);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.clusterId = 'legacy-cluster';
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'points' });

  assert.ok(result.errors.some((error) => error.includes('clusterId')));
  assert.ok(result.errors.some((error) => error.includes('禁止字段')));
});

test('points 阶段拒绝悬空前置依赖', (t) => {
  const { root } = createCourseFixture(t);
  const point = readJson(root, 'src/data/points/terminal-condition.json');
  point.prerequisites = ['missing-point'];
  writeJson(root, 'src/data/points/terminal-condition.json', point);

  const result = validateProject(root, { phase: 'points' });

  assert.ok(
    result.errors.some((error) => error.includes('前置依赖悬空: missing-point')),
  );
});

test('points 阶段拒绝前置自环', (t) => {
  const { root } = createCourseFixture(t);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.prerequisites = ['input-state'];
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'points' });

  assert.ok(result.errors.some((error) => error.includes('不允许自环')));
});

test('points 阶段拒绝全图前置循环', (t) => {
  const { root } = createCourseFixture(t);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.prerequisites = ['terminal-condition'];
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'points' });

  assert.ok(result.errors.some((error) => error.includes('前置依赖存在环')));
});

test('animations 阶段拒绝缺失的动画组件文件', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  buildAnimationRegistry(root);
  unlinkSync(fixturePath(
    root,
    `src/animations/${ANIMATION_COMPONENT}.tsx`,
  ));

  const result = validateProject(root, { phase: 'animations' });

  assert.ok(
    result.errors.some((error) => (
      error.includes(`${ANIMATION_COMPONENT}.tsx`)
      && error.includes('缺少文件')
    )),
  );
});

test('animations 阶段拒绝未进入渲染注册的动画类型', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  buildAnimationRegistry(root);
  const blockPath = 'src/components/AnimationBlock.tsx';
  const source = readText(root, blockPath);
  const unregistered = source.replace(
    '  stateTransition: GeneratedAnimation0,\n',
    '',
  );
  assert.notEqual(unregistered, source);
  writeText(root, blockPath, unregistered);

  const result = validateProject(root, { phase: 'animations' });

  assert.ok(
    result.errors.some((error) => (
      error.includes('AnimationBlock.tsx')
      && error.includes('确定性输出不一致')
    )),
  );
});

test('index 与 point 最终漂移仅在 all 阶段被拒绝', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: false,
  });
  buildAnimationRegistry(root);
  const point = readJson(root, 'src/data/points/state-transition.json');
  point.importance = 0.88;
  writeJson(root, 'src/data/points/state-transition.json', point);

  const pointsResult = validateProject(root, { phase: 'points' });
  const animationsResult = validateProject(root, { phase: 'animations' });
  const allResult = validateProject(root, { phase: 'all' });

  assert.deepEqual(pointsResult.errors, []);
  assert.deepEqual(animationsResult.errors, []);
  assert.ok(
    allResult.errors.some((error) => (
      error.includes('all 阶段')
      && error.includes('state-transition')
      && error.includes('importance')
    )),
  );
});

test('边界、待复核和低置信度点必须关联 reviewQueue', (t) => {
  const { root } = createCourseFixture(t, {
    includeDetails: false,
  });
  const manifest = readJson(root, 'generation/manifest.json');
  manifest.pointEvidence[0].scopeStatus = 'boundary';
  manifest.pointEvidence[1].scopeStatus = 'needs-review';
  manifest.pointEvidence[2].confidence = 0.49;
  manifest.reviewQueue = [
    '输入状态',
    '状态转移',
    '终止条件',
  ].map((term) => ({
    term,
    issue: 'scope-ambiguity',
    reason: '该点需要人工确认范围或置信度。',
    suggestedAction: '核对课程边界并记录复核结论。',
  }));
  writeJson(root, 'generation/manifest.json', manifest);

  const withoutReviews = validateProject(root, { phase: 'index' });
  for (const pointId of [
    'input-state',
    'state-transition',
    'terminal-condition',
  ]) {
    assert.ok(
      withoutReviews.errors.some((error) => (
        error.includes(pointId)
        && error.includes('reviewQueue')
      )),
    );
  }

  manifest.reviewQueue = [
    ['input-state', '输入状态'],
    ['state-transition', '状态转移'],
    ['terminal-condition', '终止条件'],
  ].map(([pointId, term]) => ({
    pointId,
    term,
    issue: 'scope-ambiguity',
    reason: '该点需要人工确认范围或置信度。',
    suggestedAction: '核对课程边界并记录复核结论。',
  }));
  writeJson(root, 'generation/manifest.json', manifest);

  assert.deepEqual(
    validateProject(root, { phase: 'index' }).errors,
    [],
  );
});

test('researched 模式拒绝规范化后重复的 locator', (t) => {
  const { root } = createCourseFixture(t, {
    includeDetails: false,
  });
  const manifest = readJson(root, 'generation/manifest.json');
  manifest.generation.evidenceMode = 'researched';
  manifest.sources = [
    {
      id: 'src-standard',
      type: 'official-standard',
      title: '状态机课程标准',
      locator: ' HTTPS://EXAMPLE.COM/state-machines/ ',
      accessedAt: '2026-07-16',
    },
    {
      id: 'src-textbook',
      type: 'textbook',
      title: '状态机教材',
      locator: 'https://example.com/state-machines',
      accessedAt: '2026-07-16',
    },
    {
      id: 'src-course',
      type: 'university-course',
      title: '大学状态机课程',
      locator: 'https://university.example.edu/state-machines',
      accessedAt: '2026-07-16',
    },
  ];
  manifest.pointEvidence.forEach((evidence, index) => {
    evidence.sourceRefs = [[
      'src-standard',
      'src-textbook',
      'src-course',
    ][index]];
    evidence.confidence = 0.8;
  });
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });

  assert.ok(
    result.errors.some((error) => (
      error.includes('locator')
      && error.includes('规范化后重复')
    )),
  );
});

test('points 阶段拒绝非 none 动画初稿而 all 允许构建结果', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  const point = readJson(root, 'src/data/points/state-transition.json');
  point.animationType = 'stateTransition';
  point.animationSuggestion = '依次展示当前状态、触发条件、转移规则和更新后的状态。';
  writeJson(root, 'src/data/points/state-transition.json', point);

  const draftResult = validateProject(root, { phase: 'points' });
  assert.ok(
    draftResult.errors.some((error) => (
      error.includes('points 初稿阶段')
      && error.includes('animationType')
    )),
  );

  buildAnimationRegistry(root);
  assert.deepEqual(
    validateProject(root, { phase: 'all' }).errors,
    [],
  );
});

test('index 阶段递归拒绝任意嵌套 clusters.json', (t) => {
  const { root } = createCourseFixture(t, {
    includeDetails: false,
  });
  writeJson(root, 'nested/deeper/clusters.json', {
    legacy: true,
  });

  const result = validateProject(root, { phase: 'index' });

  assert.ok(
    result.errors.some((error) => (
      error.includes('nested')
      && error.includes('clusters.json')
    )),
  );
});

test('index 阶段拒绝任意 JSON 中伪装的 cluster 或布局字段', (t) => {
  const { root } = createCourseFixture(t, {
    includeDetails: false,
  });
  writeJson(root, 'legacy-data.json', {
    legacy: {
      clusterId: 'hidden-cluster',
      pos: [10, 20],
    },
  });

  const result = validateProject(root, { phase: 'index' });

  assert.ok(
    result.errors.some((error) => (
      error.includes('legacy-data.json')
      && error.includes('clusterId')
    )),
  );
  assert.ok(
    result.errors.some((error) => (
      error.includes('legacy-data.json')
      && error.includes('"pos"')
    )),
  );
});

test('静态 SVG 与无 onClick 假重播不能通过动画校验', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  buildAnimationRegistry(root);
  writeText(
    root,
    'src/animations/StateTransition.tsx',
    `import './StateTransition.css';

function StateTransition() {
  return (
    <div
      className="animation-stage state-transition-animation"
      aria-label="静态状态转移占位图"
    >
      <svg viewBox="0 0 420 180" role="img">
        <title>静态状态转移占位图</title>
        <text x="20" y="90">当前状态 → 下一状态</text>
      </svg>
      <button type="button">重播</button>
    </div>
  );
}

export default StateTransition;
`,
  );

  const animationsResult = validateProject(root, {
    phase: 'animations',
  });
  const allResult = validateProject(root, { phase: 'all' });
  for (const result of [animationsResult, allResult]) {
    assert.ok(
      result.errors.some((error) => error.includes('缺少真实动态信号')),
    );
    assert.ok(
      result.errors.some((error) => error.includes('带 onClick 的“重播”')),
    );
  }
});

test('component 名为 AnimationBlock 时使用内部别名并通过校验', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  const manifest = readJson(
    root,
    'generation/animation-manifest.json',
  );
  manifest.animations[0].component = 'AnimationBlock';
  writeJson(root, 'generation/animation-manifest.json', manifest);

  const componentSource = readText(
    root,
    'src/animations/StateTransition.tsx',
  ).replaceAll('StateTransition', 'AnimationBlock');
  const componentCss = readText(
    root,
    'src/animations/StateTransition.css',
  );
  unlinkSync(fixturePath(root, 'src/animations/StateTransition.tsx'));
  unlinkSync(fixturePath(root, 'src/animations/StateTransition.css'));
  writeText(
    root,
    'src/animations/AnimationBlock.tsx',
    componentSource,
  );
  writeText(root, 'src/animations/AnimationBlock.css', componentCss);

  buildAnimationRegistry(root);
  const registry = readText(root, 'src/components/AnimationBlock.tsx');

  assert.match(
    registry,
    /import GeneratedAnimation0 from '\.\.\/animations\/AnimationBlock';/,
  );
  assert.match(
    registry,
    /stateTransition: GeneratedAnimation0,/,
  );
  assert.deepEqual(
    validateProject(root, { phase: 'animations' }).errors,
    [],
  );
});

test('animations 阶段拒绝 manifest 未声明的遗留 TSX 与 CSS', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  buildAnimationRegistry(root);
  writeText(
    root,
    'src/animations/LegacyAnimation.tsx',
    'export default function LegacyAnimation() { return null; }\n',
  );
  writeText(
    root,
    'src/animations/LegacyAnimation.css',
    '.legacy-animation { display: block; }\n',
  );

  const result = validateProject(root, { phase: 'animations' });

  assert.ok(
    result.errors.some((error) => (
      error.includes('manifest 未声明的 TSX')
      && error.includes('LegacyAnimation.tsx')
    )),
  );
  assert.ok(
    result.errors.some((error) => (
      error.includes('manifest 未声明的 CSS')
      && error.includes('LegacyAnimation.css')
    )),
  );
});

test('binding suggestion 不一致时 builder 与 validator 都拒绝', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  buildAnimationRegistry(root);
  const manifest = readJson(
    root,
    'generation/animation-manifest.json',
  );
  manifest.animations[0].bindings[0].suggestion = '与请求不一致的动画说明。';
  writeJson(root, 'generation/animation-manifest.json', manifest);

  assert.throws(
    () => buildAnimationRegistry(root),
    /suggestion 必须与 needed=true 请求完全一致/,
  );
  assert.ok(
    validateProject(root, { phase: 'animations' }).errors.some((error) => (
      error.includes('suggestion 必须与 needed=true 请求完全一致')
    )),
  );
});

test('builder 拒绝 root 外 courseKnowledge 符号链接且不改外部文件', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  const externalRoot = mkdtempSync(join(tmpdir(), 'candidate-external-'));
  t.after(() => rmSync(externalRoot, { recursive: true, force: true }));
  const externalPath = join(externalRoot, 'courseKnowledge.ts');
  const sentinel = 'external sentinel\n';
  writeFileSync(externalPath, sentinel, 'utf8');
  try {
    symlinkSync(
      externalPath,
      fixturePath(root, 'src/data/courseKnowledge.ts'),
    );
  } catch (error) {
    if (
      process.platform === 'win32'
      && (error?.code === 'EPERM' || error?.code === 'EACCES')
    ) {
      t.skip('当前 Windows 环境未授予创建符号链接的权限');
      return;
    }
    throw error;
  }

  assert.throws(
    () => buildAnimationRegistry(root),
    /output root 必须自包含，不允许符号链接/,
  );
  assert.equal(readFileSync(externalPath, 'utf8'), sentinel);
});

test('后续生成目标为目录时事务失败且所有 point 保持不变', (t) => {
  const { root, pointIds } = createCourseFixture(t, {
    withAnimation: true,
  });
  const before = new Map(pointIds.map((pointId) => [
    pointId,
    readText(root, `src/data/points/${pointId}.json`),
  ]));
  mkdirSync(
    fixturePath(root, 'src/components/AnimationBlock.tsx'),
  );

  assert.throws(
    () => buildAnimationRegistry(root),
    /安全写入事务准备失败.*不是普通文件/,
  );
  for (const pointId of pointIds) {
    assert.equal(
      readText(root, `src/data/points/${pointId}.json`),
      before.get(pointId),
    );
  }
});

function textbookSourceSpan(overrides = {}) {
  return {
    materialId: 'material-state-machines',
    blockIds: ['block-state-transition'],
    headingPath: ['状态机基础', '状态转移'],
    lineStart: 12,
    lineEnd: 18,
    page: 3,
    assetRefs: [],
    excerptSha256: 'a'.repeat(64),
    ...overrides,
  };
}

function configureTextbookGroundedManifest(root) {
  const manifest = readJson(root, 'generation/manifest.json');
  manifest.generation.evidenceMode = 'textbook-grounded';
  manifest.sources = [{
    id: 'src-textbook',
    type: 'textbook',
    title: '状态机基础教材',
    locator: 'textbook-input/material-state-machines/material.json',
    accessedAt: '2026-07-16',
  }];
  manifest.pointEvidence.forEach((evidence, index) => {
    evidence.sourceRefs = ['src-textbook'];
    evidence.origin = 'textbook';
    evidence.sourceSpans = [textbookSourceSpan({
      blockIds: [`block-${index + 1}`],
      lineStart: 12 + index * 10,
      lineEnd: 18 + index * 10,
    })];
    evidence.modelEnriched = true;
    evidence.confidence = 0.8;
  });
  writeJson(root, 'generation/manifest.json', manifest);
  return manifest;
}

function syncTextbookPointDetails(root, manifest) {
  for (const evidence of manifest.pointEvidence) {
    const relativePath = `src/data/points/${evidence.pointId}.json`;
    const point = readJson(root, relativePath);
    point.origin = evidence.origin;
    point.sourceSpans = structuredClone(evidence.sourceSpans);
    point.modelEnriched = evidence.modelEnriched;
    writeJson(root, relativePath, point);
  }
}

const LEGACY_CONTENT_FIELDS = [
  'coreIdea', 'principles', 'formula', 'comparisons', 'applications', 'aliases',
  'intuition', 'misconceptions', 'history', 'yearIntroduced', 'prosCons', 'qa',
  'visualType', 'visualSuggestion', 'sourceSpans', 'modelEnriched',
];

function configureTextbookContentV2(root, { extensionIndex = null } = {}) {
  const manifest = configureTextbookGroundedManifest(root);
  manifest.generation.contentContract = 'textbook-content/2.0';
  manifest.pointEvidence.forEach((evidence, index) => {
    delete evidence.modelEnriched;
    if (index === extensionIndex) evidence.origin = 'llm-extension';
    const relativePath = `src/data/points/${evidence.pointId}.json`;
    const point = readJson(root, relativePath);
    for (const field of LEGACY_CONTENT_FIELDS) delete point[field];
    point.origin = evidence.origin;
    point.content = {
      schema_version: 'textbook-content/2.0',
      blocks: [
        {
          id: 'textbook-context',
          kind: 'explanation',
          title: '教材上下文',
          markdown: `教材对${point.title}给出了定义、条件和适用范围。`,
          provenance: {
            origin: 'textbook',
            representation: 'paraphrase',
            sourceSpans: structuredClone(evidence.sourceSpans),
          },
        },
        {
          id: 'model-example',
          kind: 'example',
          title: '补充示例',
          markdown: `用一个新的情境说明${point.title}如何应用，并指出边界。`,
          provenance: {
            origin: 'model',
            basedOnBlockIds: ['textbook-context'],
          },
        },
      ],
    };
    addTextbookTeachingPlan(point);
    writeJson(root, relativePath, point);
  });
  writeJson(root, 'generation/manifest.json', manifest);
  return manifest;
}

function addTextbookTeachingPlan(point) {
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

function configureAllTextbookTeachingPlans(root, { withNextPoints = false } = {}) {
  const manifest = configureTextbookContentV2(root);
  manifest.pointEvidence.forEach((evidence, index) => {
    const relativePath = `src/data/points/${evidence.pointId}.json`;
    const point = readJson(root, relativePath);
    addTextbookTeachingPlan(point);
    if (withNextPoints && index + 1 < manifest.pointEvidence.length) {
      point.content.learningDesign.completion.nextPointId = (
        manifest.pointEvidence[index + 1].pointId
      );
    }
    writeJson(root, relativePath, point);
  });
  return manifest;
}

test('textbook-content/2.0 接受教材块与可追溯模型补充块', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root, { extensionIndex: 1 });

  assert.deepEqual(validateProject(root, { phase: 'points' }).errors, []);
});

test('textbook-content/2.0 新生成点必须包含教学重编计划', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const point = readJson(root, 'src/data/points/input-state.json');
  delete point.content.learningDesign;
  delete point.content.learningAssets;
  point.content.blocks.forEach((block) => {
    delete block.moduleId;
    delete block.depth;
  });
  writeJson(root, 'src/data/points/input-state.json', point);

  const { errors } = validateProject(root, { phase: 'points' });
  assert.ok(errors.some((error) => (
    error.includes('content') && error.includes('learningDesign')
  )));
});

test('textbook-content/2.0 新生成点必须显式记录重编档位和原则', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const point = readJson(root, 'src/data/points/input-state.json');
  delete point.content.learningDesign.adaptationLevel;
  delete point.content.learningDesign.editorialPolicy;
  writeJson(root, 'src/data/points/input-state.json', point);

  const { errors } = validateProject(root, { phase: 'points' });
  assert.ok(errors.some((error) => error.includes('adaptationLevel')));
  assert.ok(errors.some((error) => error.includes('editorialPolicy')));
});

test('textbook-content/2.0 接受 outcome-first 教学编排与落地资产', (t) => {
  const { root } = createCourseFixture(t);
  const manifest = configureTextbookContentV2(root);
  for (const evidence of manifest.pointEvidence) {
    const relativePath = `src/data/points/${evidence.pointId}.json`;
    const point = readJson(root, relativePath);
    addTextbookTeachingPlan(point);
    writeJson(root, relativePath, point);
  }

  assert.deepEqual(validateProject(root, { phase: 'points' }).errors, []);
});

test('textbook-content/2.0 接受指向 canonical index 直接下一点的 completion', (t) => {
  const { root } = createCourseFixture(t);
  const manifest = configureAllTextbookTeachingPlans(root, { withNextPoints: true });

  assert.deepEqual(validateProject(root, { phase: 'points' }).errors, []);
  const lastPointId = manifest.pointEvidence.at(-1).pointId;
  const lastPoint = readJson(root, `src/data/points/${lastPointId}.json`);
  assert.equal(
    'nextPointId' in lastPoint.content.learningDesign.completion,
    false,
  );
});

test('textbook-content/2.0 拒绝 completion.nextPointId 的跨课程悬空引用', (t) => {
  const { root } = createCourseFixture(t);
  configureAllTextbookTeachingPlans(root, { withNextPoints: true });
  const point = readJson(root, 'src/data/points/input-state.json');
  point.content.learningDesign.completion.nextPointId = 'missing-point';
  writeJson(root, 'src/data/points/input-state.json', point);

  const { errors } = validateProject(root, { phase: 'points' });
  assert.ok(errors.some((error) => (
    error.includes('nextPointId')
    && error.includes('本课程不存在的知识点: missing-point')
  )));
});

test('textbook-content/2.0 拒绝跳过 canonical index 直接下一点的 completion', (t) => {
  const { root } = createCourseFixture(t);
  const manifest = configureAllTextbookTeachingPlans(root, { withNextPoints: true });
  const point = readJson(root, 'src/data/points/input-state.json');
  point.content.learningDesign.completion.nextPointId = manifest.pointEvidence[2].pointId;
  writeJson(root, 'src/data/points/input-state.json', point);

  const { errors } = validateProject(root, { phase: 'points' });
  assert.ok(errors.some((error) => (
    error.includes('必须指向 canonical index 中的直接下一点 state-transition')
    && error.includes('实际为 terminal-condition')
  )));
});

test('textbook-content/2.0 末点可省略 nextPointId 但不能回指课程内其他点', (t) => {
  const { root } = createCourseFixture(t);
  const manifest = configureAllTextbookTeachingPlans(root, { withNextPoints: true });
  const lastPointId = manifest.pointEvidence.at(-1).pointId;
  const point = readJson(root, `src/data/points/${lastPointId}.json`);
  point.content.learningDesign.completion.nextPointId = manifest.pointEvidence[0].pointId;
  writeJson(root, `src/data/points/${lastPointId}.json`, point);

  const { errors } = validateProject(root, { phase: 'points' });
  assert.ok(errors.some((error) => (
    error.includes('位于 canonical index 知识点顺序末尾')
  )));
});

test('textbook-content/2.0 拒绝教学编排和资产中的悬空引用', (t) => {
  const { root } = createCourseFixture(t);
  const manifest = configureTextbookContentV2(root);
  for (const evidence of manifest.pointEvidence) {
    const relativePath = `src/data/points/${evidence.pointId}.json`;
    const point = readJson(root, relativePath);
    addTextbookTeachingPlan(point);
    writeJson(root, relativePath, point);
  }
  const point = readJson(root, 'src/data/points/input-state.json');
  point.content.blocks[0].moduleId = 'missing-module';
  point.content.learningAssets[0].outcomeRefs = ['missing-outcome'];
  point.content.learningAssets[0].grounding.basedOnBlockIds = ['missing-block'];
  writeJson(root, 'src/data/points/input-state.json', point);

  const { errors } = validateProject(root, { phase: 'points' });
  assert.ok(errors.some((error) => error.includes('不存在的教学模块')));
  assert.ok(errors.some((error) => error.includes('不存在的学习目标')));
  assert.ok(errors.some((error) => error.includes('不存在的内容块')));
});

test('textbook-content/2.0 拒绝可见段落转义和数学分隔符外的 LaTeX', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.content.blocks[0].markdown = String.raw`第一段\n\n第二段使用 \Sigma-\Delta 转换器。`;
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'points' });
  assert.ok(result.errors.some((error) => error.includes('字面量 \\n\\n')));
  assert.ok(result.errors.some((error) => error.includes('LaTeX 命令必须放在数学分隔符内')));
});

test('textbook-content/2.0 允许真实换行、分隔公式和代码中的反斜杠', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.content.blocks[0].markdown = (
    '第一段。\n\n'
    + '第二段使用 $\\Sigma-\\Delta$，并兼容旧公式 \\(x + y\\)。\n\n'
    + '代码示例：`\\Sigma 与 \\n\\n`。'
  );
  writeJson(root, 'src/data/points/input-state.json', point);

  assert.deepEqual(validateProject(root, { phase: 'points' }).errors, []);
});

test('textbook-content/2.0 按 CommonMark 边界识别围栏、代码与公式', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.content.blocks[0].markdown = (
    '```text\r'
    + '\\Sigma 与 \\n\\n 均为代码'
    + '\r```still-code\r'
    + '\\Gamma 仍在代码围栏内'
    + '\r```\n\n'
    + '双反引号代码：``\\Sigma ` 与 \\n\\n``。\n\n'
    + '反斜杠不转义代码内的关闭符：`\\Sigma\\`。\n\n'
    + '偶数个反斜杠后的公式：\\\\$\\Sigma$。\n\n'
    + '不同长度的中间美元符仍可属于公式：$$\\Sigma$$$ x $$。'
  );
  writeJson(root, 'src/data/points/input-state.json', point);

  assert.deepEqual(validateProject(root, { phase: 'points' }).errors, []);
});

test('textbook-content/2.0 拒绝貌似代码或公式的未配对 LaTeX', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const cases = new Map([
    ['escaped inline opener', '\\' + '`' + '\\Sigma 与 \\n\\n' + '`'],
    ['mismatched inline closer', '`\\Sigma``'],
    ['mismatched dollar run', '$$\\Sigma$$$'],
    ['escaped legacy delimiters', '\\\\(\\Sigma\\\\)'],
    ['backtick in fence info', '```bad`info\n\\Sigma 与 \\n\\n\n```'],
    ['doubled bare command', '\\\\Sigma'],
    ['one-letter bare command', '\\R'],
  ]);

  for (const [name, markdown] of cases) {
    const point = readJson(root, 'src/data/points/input-state.json');
    point.content.blocks[0].markdown = markdown;
    writeJson(root, 'src/data/points/input-state.json', point);
    const result = validateProject(root, { phase: 'points' });
    assert.ok(
      result.errors.some((error) => (
        error.includes('LaTeX 命令必须放在数学分隔符内')
      )),
      `${name}: ${result.errors.join('\n')}`,
    );
  }

  const escapedCode = readJson(root, 'src/data/points/input-state.json');
  escapedCode.content.blocks[0].markdown = '\\' + '`普通文本中的 \\n\\n 不是代码`';
  writeJson(root, 'src/data/points/input-state.json', escapedCode);
  const result = validateProject(root, { phase: 'points' });
  assert.ok(result.errors.some((error) => error.includes('字面量 \\n\\n')));
});

test('textbook-content/2.0 禁止旧正文栏目的双写', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.coreIdea = '不应与 content.blocks 同时存在';
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'points' });
  assert.ok(result.errors.some((error) => (
    error.includes('input-state.json')
    && error.includes('未知字段: coreIdea')
  )));
});

test('textbook-content/2.0 模型块只能向前引用并追溯到教材块', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.content.blocks[1].provenance.basedOnBlockIds = ['future-block'];
  point.content.blocks.push({
    id: 'future-block',
    kind: 'note',
    markdown: '这个块排在引用它的模型块之后。',
    provenance: {
      origin: 'model',
      basedOnBlockIds: ['textbook-context'],
    },
  });
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'points' });
  assert.ok(result.errors.some((error) => error.includes('只能引用同一点中排在当前块之前')));
  assert.ok(result.errors.some((error) => error.includes('必须通过 basedOnBlockIds 追溯')));
});

test('textbook-content/2.0 模型块不能跨过后续教材块', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.content.blocks.splice(1, 0, {
    id: 'textbook-followup',
    kind: 'explanation',
    markdown: '教材随后进入另一个主题。',
    provenance: {
      origin: 'textbook',
      representation: 'paraphrase',
      sourceSpans: structuredClone(
        point.content.blocks[0].provenance.sourceSpans,
      ),
    },
  });
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'points' });
  assert.ok(result.errors.some((error) => (
    error.includes('不能跨过后续教材块')
  )));
});

test('textbook-content/2.0 从 blocks 派生 spans 并拒绝与证据计划漂移', (t) => {
  const { root } = createCourseFixture(t);
  configureTextbookContentV2(root);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.content.blocks[0].provenance.sourceSpans[0].lineEnd += 1;
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'points' });
  assert.ok(result.errors.some((error) => (
    error.includes('从 blocks 派生的 sourceSpans')
    && error.includes('manifest.pointEvidence 一致')
  )));
});

test('textbook-content/2.0 的 G1 不允许人工填写 modelEnriched', (t) => {
  const { root } = createCourseFixture(t);
  const manifest = configureTextbookContentV2(root);
  manifest.pointEvidence[0].modelEnriched = true;
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });
  assert.ok(result.errors.some((error) => (
    error.includes('input-state')
    && error.includes('不应在 manifest 人工填写 modelEnriched')
  )));
});

test('textbook-grounded 接受教材点证据和 sourceSpans 为空的模型扩展点', (t) => {
  const { root } = createCourseFixture(t, { includeDetails: false });
  const manifest = configureTextbookGroundedManifest(root);
  const extension = manifest.pointEvidence[1];
  extension.origin = 'llm-extension';
  extension.sourceRefs = [];
  extension.sourceSpans = [];
  extension.modelEnriched = true;
  writeJson(root, 'generation/manifest.json', manifest);

  assert.deepEqual(
    validateProject(root, { phase: 'index' }).errors,
    [],
  );
});

test('textbook-grounded 拒绝教材点和模型扩展点的 modelEnriched=false', (t) => {
  const { root } = createCourseFixture(t, { includeDetails: false });
  const manifest = configureTextbookGroundedManifest(root);
  manifest.pointEvidence[0].modelEnriched = false;
  manifest.pointEvidence[1].origin = 'llm-extension';
  manifest.pointEvidence[1].sourceRefs = [];
  manifest.pointEvidence[1].sourceSpans = [];
  manifest.pointEvidence[1].modelEnriched = false;
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });
  assert.ok(result.errors.some((error) => (
    error.includes('input-state.modelEnriched')
    && error.includes('必须为 true')
  )));
  assert.ok(result.errors.some((error) => (
    error.includes('state-transition.modelEnriched')
    && error.includes('必须为 true')
  )));
});

test('textbook-grounded points 阶段接受与 manifest 一致的丰富详情', (t) => {
  const { root } = createCourseFixture(t);
  const manifest = configureTextbookGroundedManifest(root);
  manifest.pointEvidence[1].origin = 'llm-extension';
  manifest.pointEvidence[1].sourceRefs = [];
  manifest.pointEvidence[1].sourceSpans = [];
  writeJson(root, 'generation/manifest.json', manifest);
  syncTextbookPointDetails(root, manifest);

  assert.deepEqual(
    validateProject(root, { phase: 'points' }).errors,
    [],
  );
});

test('textbook-grounded points 阶段拒绝详情与 manifest 的 modelEnriched 漂移', (t) => {
  const { root } = createCourseFixture(t);
  const manifest = configureTextbookGroundedManifest(root);
  syncTextbookPointDetails(root, manifest);
  const point = readJson(root, 'src/data/points/input-state.json');
  point.modelEnriched = false;
  writeJson(root, 'src/data/points/input-state.json', point);

  const result = validateProject(root, { phase: 'points' });
  assert.ok(result.errors.some((error) => (
    error.includes('知识点详情 input-state.modelEnriched')
    && error.includes('必须为 true')
  )));
  assert.ok(result.errors.some((error) => (
    error.includes('知识点详情 input-state.modelEnriched')
    && error.includes('manifest.pointEvidence 一致')
  )));
});

test('textbook-grounded 拒绝没有 sourceSpans 的教材点', (t) => {
  const { root } = createCourseFixture(t, { includeDetails: false });
  const manifest = configureTextbookGroundedManifest(root);
  delete manifest.pointEvidence[0].sourceSpans;
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });
  assert.ok(result.errors.some((error) => (
    error.includes('input-state')
    && error.includes('必须声明 sourceSpans')
  )));
});

test('textbook-grounded 拒绝 sourceSpan 结束行早于起始行', (t) => {
  const { root } = createCourseFixture(t, { includeDetails: false });
  const manifest = configureTextbookGroundedManifest(root);
  manifest.pointEvidence[0].sourceSpans[0].lineStart = 20;
  manifest.pointEvidence[0].sourceSpans[0].lineEnd = 19;
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });
  assert.ok(result.errors.some((error) => (
    error.includes('sourceSpans[0].lineEnd')
    && error.includes('不小于 lineStart')
  )));
});

test('textbook-grounded 拒绝非小写 64 位 SHA-256 摘要', (t) => {
  const { root } = createCourseFixture(t, { includeDetails: false });
  const manifest = configureTextbookGroundedManifest(root);
  manifest.pointEvidence[0].sourceSpans[0].excerptSha256 = 'ABC123';
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });
  assert.ok(result.errors.some((error) => (
    error.includes('sourceSpans[0].excerptSha256')
    && error.includes('小写 SHA-256')
  )));
});

test('textbook-grounded 拒绝非布尔 modelEnriched', (t) => {
  const { root } = createCourseFixture(t, { includeDetails: false });
  const manifest = configureTextbookGroundedManifest(root);
  manifest.pointEvidence[0].modelEnriched = 'yes';
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });
  assert.ok(result.errors.some((error) => (
    error.includes('pointEvidence[0].modelEnriched')
    && error.includes('布尔值')
  )));
});

test('textbook-grounded 教材点必须引用 type=textbook 的来源', (t) => {
  const { root } = createCourseFixture(t, { includeDetails: false });
  const manifest = configureTextbookGroundedManifest(root);
  manifest.sources.push({
    id: 'src-standard',
    type: 'official-standard',
    title: '状态机课程标准',
    locator: 'https://example.com/standard/state-machines',
    accessedAt: '2026-07-16',
  });
  manifest.pointEvidence[0].sourceRefs = ['src-standard'];
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });
  assert.ok(result.errors.some((error) => (
    error.includes('input-state')
    && error.includes('textbook sourceRef')
  )));
});

test('model-only 与 researched 继续兼容不含 provenance 字段的旧产物', (t) => {
  const modelOnly = createCourseFixture(t, { includeDetails: false });
  assert.deepEqual(
    validateProject(modelOnly.root, { phase: 'index' }).errors,
    [],
  );

  const researched = createCourseFixture(t, { includeDetails: false });
  const manifest = readJson(researched.root, 'generation/manifest.json');
  manifest.generation.evidenceMode = 'researched';
  manifest.sources = [
    {
      id: 'src-standard',
      type: 'official-standard',
      title: '状态机课程标准',
      locator: 'https://example.com/standard/state-machines',
      accessedAt: '2026-07-16',
    },
    {
      id: 'src-textbook',
      type: 'textbook',
      title: '状态机教材',
      locator: 'https://example.com/textbook/state-machines',
      accessedAt: '2026-07-16',
    },
    {
      id: 'src-course',
      type: 'university-course',
      title: '大学状态机课程',
      locator: 'https://example.edu/course/state-machines',
      accessedAt: '2026-07-16',
    },
  ];
  manifest.pointEvidence.forEach((evidence, index) => {
    evidence.sourceRefs = [manifest.sources[index].id];
    evidence.confidence = 0.8;
  });
  writeJson(researched.root, 'generation/manifest.json', manifest);

  assert.deepEqual(
    validateProject(researched.root, { phase: 'index' }).errors,
    [],
  );
});

test('textbook-origin points may preserve duplicate source titles', (t) => {
  const { root } = createCourseFixture(t, { includeDetails: false });
  const manifest = configureTextbookGroundedManifest(root);
  const index = readJson(root, 'src/data/index.json');
  index.points[1].title = index.points[0].title;
  manifest.pointEvidence[1].title = manifest.pointEvidence[0].title;
  writeJson(root, 'src/data/index.json', index);
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });

  assert.deepEqual(result.errors, []);
});

test('non-textbook points still reject duplicate titles', (t) => {
  const { root } = createCourseFixture(t, { includeDetails: false });
  const index = readJson(root, 'src/data/index.json');
  const manifest = readJson(root, 'generation/manifest.json');
  index.points[1].title = index.points[0].title;
  manifest.pointEvidence[1].title = manifest.pointEvidence[0].title;
  writeJson(root, 'src/data/index.json', index);
  writeJson(root, 'generation/manifest.json', manifest);

  const result = validateProject(root, { phase: 'index' });

  assert.ok(result.errors.some((error) => error.includes('知识点标题重复')));
});

test('普通主题模式仍允许显式 modelEnriched=false', (t) => {
  const { root } = createCourseFixture(t);
  const manifest = readJson(root, 'generation/manifest.json');
  for (const evidence of manifest.pointEvidence) evidence.modelEnriched = false;
  writeJson(root, 'generation/manifest.json', manifest);
  for (const evidence of manifest.pointEvidence) {
    const relativePath = `src/data/points/${evidence.pointId}.json`;
    const point = readJson(root, relativePath);
    point.modelEnriched = false;
    writeJson(root, relativePath, point);
  }

  assert.deepEqual(
    validateProject(root, { phase: 'points' }).errors,
    [],
  );
});
