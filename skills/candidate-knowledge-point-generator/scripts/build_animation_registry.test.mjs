import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAnimationRegistry } from './build_animation_registry.mjs';
import { validateProject } from './validate_output.mjs';
import {
  ANIMATION_COMPONENT,
  ANIMATION_SUGGESTION,
  ANIMATION_TYPE,
  createCourseFixture,
  readJson,
  readText,
  writeJson,
} from './test-fixture.mjs';

test('有动画时更新知识点并生成确定性类型、注册和共享 CSS', (t) => {
  const { root, pointIds } = createCourseFixture(t, {
    withAnimation: true,
  });
  assert.equal(
    readJson(root, 'src/data/points/state-transition.json').animationType,
    'none',
  );

  const result = buildAnimationRegistry(root);
  const bound = readJson(root, 'src/data/points/state-transition.json');
  const types = readText(root, 'src/data/courseKnowledge.ts');
  const block = readText(root, 'src/components/AnimationBlock.tsx');
  const css = readText(root, 'src/components/AnimationBlock.css');

  assert.deepEqual(result.animationTypes, [ANIMATION_TYPE]);
  assert.equal(bound.animationType, ANIMATION_TYPE);
  assert.equal(bound.animationSuggestion, ANIMATION_SUGGESTION);
  for (const id of pointIds.filter((id) => id !== 'state-transition')) {
    const point = readJson(root, `src/data/points/${id}.json`);
    assert.equal(point.animationType, 'none');
    assert.equal('animationSuggestion' in point, false);
  }
  assert.match(
    types,
    /export type AnimationType =\n  \| 'none'\n  \| 'stateTransition';/,
  );
  assert.match(
    block,
    /import GeneratedAnimation0 from '\.\.\/animations\/StateTransition';/,
  );
  assert.match(block, /stateTransition: "状态转移过程",/);
  assert.match(block, /stateTransition: GeneratedAnimation0,/);
  assert.match(block, /<Component \/>/);
  assert.match(css, /\.animation-stage\s*\{/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);

  const firstOutput = {
    point: readText(root, 'src/data/points/state-transition.json'),
    types,
    block,
    css,
  };
  buildAnimationRegistry(root);
  assert.deepEqual({
    point: readText(root, 'src/data/points/state-transition.json'),
    types: readText(root, 'src/data/courseKnowledge.ts'),
    block: readText(root, 'src/components/AnimationBlock.tsx'),
    css: readText(root, 'src/components/AnimationBlock.css'),
  }, firstOutput);
});

test('无动画时生成仅含 none 的合法空注册层', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: false,
  });

  const result = buildAnimationRegistry(root);
  const types = readText(root, 'src/data/courseKnowledge.ts');
  const block = readText(root, 'src/components/AnimationBlock.tsx');
  const unionBody = types.match(
    /export type AnimationType\s*=\s*([\s\S]*?);/,
  )?.[1];

  assert.deepEqual(result.animationTypes, []);
  assert.deepEqual(
    [...unionBody.matchAll(/'([^']+)'/g)].map((match) => match[1]),
    ['none'],
  );
  assert.doesNotMatch(block, /\.\.\/animations\//);
  assert.match(block, /const animationTitles[\s\S]*?= \{\s*\};/);
  assert.match(block, /const animationComponents[\s\S]*?= \{\s*\};/);
  assert.deepEqual(
    validateProject(root, { phase: 'animations' }).errors,
    [],
  );
});

test('动画标题包含对象结束字符时仍按确定性源码校验', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  const manifest = readJson(root, 'generation/animation-manifest.json');
  manifest.animations[0].title = '状态};转移过程';
  writeJson(root, 'generation/animation-manifest.json', manifest);

  buildAnimationRegistry(root);

  assert.deepEqual(
    validateProject(root, { phase: 'animations' }).errors,
    [],
  );
});

test('拒绝 needed=true 请求未绑定', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: true,
  });
  writeJson(root, 'generation/animation-manifest.json', {
    schema_version: 'course-content-animations/1.0',
    animations: [],
  });

  assert.throws(
    () => buildAnimationRegistry(root),
    /needed=true 的知识点 state-transition 必须恰好绑定一次，实际为 0/,
  );
});

test('拒绝 needed=false 请求被动画清单绑定', (t) => {
  const { root } = createCourseFixture(t, {
    withAnimation: false,
  });
  writeJson(root, 'generation/animation-manifest.json', {
    schema_version: 'course-content-animations/1.0',
    animations: [
      {
        type: ANIMATION_TYPE,
        component: ANIMATION_COMPONENT,
        title: '状态转移过程',
        mechanism: {
          inputs: '当前状态与触发条件',
          changingState: '系统当前状态',
          transitionRule: '满足触发条件后应用确定的状态转移规则',
          terminalState: '到达没有后续转移的终止状态',
          replayMode: 'restart',
        },
        bindings: [
          {
            pointId: 'state-transition',
            suggestion: ANIMATION_SUGGESTION,
          },
        ],
      },
    ],
  });

  assert.throws(
    () => buildAnimationRegistry(root),
    /needed=false 的知识点 state-transition 不得绑定动画/,
  );
});
