#!/usr/bin/env node

import {
  basename,
  join,
  resolve,
} from 'node:path';
import {
  assertNoSymbolicLinks,
  formatErrors,
  isDirectRun,
  isRecord,
  listJsonFiles,
  readJsonFile,
  sameJsonValue,
  sortStrings,
} from './lib/common.mjs';
import {
  ID_PATTERN,
  checkAnimationManifest,
  checkAnimationRequest,
} from './lib/contracts.mjs';
import {
  safeWriteTransaction,
  serializeJson,
} from './lib/safe-write.mjs';

const VISUAL_TYPE_NAMES = [
  'foundation',
  'timeline',
  'search',
  'logic',
  'knowledgeGraph',
  'learning',
  'decisionTree',
  'bayes',
  'neuralNetwork',
  'gradient',
  'attention',
  'transformer',
  'vision',
  'agentLoop',
  'diffusion',
  'ethics',
];

function renderStringUnion(name, values) {
  const members = values.map((value) => `  | '${value}'`).join('\n');
  return `export type ${name} =\n${members};`;
}

export function renderCourseKnowledge(animationTypes) {
  const types = [
    'none',
    ...sortStrings(new Set(
      animationTypes.filter((type) => type !== 'none'),
    )),
  ];
  return `/* 此文件由 build_animation_registry.mjs 确定性生成，请勿手工编辑。 */

export type Difficulty = '基础' | '中等' | '进阶';

${renderStringUnion('VisualType', VISUAL_TYPE_NAMES)}

${renderStringUnion('AnimationType', types)}

export type KnowledgePointQa = {
  q: string;
  a: string;
};

export type KnowledgePointProsCons = {
  pros: string[];
  cons: string[];
};

export type KnowledgePoint = {
  id: string;
  title: string;
  shortSummary: string;
  coreIdea: string;
  principles: string[];
  formula?: string;
  keyTerms: string[];
  comparisons?: string[];
  applications: string[];
  aliases: string[];
  intuition: string;
  misconceptions: string[];
  history?: string;
  yearIntroduced?: number;
  prosCons?: KnowledgePointProsCons;
  qa: KnowledgePointQa[];
  visualType?: VisualType;
  visualSuggestion?: string;
  animationType: AnimationType;
  animationSuggestion?: string;
  difficulty: Difficulty;
  importance: number;
  prerequisites: string[];
};
`;
}

export function renderAnimationBlock(animations) {
  const sortedAnimations = [...animations].sort((left, right) => {
    if (left.type < right.type) return -1;
    if (left.type > right.type) return 1;
    return 0;
  });
  const componentImports = sortedAnimations
    .map((animation, index) => (
      `import GeneratedAnimation${index} from '../animations/${animation.component}';`
    ))
    .join('\n');
  const titleEntries = sortedAnimations
    .map((animation) => (
      `  ${animation.type}: ${JSON.stringify(animation.title)},`
    ))
    .join('\n');
  const componentEntries = sortedAnimations
    .map((animation, index) => (
      `  ${animation.type}: GeneratedAnimation${index},`
    ))
    .join('\n');

  const imports = [
    "import type { ComponentType } from 'react';",
    "import type { AnimationType } from '../data/courseKnowledge';",
    componentImports,
    "import './AnimationBlock.css';",
  ].filter(Boolean).join('\n');

  return `/* 此文件由 build_animation_registry.mjs 确定性生成，请勿手工编辑。 */

${imports}

export type AnimationBlockProps = {
  type?: AnimationType;
  suggestion?: string;
};

const animationTitles: Partial<Record<AnimationType, string>> = {
${titleEntries}
};

const animationComponents: Partial<Record<AnimationType, ComponentType>> = {
${componentEntries}
};

function AnimationBlock({ type = 'none', suggestion }: AnimationBlockProps) {
  const Component = animationComponents[type];
  const title = animationTitles[type];
  if (type === 'none' || !Component || !title) {
    return null;
  }

  return (
    <section className="animation-block" aria-label={\`动态示意：\${title}\`}>
      <h3 className="animation-block__title">动态示意：{title}</h3>
      {suggestion ? (
        <p className="animation-block__suggestion">{suggestion}</p>
      ) : null}
      <Component />
    </section>
  );
}

export default AnimationBlock;
`;
}

export function renderAnimationBlockCss() {
  return `/* 此文件由 build_animation_registry.mjs 确定性生成，请勿手工编辑。 */

.animation-block {
  width: 100%;
  margin-block: 1.25rem;
}

.animation-block__title {
  margin: 0 0 0.5rem;
}

.animation-block__suggestion {
  margin: 0 0 0.75rem;
  line-height: 1.6;
}

.animation-stage {
  width: 100%;
  min-height: 180px;
  overflow: hidden;
}

.animation-stage svg {
  display: block;
  width: 100%;
  height: auto;
  min-height: 180px;
}

@media (prefers-reduced-motion: reduce) {
  .animation-stage *,
  .animation-stage *::before,
  .animation-stage *::after {
    scroll-behavior: auto !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
`;
}

function applyAnimationBinding(point, binding) {
  const output = {};
  let inserted = false;
  for (const [key, value] of Object.entries(point)) {
    if (key === 'animationSuggestion') continue;
    if (key === 'animationType') {
      output.animationType = binding?.type ?? 'none';
      if (binding) output.animationSuggestion = binding.suggestion;
      inserted = true;
    } else {
      output[key] = value;
    }
  }
  if (!inserted) {
    output.animationType = binding?.type ?? 'none';
    if (binding) output.animationSuggestion = binding.suggestion;
  }
  return output;
}

function loadPointFiles(pointsRoot, errors) {
  const points = new Map();
  for (const filename of listJsonFiles(pointsRoot)) {
    const fileId = basename(filename, '.json');
    const point = readJsonFile(join(pointsRoot, filename));
    const label = `src/data/points/${filename}`;
    if (!isRecord(point)) {
      errors.push(`${label} 顶层必须是对象`);
      continue;
    }
    if (!ID_PATTERN.test(fileId)) {
      errors.push(`${label} 文件名必须是 ASCII kebab-case ID`);
    }
    if (point.id !== fileId) {
      errors.push(
        `${label} 内部 id 必须与文件名一致，期望 ${JSON.stringify(fileId)}，实际为 ${JSON.stringify(point.id)}`,
      );
    }
    points.set(fileId, { filename, point });
  }
  if (points.size === 0) errors.push('src/data/points/ 中没有知识点 JSON');
  return points;
}

function loadRequestFiles(requestsRoot, errors) {
  const requests = new Map();
  for (const filename of listJsonFiles(requestsRoot)) {
    const fileId = basename(filename, '.json');
    const request = readJsonFile(join(requestsRoot, filename));
    const label = `generation/animation-requests/${filename}`;
    checkAnimationRequest(request, label, errors);
    if (!isRecord(request)) continue;
    if (!ID_PATTERN.test(fileId)) {
      errors.push(`${label} 文件名必须是 ASCII kebab-case ID`);
    }
    if (request.pointId !== fileId) {
      errors.push(
        `${label} 的 pointId 必须与文件名一致，期望 ${JSON.stringify(fileId)}，实际为 ${JSON.stringify(request.pointId)}`,
      );
    }
    requests.set(fileId, { filename, request });
  }
  return requests;
}

export function buildAnimationRegistry(projectRoot) {
  const root = resolve(projectRoot);
  assertNoSymbolicLinks(root);
  const pointsRoot = join(root, 'src/data/points');
  const requestsRoot = join(root, 'generation/animation-requests');
  const manifestPath = join(root, 'generation/animation-manifest.json');
  const manifest = readJsonFile(manifestPath);
  const errors = [];

  checkAnimationManifest(
    manifest,
    'generation/animation-manifest.json',
    errors,
  );
  const points = loadPointFiles(pointsRoot, errors);
  const requests = loadRequestFiles(requestsRoot, errors);

  for (const id of points.keys()) {
    if (!requests.has(id)) {
      errors.push(`知识点 ${id} 缺少同名动画请求文件`);
    }
  }
  for (const id of requests.keys()) {
    if (!points.has(id)) {
      errors.push(`动画请求没有同名知识点详情: ${id}.json`);
    }
  }

  const bindingCounts = new Map();
  const bindingByPointId = new Map();
  if (isRecord(manifest) && Array.isArray(manifest.animations)) {
    for (const animation of manifest.animations) {
      if (!isRecord(animation) || !Array.isArray(animation.bindings)) continue;
      for (const binding of animation.bindings) {
        if (!isRecord(binding) || typeof binding.pointId !== 'string') continue;
        bindingCounts.set(
          binding.pointId,
          (bindingCounts.get(binding.pointId) ?? 0) + 1,
        );
        if (!bindingByPointId.has(binding.pointId)) {
          bindingByPointId.set(binding.pointId, {
            type: animation.type,
            component: animation.component,
            title: animation.title,
            suggestion: binding.suggestion,
          });
        }
        if (!points.has(binding.pointId)) {
          errors.push(`动画绑定指向不存在的知识点: ${binding.pointId}`);
        }
        if (!requests.has(binding.pointId)) {
          errors.push(`动画绑定缺少对应请求: ${binding.pointId}`);
        }
      }
    }
  }

  for (const [id, entry] of requests) {
    const count = bindingCounts.get(id) ?? 0;
    if (entry.request.needed === true && count !== 1) {
      errors.push(`needed=true 的知识点 ${id} 必须恰好绑定一次，实际为 ${count}`);
    }
    if (entry.request.needed === false && count !== 0) {
      errors.push(`needed=false 的知识点 ${id} 不得绑定动画`);
    }
    if (
      entry.request.needed === true
      && count === 1
      && bindingByPointId.get(id)?.suggestion !== entry.request.suggestion
    ) {
      errors.push(
        `动画绑定 ${id} 的 suggestion 必须与 needed=true 请求完全一致`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(formatErrors('动画注册构建前校验失败', errors));
  }

  const animations = [...manifest.animations].sort((left, right) => {
    if (left.type < right.type) return -1;
    if (left.type > right.type) return 1;
    return 0;
  });
  let changedPointCount = 0;
  const preparedWrites = [];
  for (const [id, { filename, point }] of points) {
    const updated = applyAnimationBinding(point, bindingByPointId.get(id));
    if (!sameJsonValue(point, updated)) changedPointCount += 1;
    preparedWrites.push({
      path: join(pointsRoot, filename),
      contents: serializeJson(updated),
    });
  }

  const typesPath = join(root, 'src/data/courseKnowledge.ts');
  const blockPath = join(root, 'src/components/AnimationBlock.tsx');
  const cssPath = join(root, 'src/components/AnimationBlock.css');
  const typesSource = renderCourseKnowledge(
    animations.map((animation) => animation.type),
  );
  const blockSource = renderAnimationBlock(animations);
  const cssSource = renderAnimationBlockCss();
  preparedWrites.push(
    { path: typesPath, contents: typesSource },
    { path: blockPath, contents: blockSource },
    { path: cssPath, contents: cssSource },
  );
  safeWriteTransaction(root, preparedWrites);

  return {
    root,
    pointCount: points.size,
    animationCount: animations.length,
    animationTypes: animations.map((animation) => animation.type),
    changedPointCount,
    generatedFiles: [typesPath, blockPath, cssPath],
  };
}

export function parseArgs(argv) {
  let root = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      root = argv[index + 1];
      if (!root || root.startsWith('--')) {
        throw new Error('--root 需要目录参数');
      }
      index += 1;
    } else if (argument.startsWith('--root=')) {
      root = argument.slice('--root='.length);
    } else if (argument === '--help' || argument === '-h') {
      return { help: true, root };
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }

  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('--root 为必填目录');
  }
  return { help: false, root };
}

function printUsage() {
  console.log(`用法:
  node scripts/build_animation_registry.mjs --root <output-root>

校验动画清单与逐点请求，更新 points 动画字段，并确定性生成类型、
AnimationBlock 注册组件及共享样式。`);
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
    const result = buildAnimationRegistry(options.root);
    const typeSummary = result.animationTypes.length > 0
      ? result.animationTypes.join(', ')
      : 'none';
    console.log(
      `动画注册构建完成：${result.animationCount} 个动画类型（${typeSummary}），更新 ${result.changedPointCount} 个知识点`,
    );
  } catch (error) {
    console.error(`动画注册构建失败: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
