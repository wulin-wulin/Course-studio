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
export const POINT_ORIGINS = new Set(['textbook', 'llm-extension', 'user']);
export const TEXTBOOK_CONTENT_SCHEMA = 'textbook-content/2.0';
export const TEXTBOOK_BLOCK_KINDS = new Set([
  'definition',
  'explanation',
  'mechanism',
  'procedure',
  'formula',
  'example',
  'worked-example',
  'comparison',
  'application',
  'code',
  'table',
  'figure',
  'warning',
  'misconception',
  'exercise',
  'summary',
  'note',
  'other',
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
  'origin',
  'sourceSpans',
  'modelEnriched',
];

export const POINT_ALLOWED_KEYS = [
  ...POINT_REQUIRED_KEYS,
  ...POINT_OPTIONAL_KEYS,
];

export const TEXTBOOK_POINT_REQUIRED_KEYS = [
  'id',
  'title',
  'shortSummary',
  'keyTerms',
  'animationType',
  'difficulty',
  'importance',
  'prerequisites',
  'origin',
  'content',
];

export const TEXTBOOK_POINT_ALLOWED_KEYS = [
  ...TEXTBOOK_POINT_REQUIRED_KEYS,
  'animationSuggestion',
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

function isMarkdownEscaped(value, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function markdownLines(value) {
  const lines = [];
  let start = 0;
  while (start < value.length) {
    let end = start;
    while (end < value.length && value[end] !== '\r' && value[end] !== '\n') {
      end += 1;
    }
    if (end < value.length) {
      end += 1;
      if (value[end - 1] === '\r' && value[end] === '\n') end += 1;
    }
    lines.push({ start, end, line: value.slice(start, end) });
    start = end;
  }
  return lines;
}

function markdownFenceRun(line) {
  let body = line;
  if (body.endsWith('\r\n')) body = body.slice(0, -2);
  else if (body.endsWith('\r') || body.endsWith('\n')) body = body.slice(0, -1);
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(body);
  if (!match) return null;
  return { marker: match[1], suffix: match[2] };
}

function maskMarkdownCode(value) {
  const masked = value.split('');
  let fence = null;
  for (const { start, end, line } of markdownLines(value)) {
    const run = markdownFenceRun(line);
    const closesFence = (
      fence !== null
      && run !== null
      && run.marker[0] === fence[0]
      && run.marker.length >= fence.length
      && /^[ \t]*$/u.test(run.suffix)
    );
    const opensFence = (
      fence === null
      && run !== null
      && (run.marker[0] === '~' || !run.suffix.includes('`'))
    );
    if (fence !== null || opensFence) {
      for (let index = start; index < end; index += 1) {
        if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
      }
    }
    if (opensFence) fence = run.marker;
    else if (closesFence) fence = null;
  }

  const withoutFences = masked.join('');
  let index = 0;
  while (index < withoutFences.length) {
    if (
      withoutFences[index] !== '`'
      || isMarkdownEscaped(withoutFences, index)
    ) {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (withoutFences[runEnd] === '`') runEnd += 1;
    const markerLength = runEnd - index;
    let search = runEnd;
    let close = -1;
    while (search < withoutFences.length) {
      const candidate = withoutFences.indexOf('`', search);
      if (candidate < 0) break;
      let closeEnd = candidate + 1;
      while (withoutFences[closeEnd] === '`') closeEnd += 1;
      if (closeEnd - candidate === markerLength) {
        close = candidate;
        break;
      }
      search = closeEnd;
    }
    if (close < 0) {
      index = runEnd;
      continue;
    }
    const closeEnd = close + markerLength;
    for (let cursor = index; cursor < closeEnd; cursor += 1) {
      if (masked[cursor] !== '\n' && masked[cursor] !== '\r') masked[cursor] = ' ';
    }
    index = closeEnd;
  }
  return masked.join('');
}

function findUnescaped(value, needle, start) {
  let cursor = start;
  while (cursor < value.length) {
    const found = value.indexOf(needle, cursor);
    if (found < 0 || !isMarkdownEscaped(value, found)) return found;
    cursor = found + needle.length;
  }
  return -1;
}

function maskLegacyMath(value, open, close) {
  const masked = value.split('');
  let cursor = 0;
  while (cursor < value.length) {
    const start = findUnescaped(value, open, cursor);
    if (start < 0) break;
    const end = findUnescaped(value, close, start + open.length);
    if (end < 0) {
      cursor = start + open.length;
      continue;
    }
    for (let index = start; index < end + close.length; index += 1) {
      if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
    }
    cursor = end + close.length;
  }
  return masked.join('');
}

function maskDollarMath(value) {
  const masked = value.split('');
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf('$', cursor);
    if (start < 0) break;
    let runEnd = start + 1;
    while (value[runEnd] === '$') runEnd += 1;
    const markerLength = runEnd - start;
    if (isMarkdownEscaped(value, start)) {
      cursor = runEnd;
      continue;
    }

    let search = runEnd;
    let close = -1;
    while (search < value.length) {
      const candidate = value.indexOf('$', search);
      if (candidate < 0) break;
      let closeEnd = candidate + 1;
      while (value[closeEnd] === '$') closeEnd += 1;
      if (closeEnd - candidate === markerLength) {
        close = candidate;
        break;
      }
      search = closeEnd;
    }
    if (close < 0) {
      cursor = runEnd;
      continue;
    }
    const closeEnd = close + markerLength;
    for (let index = start; index < closeEnd; index += 1) {
      if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
    }
    cursor = closeEnd;
  }
  return masked.join('');
}

function markdownProse(value) {
  let prose = maskMarkdownCode(value);
  // Accept the two legacy math delimiter forms for validation compatibility.
  // New generation is still instructed to emit $...$ and $$...$$.
  prose = maskLegacyMath(prose, '\\[', '\\]');
  prose = maskLegacyMath(prose, '\\(', '\\)');
  return maskDollarMath(prose);
}

function checkTextbookMarkdown(value, label, errors) {
  if (!checkNonEmptyString(value, label, errors)) return;
  const visibleText = maskMarkdownCode(value);
  if (/(?:\\r)?\\n(?:\\r)?\\n/u.test(visibleText)) {
    errors.push(`${label} 不得用可见的字面量 \\n\\n 代替真实段落换行`);
  }
  const prose = markdownProse(value);
  if (/\\+[A-Za-z]+/u.test(prose)) {
    errors.push(`${label} 的 LaTeX 命令必须放在数学分隔符内`);
  }
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

export function checkSourceSpans(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是数组`);
    return;
  }
  value.forEach((span, index) => {
    const spanLabel = `${label}[${index}]`;
    const required = [
      'materialId', 'blockIds', 'headingPath', 'lineStart', 'lineEnd',
      'assetRefs', 'excerptSha256',
    ];
    const allowed = [...required, 'page'];
    if (!checkObjectShape(span, required, allowed, spanLabel, errors)) return;
    checkNonEmptyString(span.materialId, `${spanLabel}.materialId`, errors);
    checkStringArray(span.blockIds, `${spanLabel}.blockIds`, errors, {
      min: 1,
      unique: true,
    });
    checkStringArray(span.headingPath, `${spanLabel}.headingPath`, errors, { min: 1 });
    checkStringArray(span.assetRefs, `${spanLabel}.assetRefs`, errors, {
      unique: true,
    });
    if (!Number.isInteger(span.lineStart) || span.lineStart < 1) {
      errors.push(`${spanLabel}.lineStart 必须是正整数`);
    }
    if (!Number.isInteger(span.lineEnd) || span.lineEnd < span.lineStart) {
      errors.push(`${spanLabel}.lineEnd 必须是不小于 lineStart 的正整数`);
    }
    if ('page' in span && (!Number.isInteger(span.page) || span.page < 1)) {
      errors.push(`${spanLabel}.page 必须是正整数`);
    }
    if (
      typeof span.excerptSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(span.excerptSha256)
    ) {
      errors.push(`${spanLabel}.excerptSha256 必须是小写 SHA-256`);
    }
  });
}

function sourceSpanKey(span) {
  if (!isRecord(span)) return JSON.stringify(span);
  return JSON.stringify({
    materialId: span.materialId,
    blockIds: span.blockIds,
    headingPath: span.headingPath,
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    page: span.page,
    assetRefs: span.assetRefs,
    excerptSha256: span.excerptSha256,
  });
}

export function isTextbookContentPoint(point) {
  return (
    isRecord(point)
    && isRecord(point.content)
    && point.content.schema_version === TEXTBOOK_CONTENT_SCHEMA
  );
}

export function derivePointSourceSpans(point) {
  if (!isTextbookContentPoint(point) || !Array.isArray(point.content.blocks)) {
    return Array.isArray(point?.sourceSpans) ? point.sourceSpans : [];
  }
  const seen = new Set();
  const spans = [];
  for (const block of point.content.blocks) {
    const blockSpans = isRecord(block?.provenance)
      && Array.isArray(block.provenance.sourceSpans)
      ? block.provenance.sourceSpans
      : [];
    for (const span of blockSpans) {
      const key = sourceSpanKey(span);
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push(span);
    }
  }
  return spans;
}

export function derivePointModelEnriched(point) {
  if (!isTextbookContentPoint(point) || !Array.isArray(point.content.blocks)) {
    return point?.modelEnriched === true;
  }
  return point.content.blocks.some((block) => (
    isRecord(block?.provenance)
    && block.provenance.origin === 'model'
  ));
}

function checkPointBase(point, label, errors) {
  checkKebabId(point.id, `${label}.id`, errors);
  checkNonEmptyString(point.title, `${label}.title`, errors);
  checkSummary(point.shortSummary, point.title, `${label}.shortSummary`, errors);
  checkStringArray(point.keyTerms, `${label}.keyTerms`, errors, {
    min: 2,
    max: 8,
    unique: true,
  });
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

function checkTextbookContent(content, label, errors) {
  if (!checkExactKeys(content, ['schema_version', 'blocks'], label, errors)) {
    return;
  }
  if (content.schema_version !== TEXTBOOK_CONTENT_SCHEMA) {
    errors.push(`${label}.schema_version 必须是 "${TEXTBOOK_CONTENT_SCHEMA}"`);
  }
  if (!Array.isArray(content.blocks)) {
    errors.push(`${label}.blocks 必须是数组`);
    return;
  }
  if (content.blocks.length < 2) {
    errors.push(`${label}.blocks 至少需要 1 个教材块和 1 个模型块`);
  }

  const blockIds = new Set();
  const blockIndexById = new Map();
  const groundedById = new Map();
  let textbookBlocks = 0;
  let modelBlocks = 0;
  content.blocks.forEach((block, index) => {
    const blockLabel = `${label}.blocks[${index}]`;
    if (!checkObjectShape(
      block,
      ['id', 'kind', 'markdown', 'provenance'],
      ['id', 'kind', 'title', 'markdown', 'provenance'],
      blockLabel,
      errors,
    )) {
      return;
    }
    checkKebabId(block.id, `${blockLabel}.id`, errors);
    if (typeof block.id === 'string') {
      if (blockIds.has(block.id)) {
        errors.push(`${label}.blocks 的 id 重复: ${block.id}`);
      } else {
        blockIds.add(block.id);
        blockIndexById.set(block.id, index);
      }
    }
    if (!TEXTBOOK_BLOCK_KINDS.has(block.kind)) {
      errors.push(`${blockLabel}.kind 不是允许的教材内容块类型`);
    }
    if ('title' in block) {
      checkNonEmptyString(block.title, `${blockLabel}.title`, errors);
    }
    checkTextbookMarkdown(block.markdown, `${blockLabel}.markdown`, errors);

    const provenance = block.provenance;
    if (!isRecord(provenance)) {
      errors.push(`${blockLabel}.provenance 必须是对象`);
      return;
    }
    if (provenance.origin === 'textbook') {
      textbookBlocks += 1;
      checkObjectShape(
        provenance,
        ['origin', 'representation', 'sourceSpans'],
        ['origin', 'representation', 'sourceSpans'],
        `${blockLabel}.provenance`,
        errors,
      );
      if (!['quote', 'paraphrase'].includes(provenance.representation)) {
        errors.push(
          `${blockLabel}.provenance.representation 必须是 quote/paraphrase`,
        );
      }
      checkSourceSpans(
        provenance.sourceSpans,
        `${blockLabel}.provenance.sourceSpans`,
        errors,
      );
      if (
        Array.isArray(provenance.sourceSpans)
        && provenance.sourceSpans.length < 1
      ) {
        errors.push(`${blockLabel} 教材块至少需要 1 个 sourceSpan`);
      }
      if (typeof block.id === 'string') groundedById.set(block.id, true);
      return;
    }
    if (provenance.origin === 'model') {
      modelBlocks += 1;
      checkObjectShape(
        provenance,
        ['origin', 'basedOnBlockIds'],
        ['origin', 'basedOnBlockIds', 'sourceSpans'],
        `${blockLabel}.provenance`,
        errors,
      );
      checkStringArray(
        provenance.basedOnBlockIds,
        `${blockLabel}.provenance.basedOnBlockIds`,
        errors,
        { min: 1, unique: true },
      );
      if ('sourceSpans' in provenance) {
        checkSourceSpans(
          provenance.sourceSpans,
          `${blockLabel}.provenance.sourceSpans`,
          errors,
        );
      }
      let grounded = false;
      let referencesAreValid = Array.isArray(provenance.basedOnBlockIds);
      const referencedIndexes = [];
      if (Array.isArray(provenance.basedOnBlockIds)) {
        for (const referencedId of provenance.basedOnBlockIds) {
          if (!blockIds.has(referencedId) || referencedId === block.id) {
            referencesAreValid = false;
            errors.push(
              `${blockLabel}.provenance.basedOnBlockIds 只能引用同一点中排在当前块之前的 block: ${referencedId}`,
            );
            continue;
          }
          referencedIndexes.push(blockIndexById.get(referencedId));
          if (groundedById.get(referencedId) === true) grounded = true;
        }
      }
      if (referencesAreValid && referencedIndexes.length > 0) {
        const lastReferenceIndex = Math.max(...referencedIndexes);
        const crossesTextbookBlock = content.blocks
          .slice(lastReferenceIndex + 1, index)
          .some((candidate) => (
            isRecord(candidate?.provenance)
            && candidate.provenance.origin === 'textbook'
          ));
        if (crossesTextbookBlock) {
          errors.push(
            `${blockLabel} 必须紧跟最后一个直接依据，不能跨过后续教材块`,
          );
        }
      }
      if (!grounded) {
        errors.push(
          `${blockLabel} 模型块必须通过 basedOnBlockIds 追溯到至少 1 个教材块`,
        );
      }
      if (typeof block.id === 'string') groundedById.set(block.id, grounded);
      return;
    }
    errors.push(`${blockLabel}.provenance.origin 必须是 textbook/model`);
  });

  if (textbookBlocks < 1) errors.push(`${label}.blocks 至少需要 1 个教材块`);
  if (modelBlocks < 1) errors.push(`${label}.blocks 至少需要 1 个模型补充块`);
}

function checkTextbookPoint(point, label, errors) {
  if (!checkObjectShape(
    point,
    TEXTBOOK_POINT_REQUIRED_KEYS,
    TEXTBOOK_POINT_ALLOWED_KEYS,
    label,
    errors,
  )) {
    return;
  }
  checkPointBase(point, label, errors);
  if (!POINT_ORIGINS.has(point.origin)) {
    errors.push(`${label}.origin 必须是 textbook/llm-extension/user`);
  }
  checkTextbookContent(point.content, `${label}.content`, errors);
}

export function checkPoint(point, label, errors) {
  if (isTextbookContentPoint(point)) {
    checkTextbookPoint(point, label, errors);
    return;
  }
  if (!checkObjectShape(
    point,
    POINT_REQUIRED_KEYS,
    POINT_ALLOWED_KEYS,
    label,
    errors,
  )) {
    return;
  }

  checkPointBase(point, label, errors);
  checkNonEmptyString(point.coreIdea, `${label}.coreIdea`, errors);
  checkStringArray(point.principles, `${label}.principles`, errors, {
    min: 2,
    max: 6,
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
  if ('origin' in point && !POINT_ORIGINS.has(point.origin)) {
    errors.push(`${label}.origin 必须是 textbook/llm-extension/user`);
  }
  if ('sourceSpans' in point) {
    checkSourceSpans(point.sourceSpans, `${label}.sourceSpans`, errors);
  }
  if ('modelEnriched' in point && typeof point.modelEnriched !== 'boolean') {
    errors.push(`${label}.modelEnriched 必须是布尔值`);
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
    const isTextbookBlockKind = (
      key === 'kind'
      && /^content\.blocks\[\d+\]\.kind$/.test(childPath)
    );
    if (FORBIDDEN_DATA_KEYS.has(key) && !isTextbookBlockKind) {
      errors.push(`${label}.${childPath} 使用了禁止字段 "${key}"`);
    }
    collectForbiddenFields(child, label, errors, childPath);
  }
}
