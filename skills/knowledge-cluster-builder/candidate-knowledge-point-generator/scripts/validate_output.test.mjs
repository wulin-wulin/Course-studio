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
