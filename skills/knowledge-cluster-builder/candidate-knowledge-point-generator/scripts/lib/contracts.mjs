import {
  isFiniteNumber,
  isRecord,
  unicodeLength,
} from './common.mjs';

export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SOURCE_ID_PATTERN = /^src-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ANIMATION_TYPE_PATTERN = /^[a-z][A-Za-z0-9]*$/;
export const COMPONENT_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

export const DIFFICULTIES = new Set(['基础', '中等', '进阶']);
export const VISUAL_TYPES = new Set([
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
]);
export const REPLAY_MODES = new Set([
  'restart',
  'both',
  'loop',
]);

export const INDEX_POINT_KEYS = [
  'id',
  'title',
  'shortSummary',
  'difficulty',
  'importance',
  'keyTerms',
];

export const POINT_REQUIRED_KEYS = [
  'id',
  'title',
  'shortSummary',
  'coreIdea',
  'principles',
  'keyTerms',
  'applications',
  'aliases',
  'intuition',
  'misconceptions',
  'qa',
  'animationType',
  'difficulty',
  'importance',
  'prerequisites',
];

export const POINT_OPTIONAL_KEYS = [
  'formula',
  'comparisons',
  'history',
  'yearIntroduced',
  'prosCons',
  'visualType',
  'visualSuggestion',
  'animationSuggestion',
];

export const POINT_ALLOWED_KEYS = [
  ...POINT_REQUIRED_KEYS,
  ...POINT_OPTIONAL_KEYS,
];

export const FORBIDDEN_DATA_KEYS = new Set([
  'clusters',
  'clusterId',
  'pos',
  'scale',
  'polygon',
  'labelPos',
  'accent',
  'soft',
  'dark',
  'kind',
  'sourceRefs',
  'confidence',
  'scopeStatus',
  'ideologicalElement',
  'related_points',
]);

export function checkObjectShape(
  value,
  requiredKeys,
  allowedKeys,
  label,
  errors,
) {
  if (!isRecord(value)) {
    errors.push(`${label} 必须是对象`);
    return false;
  }

  const allowed = new Set(allowedKeys);
  const missing = requiredKeys.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0) {
    errors.push(`${label} 缺少字段: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    errors.push(`${label} 包含未知字段: ${extra.join(', ')}`);
  }
  return true;
}

export function checkExactKeys(value, keys, label, errors) {
  return checkObjectShape(value, keys, keys, label, errors);
}

export function checkNonEmptyString(value, label, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label} 必须是非空字符串`);
    return false;
  }
  return true;
}

export function checkKebabId(value, label, errors) {
  if (!checkNonEmptyString(value, label, errors)) return false;
  if (!ID_PATTERN.test(value)) {
    errors.push(`${label} 必须是 ASCII kebab-case: ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

export function checkStringArray(
  value,
  label,
  errors,
  { min = 0, max = Infinity, unique = false } = {},
) {
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是字符串数组`);
    return false;
  }

  if (value.length < min) errors.push(`${label} 至少需要 ${min} 项`);
  if (value.length > max) errors.push(`${label} 最多允许 ${max} 项`);
  value.forEach((item, index) => {
    checkNonEmptyString(item, `${label}[${index}]`, errors);
  });
  if (unique && new Set(value).size !== value.length) {
    errors.push(`${label} 不允许重复项`);
  }
  return value.every((item) => typeof item === 'string');
}

export function checkSummary(value, title, label, errors) {
  if (typeof value !== 'string') {
    errors.push(`${label} 必须是字符串`);
    return;
  }

  const length = unicodeLength(value);
  if (length < 30 || length > 100) {
    errors.push(`${label} 必须包含 30–100 个 Unicode 字符，实际为 ${length}`);
  }
  if (value.trim() === '') errors.push(`${label} 不能为空`);
  if (
    typeof title === 'string'
    && value.trim() === title.trim()
  ) {
    errors.push(`${label} 不能只是重复 title`);
  }
}

export function checkDifficulty(value, label, errors) {
  if (!DIFFICULTIES.has(value)) {
    errors.push(`${label} 只能是 基础/中等/进阶`);
  }
}

export function checkImportance(value, label, errors) {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    errors.push(`${label} 必须是 [0, 1] 内有限数值`);
  }
}

export function checkIndexPoint(point, label, errors) {
  if (!checkExactKeys(point, INDEX_POINT_KEYS, label, errors)) return;

  checkKebabId(point.id, `${label}.id`, errors);
  checkNonEmptyString(point.title, `${label}.title`, errors);
  checkSummary(point.shortSummary, point.title, `${label}.shortSummary`, errors);
  checkDifficulty(point.difficulty, `${label}.difficulty`, errors);
  checkImportance(point.importance, `${label}.importance`, errors);
  checkStringArray(point.keyTerms, `${label}.keyTerms`, errors, {
    min: 2,
    max: 8,
    unique: true,
  });
}

function checkQa(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是数组`);
    return;
  }
  if (value.length < 2) errors.push(`${label} 至少需要 2 组问答`);

  value.forEach((item, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!checkExactKeys(item, ['q', 'a'], itemLabel, errors)) return;
    checkNonEmptyString(item.q, `${itemLabel}.q`, errors);
    checkNonEmptyString(item.a, `${itemLabel}.a`, errors);
  });
}

function checkProsCons(value, label, errors) {
  if (!checkExactKeys(value, ['pros', 'cons'], label, errors)) return;
  checkStringArray(value.pros, `${label}.pros`, errors, {
    min: 1,
    unique: true,
  });
  checkStringArray(value.cons, `${label}.cons`, errors, {
    min: 1,
    unique: true,
  });
}

export function checkPoint(point, label, errors) {
  if (!checkObjectShape(
    point,
    POINT_REQUIRED_KEYS,
    POINT_ALLOWED_KEYS,
    label,
    errors,
  )) {
    return;
  }

  checkKebabId(point.id, `${label}.id`, errors);
  checkNonEmptyString(point.title, `${label}.title`, errors);
  checkSummary(point.shortSummary, point.title, `${label}.shortSummary`, errors);
  checkNonEmptyString(point.coreIdea, `${label}.coreIdea`, errors);
  checkStringArray(point.principles, `${label}.principles`, errors, {
    min: 2,
    max: 6,
    unique: true,
  });
  checkStringArray(point.keyTerms, `${label}.keyTerms`, errors, {
    min: 2,
    max: 8,
    unique: true,
  });
  checkStringArray(point.applications, `${label}.applications`, errors, {
    min: 1,
    unique: true,
  });
  checkStringArray(point.aliases, `${label}.aliases`, errors, {
    unique: true,
  });
  checkNonEmptyString(point.intuition, `${label}.intuition`, errors);
  checkStringArray(
    point.misconceptions,
    `${label}.misconceptions`,
    errors,
    { min: 1, unique: true },
  );
  checkQa(point.qa, `${label}.qa`, errors);
  checkDifficulty(point.difficulty, `${label}.difficulty`, errors);
  checkImportance(point.importance, `${label}.importance`, errors);
  checkStringArray(
    point.prerequisites,
    `${label}.prerequisites`,
    errors,
    { unique: true },
  );
  if (Array.isArray(point.prerequisites)) {
    point.prerequisites.forEach((id, index) => {
      if (typeof id === 'string' && !ID_PATTERN.test(id)) {
        errors.push(
          `${label}.prerequisites[${index}] 必须是 ASCII kebab-case: ${JSON.stringify(id)}`,
        );
      }
    });
  }

  for (const key of ['formula', 'history']) {
    if (key in point) {
      checkNonEmptyString(point[key], `${label}.${key}`, errors);
    }
  }
  for (const key of ['comparisons']) {
    if (key in point) {
      checkStringArray(point[key], `${label}.${key}`, errors, {
        min: 1,
        unique: true,
      });
    }
  }
  if ('yearIntroduced' in point && !Number.isInteger(point.yearIntroduced)) {
    errors.push(`${label}.yearIntroduced 必须是整数`);
  }
  if ('prosCons' in point) {
    checkProsCons(point.prosCons, `${label}.prosCons`, errors);
  }

  if ('visualType' in point && !VISUAL_TYPES.has(point.visualType)) {
    errors.push(`${label}.visualType 不是允许的静态图示类型`);
  }
  if ('visualSuggestion' in point) {
    checkNonEmptyString(
      point.visualSuggestion,
      `${label}.visualSuggestion`,
      errors,
    );
    if (!('visualType' in point)) {
      errors.push(`${label} 有 visualSuggestion 但没有 visualType`);
    }
  }
  if ('visualType' in point && !('visualSuggestion' in point)) {
    errors.push(`${label} 有 visualType 时必须提供 visualSuggestion`);
  }

  if (
    typeof point.animationType !== 'string'
    || !/^(?:none|[a-z][A-Za-z0-9]*)$/.test(point.animationType)
  ) {
    errors.push(`${label}.animationType 必须是 none 或 ASCII lowerCamelCase`);
  }
  if ('animationSuggestion' in point) {
    checkNonEmptyString(
      point.animationSuggestion,
      `${label}.animationSuggestion`,
      errors,
    );
  }
  if (point.animationType === 'none' && 'animationSuggestion' in point) {
    errors.push(`${label} 的 animationType 为 none，不应有 animationSuggestion`);
  }
  if (
    typeof point.animationType === 'string'
    && point.animationType !== 'none'
    && !('animationSuggestion' in point)
  ) {
    errors.push(`${label} 使用动画时必须提供 animationSuggestion`);
  }
}

export function checkMechanism(mechanism, label, errors) {
  const keys = [
    'inputs',
    'changingState',
    'transitionRule',
    'terminalState',
    'replayMode',
  ];
  if (!checkExactKeys(mechanism, keys, label, errors)) return;

  for (const key of keys.slice(0, 4)) {
    checkNonEmptyString(mechanism[key], `${label}.${key}`, errors);
  }
  if (!REPLAY_MODES.has(mechanism.replayMode)) {
    errors.push(
      `${label}.replayMode 只能是 restart/both/loop`,
    );
  }
}

export function checkAnimationRequest(request, label, errors) {
  const baseKeys = ['schema_version', 'pointId', 'needed', 'rationale'];
  let keys = [...baseKeys, 'mechanism', 'suggestion'];
  if (isRecord(request) && request.needed === false) keys = baseKeys;
  if (isRecord(request) && request.needed === true) {
    keys = [...baseKeys, 'mechanism', 'suggestion'];
  }

  if (!checkExactKeys(request, keys, label, errors)) return;
  if (request.schema_version !== 'animation-request/1.0') {
    errors.push(
      `${label}.schema_version 必须是 "animation-request/1.0"`,
    );
  }
  checkKebabId(request.pointId, `${label}.pointId`, errors);
  if (typeof request.needed !== 'boolean') {
    errors.push(`${label}.needed 必须是 boolean`);
  }
  checkNonEmptyString(request.rationale, `${label}.rationale`, errors);

  if (request.needed === true) {
    checkMechanism(request.mechanism, `${label}.mechanism`, errors);
    checkNonEmptyString(request.suggestion, `${label}.suggestion`, errors);
  }
}

export function checkAnimationManifest(manifest, label, errors) {
  const summary = {
    types: new Set(),
    components: new Set(),
    bindingPointIds: new Set(),
  };
  if (!checkExactKeys(
    manifest,
    ['schema_version', 'animations'],
    label,
    errors,
  )) {
    return summary;
  }

  if (manifest.schema_version !== 'course-content-animations/1.0') {
    errors.push(
      `${label}.schema_version 必须是 "course-content-animations/1.0"`,
    );
  }
  if (!Array.isArray(manifest.animations)) {
    errors.push(`${label}.animations 必须是数组`);
    return summary;
  }

  manifest.animations.forEach((animation, index) => {
    const animationLabel = `${label}.animations[${index}]`;
    if (!checkExactKeys(
      animation,
      ['type', 'component', 'title', 'mechanism', 'bindings'],
      animationLabel,
      errors,
    )) {
      return;
    }

    if (
      typeof animation.type !== 'string'
      || !ANIMATION_TYPE_PATTERN.test(animation.type)
      || animation.type === 'none'
    ) {
      errors.push(
        `${animationLabel}.type 必须是非 none 的 ASCII lowerCamelCase`,
      );
    } else if (summary.types.has(animation.type)) {
      errors.push(`动画 type 重复: ${animation.type}`);
    } else {
      summary.types.add(animation.type);
    }

    if (
      typeof animation.component !== 'string'
      || !COMPONENT_PATTERN.test(animation.component)
    ) {
      errors.push(
        `${animationLabel}.component 必须是 ASCII PascalCase`,
      );
    } else if (summary.components.has(animation.component)) {
      errors.push(`动画 component 重复: ${animation.component}`);
    } else {
      summary.components.add(animation.component);
    }

    checkNonEmptyString(animation.title, `${animationLabel}.title`, errors);
    checkMechanism(animation.mechanism, `${animationLabel}.mechanism`, errors);

    if (!Array.isArray(animation.bindings)) {
      errors.push(`${animationLabel}.bindings 必须是数组`);
      return;
    }
    if (animation.bindings.length < 1) {
      errors.push(`${animationLabel}.bindings 至少需要 1 项`);
    }
    animation.bindings.forEach((binding, bindingIndex) => {
      const bindingLabel = `${animationLabel}.bindings[${bindingIndex}]`;
      if (!checkExactKeys(
        binding,
        ['pointId', 'suggestion'],
        bindingLabel,
        errors,
      )) {
        return;
      }
      checkKebabId(binding.pointId, `${bindingLabel}.pointId`, errors);
      checkNonEmptyString(
        binding.suggestion,
        `${bindingLabel}.suggestion`,
        errors,
      );
      if (typeof binding.pointId === 'string') {
        if (summary.bindingPointIds.has(binding.pointId)) {
          errors.push(`动画绑定 pointId 重复: ${binding.pointId}`);
        } else {
          summary.bindingPointIds.add(binding.pointId);
        }
      }
    });
  });

  return summary;
}

export function collectForbiddenFields(
  value,
  label,
  errors,
  path = '',
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectForbiddenFields(item, label, errors, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_DATA_KEYS.has(key)) {
      errors.push(`${label}.${childPath} 使用了禁止字段 "${key}"`);
    }
    collectForbiddenFields(child, label, errors, childPath);
  }
}
