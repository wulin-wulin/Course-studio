#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  isDirectRun,
  isRecord,
  listSymbolicLinks,
  listJsonArtifacts,
  readJsonForValidation,
  sameJsonValue,
  sortStrings,
} from './lib/common.mjs';
import {
  ANIMATION_TYPE_PATTERN,
  COMPONENT_PATTERN,
  ID_PATTERN,
  INDEX_POINT_KEYS,
  SOURCE_ID_PATTERN,
  checkAnimationManifest,
  checkAnimationRequest,
  checkExactKeys,
  checkIndexPoint,
  checkKebabId,
  checkNonEmptyString,
  checkObjectShape,
  checkPoint,
  checkStringArray,
  collectForbiddenFields,
} from './lib/contracts.mjs';
import {
  renderAnimationBlock,
  renderAnimationBlockCss,
  renderCourseKnowledge,
} from './build_animation_registry.mjs';

const PHASES = new Set(['index', 'points', 'animations', 'all']);
const SOURCE_TYPES = new Set([
  'official-standard',
  'curriculum',
  'textbook',
  'university-course',
  'professional-standard',
  'handbook',
  'survey',
  'reference',
]);
const POINT_KINDS = new Set([
  'concept',
  'method',
  'theorem',
  'model',
  'algorithm',
  'task',
  'metric',
  'phenomenon',
]);
const SCOPE_STATUSES = new Set(['core', 'boundary', 'needs-review']);
const REVIEW_ISSUES = new Set([
  'scope-ambiguity',
  'granularity',
  'synonym',
  'naming',
  'insufficient-evidence',
]);
const EVIDENCE_MODES = new Set(['researched', 'model-only']);
const INPUT_TYPES = new Set(['course', 'domain']);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkDateString(value, label, errors) {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    errors.push(`${label} 必须是 YYYY-MM-DD 日期`);
    return;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value
  ) {
    errors.push(`${label} 不是有效日历日期: ${value}`);
  }
}

function normalizedTitle(value) {
  return value.trim().toLocaleLowerCase('zh-CN');
}

const TRACKING_QUERY_KEYS = new Set([
  '_ga',
  '_gl',
  'dclid',
  'fbclid',
  'gclid',
  'gbraid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  'msclkid',
  'wbraid',
  'yclid',
]);

function normalizedLocator(value) {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.hostname === '') throw new Error('locator 没有 host');

    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === 'http:' && url.port === '80')
      || (url.protocol === 'https:' && url.port === '443')
    ) {
      url.port = '';
    }
    url.hash = '';
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }

    const query = [...url.searchParams.entries()]
      .filter(([key]) => {
        const normalizedKey = key.toLowerCase();
        return (
          !normalizedKey.startsWith('utm_')
          && !TRACKING_QUERY_KEYS.has(normalizedKey)
        );
      })
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        if (leftKey < rightKey) return -1;
        if (leftKey > rightKey) return 1;
        if (leftValue < rightValue) return -1;
        if (leftValue > rightValue) return 1;
        return 0;
      });
    url.search = '';
    for (const [key, queryValue] of query) {
      url.searchParams.append(key, queryValue);
    }
    return url.toString();
  } catch {
    return trimmed.toLowerCase();
  }
}

function findForbiddenClusterFiles(root, errors) {
  function visit(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(`无法递归检查 clusters.json: ${directory}: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name === 'clusters.json') {
        errors.push(`中间包不得包含知识簇文件: ${path}`);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(path);
      }
    }
  }

  visit(root);
}

const CLUSTER_LAYOUT_KEYS = new Set([
  'clusters',
  'clusterId',
  'pos',
  'scale',
  'polygon',
  'labelPos',
  'accent',
  'soft',
  'dark',
]);

function isContractManagedJson(root, path) {
  const relativePath = relative(root, path).split(sep).join('/');
  return (
    relativePath === 'src/data/course.json'
    || relativePath === 'src/data/index.json'
    || relativePath === 'generation/manifest.json'
    || relativePath === 'generation/animation-manifest.json'
    || /^src\/data\/points\/[^/]+\.json$/.test(relativePath)
    || /^generation\/animation-requests\/[^/]+\.json$/.test(relativePath)
  );
}

function collectClusterLayoutFields(
  value,
  label,
  errors,
  path = '',
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectClusterLayoutFields(
        item,
        label,
        errors,
        `${path}[${index}]`,
      );
    });
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (CLUSTER_LAYOUT_KEYS.has(key)) {
      errors.push(`${label}.${childPath} 使用了禁止字段 "${key}"`);
    }
    collectClusterLayoutFields(child, label, errors, childPath);
  }
}

function validateAllJsonClusterLayout(root, errors) {
  function visit(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(`无法递归审查 JSON: ${directory}: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (
        !entry.isFile()
        || !entry.name.toLowerCase().endsWith('.json')
      ) {
        continue;
      }

      let value;
      try {
        value = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        if (!isContractManagedJson(root, path)) {
          const label = relative(root, path).split(sep).join('/');
          errors.push(`无法审查 JSON: ${label}: ${error.message}`);
        }
        continue;
      }
      const label = relative(root, path).split(sep).join('/');
      if (!isContractManagedJson(root, path)) {
        errors.push(`中间包包含契约外 JSON 文件: ${label}`);
      }
      collectClusterLayoutFields(value, label, errors);
    }
  }

  visit(root);
}

function validateCourse(course, errors) {
  const label = 'src/data/course.json';
  const keys = [
    'schema_version',
    'id',
    'title',
    'description',
    'language',
    'version',
    'updatedAt',
  ];
  if (!checkExactKeys(course, keys, label, errors)) return;

  if (course.schema_version !== '1.0') {
    errors.push(`${label}.schema_version 必须是 "1.0"`);
  }
  checkKebabId(course.id, `${label}.id`, errors);
  checkNonEmptyString(course.title, `${label}.title`, errors);
  checkNonEmptyString(course.description, `${label}.description`, errors);
  if (
    !checkNonEmptyString(course.language, `${label}.language`, errors)
    || course.language.length < 2
  ) {
    if (typeof course.language === 'string' && course.language.trim() !== '') {
      errors.push(`${label}.language 长度至少为 2`);
    }
  }
  if (
    checkNonEmptyString(course.version, `${label}.version`, errors)
    && !SEMVER_PATTERN.test(course.version)
  ) {
    errors.push(`${label}.version 必须符合 SemVer 2.0`);
  }
  checkDateString(course.updatedAt, `${label}.updatedAt`, errors);
}

function validateIndex(index, errors) {
  const result = {
    hasPointArray: false,
    pointById: new Map(),
    orderedIds: [],
    orderedPoints: [],
  };
  const label = 'src/data/index.json';
  if (!checkExactKeys(
    index,
    ['schema_version', 'courseId', 'points'],
    label,
    errors,
  )) {
    return result;
  }

  collectForbiddenFields(index, label, errors);
  if (index.schema_version !== 'course-content-index/1.0') {
    errors.push(
      `${label}.schema_version 必须是 "course-content-index/1.0"`,
    );
  }
  checkKebabId(index.courseId, `${label}.courseId`, errors);
  if (!Array.isArray(index.points)) {
    errors.push(`${label}.points 必须是数组`);
    return result;
  }

  result.hasPointArray = true;
  if (index.points.length < 1) {
    errors.push(`${label}.points 至少需要 1 项`);
  }
  const titleOwners = new Map();
  index.points.forEach((point, indexNumber) => {
    result.orderedPoints.push(point);
    const pointLabel = `${label}.points[${indexNumber}]`;
    checkIndexPoint(point, pointLabel, errors);
    if (!isRecord(point) || typeof point.id !== 'string') return;

    result.orderedIds.push(point.id);
    if (result.pointById.has(point.id)) {
      errors.push(`index.points 中知识点 ID 重复: ${point.id}`);
    } else {
      result.pointById.set(point.id, point);
    }
    if (typeof point.title === 'string' && point.title.trim() !== '') {
      const key = normalizedTitle(point.title);
      const owner = titleOwners.get(key);
      if (owner) {
        errors.push(`index.points 中知识点标题重复: ${owner} 与 ${point.id}`);
      } else {
        titleOwners.set(key, point.id);
      }
    }
  });
  return result;
}

function validateSubject(subject, errors) {
  const label = 'generation/manifest.json.subject';
  const keys = [
    'id',
    'input',
    'normalizedTitle',
    'inputType',
    'language',
    'audience',
    'depth',
    'scope',
    'exclusions',
    'outcomes',
  ];
  if (!checkExactKeys(subject, keys, label, errors)) return;

  checkKebabId(subject.id, `${label}.id`, errors);
  for (const key of [
    'input',
    'normalizedTitle',
    'language',
    'audience',
    'depth',
    'scope',
  ]) {
    checkNonEmptyString(subject[key], `${label}.${key}`, errors);
  }
  if (
    typeof subject.language === 'string'
    && subject.language.length < 2
  ) {
    errors.push(`${label}.language 长度至少为 2`);
  }
  if (!INPUT_TYPES.has(subject.inputType)) {
    errors.push(`${label}.inputType 只能是 course/domain`);
  }
  checkStringArray(subject.exclusions, `${label}.exclusions`, errors, {
    unique: true,
  });
  checkStringArray(subject.outcomes, `${label}.outcomes`, errors, {
    min: 1,
    unique: true,
  });
}

function validateGeneration(generation, errors) {
  const label = 'generation/manifest.json.generation';
  if (!checkExactKeys(
    generation,
    ['evidenceMode', 'generatedAt', 'pointCount'],
    label,
    errors,
  )) {
    return;
  }
  if (!EVIDENCE_MODES.has(generation.evidenceMode)) {
    errors.push(`${label}.evidenceMode 只能是 researched/model-only`);
  }
  checkDateString(generation.generatedAt, `${label}.generatedAt`, errors);
  if (!Number.isInteger(generation.pointCount) || generation.pointCount < 1) {
    errors.push(`${label}.pointCount 必须是至少为 1 的整数`);
  }
}

function validateSources(sources, errors) {
  const sourceById = new Map();
  if (!Array.isArray(sources)) {
    errors.push('generation/manifest.json.sources 必须是数组');
    return sourceById;
  }

  sources.forEach((source, index) => {
    const label = `generation/manifest.json.sources[${index}]`;
    if (!checkExactKeys(
      source,
      ['id', 'type', 'title', 'locator', 'accessedAt'],
      label,
      errors,
    )) {
      return;
    }
    if (
      typeof source.id !== 'string'
      || !SOURCE_ID_PATTERN.test(source.id)
    ) {
      errors.push(`${label}.id 必须匹配 src-<kebab-id>`);
    } else if (sourceById.has(source.id)) {
      errors.push(`generation manifest 中来源 ID 重复: ${source.id}`);
    } else {
      sourceById.set(source.id, source);
    }
    if (!SOURCE_TYPES.has(source.type)) {
      errors.push(`${label}.type 不是允许的来源类型`);
    }
    checkNonEmptyString(source.title, `${label}.title`, errors);
    checkNonEmptyString(source.locator, `${label}.locator`, errors);
    checkDateString(source.accessedAt, `${label}.accessedAt`, errors);
  });
  return sourceById;
}

function validateResearchedLocators(sources, errors) {
  if (!Array.isArray(sources)) return;
  const locatorOwners = new Map();
  sources.forEach((source, index) => {
    if (!isRecord(source) || typeof source.locator !== 'string') return;
    const locator = normalizedLocator(source.locator);
    if (locator === '') return;
    const owner = locatorOwners.get(locator);
    if (owner) {
      errors.push(
        `researched 来源 locator 规范化后重复: sources[${owner.index}] ${JSON.stringify(owner.locator)} 与 sources[${index}] ${JSON.stringify(source.locator)}`,
      );
    } else {
      locatorOwners.set(locator, {
        index,
        locator: source.locator,
      });
    }
  });
}

function validatePointEvidence(pointEvidence, sourceById, errors) {
  const evidenceByPointId = new Map();
  if (!Array.isArray(pointEvidence)) {
    errors.push('generation/manifest.json.pointEvidence 必须是数组');
    return evidenceByPointId;
  }
  if (pointEvidence.length < 1) {
    errors.push('generation/manifest.json.pointEvidence 至少需要 1 项');
  }

  pointEvidence.forEach((evidence, index) => {
    const label = `generation/manifest.json.pointEvidence[${index}]`;
    if (!checkExactKeys(
      evidence,
      ['pointId', 'title', 'kind', 'sourceRefs', 'confidence', 'scopeStatus'],
      label,
      errors,
    )) {
      return;
    }
    checkKebabId(evidence.pointId, `${label}.pointId`, errors);
    checkNonEmptyString(evidence.title, `${label}.title`, errors);
    if (typeof evidence.pointId === 'string') {
      if (evidenceByPointId.has(evidence.pointId)) {
        errors.push(`pointEvidence 的 pointId 重复: ${evidence.pointId}`);
      } else {
        evidenceByPointId.set(evidence.pointId, evidence);
      }
    }
    if (!POINT_KINDS.has(evidence.kind)) {
      errors.push(`${label}.kind 不是允许的知识原子类型`);
    }
    checkStringArray(evidence.sourceRefs, `${label}.sourceRefs`, errors, {
      unique: true,
    });
    if (Array.isArray(evidence.sourceRefs)) {
      evidence.sourceRefs.forEach((sourceId) => {
        if (
          typeof sourceId === 'string'
          && !SOURCE_ID_PATTERN.test(sourceId)
        ) {
          errors.push(`${label}.sourceRefs 中来源 ID 格式无效: ${sourceId}`);
        } else if (
          typeof sourceId === 'string'
          && !sourceById.has(sourceId)
        ) {
          errors.push(`${label}.sourceRefs 指向不存在的来源: ${sourceId}`);
        }
      });
    }
    if (
      typeof evidence.confidence !== 'number'
      || !Number.isFinite(evidence.confidence)
      || evidence.confidence < 0
      || evidence.confidence > 1
    ) {
      errors.push(`${label}.confidence 必须是 [0, 1] 内有限数值`);
    }
    if (!SCOPE_STATUSES.has(evidence.scopeStatus)) {
      errors.push(`${label}.scopeStatus 不是允许的范围状态`);
    }
  });
  return evidenceByPointId;
}

function validateEvidenceIdentity(pointEvidence, indexContext, errors) {
  if (!indexContext.hasPointArray || !Array.isArray(pointEvidence)) return;
  if (pointEvidence.length !== indexContext.orderedPoints.length) {
    errors.push(
      `manifest.pointEvidence 必须与 index.points 等长且同序：${pointEvidence.length} !== ${indexContext.orderedPoints.length}`,
    );
  }

  indexContext.orderedPoints.forEach((point, index) => {
    const evidence = pointEvidence[index];
    if (!isRecord(point) || !isRecord(evidence)) return;
    if (evidence.pointId !== point.id) {
      errors.push(
        `manifest.pointEvidence[${index}].pointId 必须与 index.points[${index}].id 同序一致`,
      );
    }
    if (evidence.title !== point.title) {
      errors.push(
        `manifest.pointEvidence[${index}].title 必须与 index.points[${index}].title 同序一致`,
      );
    }
  });
}

function validateReviewQueue(reviewQueue, indexContext, errors) {
  const reviewedPointIds = new Set();
  if (!Array.isArray(reviewQueue)) {
    errors.push('generation/manifest.json.reviewQueue 必须是数组');
    return reviewedPointIds;
  }
  reviewQueue.forEach((item, index) => {
    const label = `generation/manifest.json.reviewQueue[${index}]`;
    if (!checkObjectShape(
      item,
      ['term', 'issue', 'reason', 'suggestedAction'],
      ['pointId', 'term', 'issue', 'reason', 'suggestedAction'],
      label,
      errors,
    )) {
      return;
    }
    if ('pointId' in item) {
      checkKebabId(item.pointId, `${label}.pointId`, errors);
      if (
        typeof item.pointId === 'string'
        && !indexContext.pointById.has(item.pointId)
      ) {
        errors.push(`${label}.pointId 不在 index 中: ${item.pointId}`);
      } else if (typeof item.pointId === 'string') {
        reviewedPointIds.add(item.pointId);
      }
    }
    checkNonEmptyString(item.term, `${label}.term`, errors);
    if (!REVIEW_ISSUES.has(item.issue)) {
      errors.push(`${label}.issue 不是允许的复核问题类型`);
    }
    checkNonEmptyString(item.reason, `${label}.reason`, errors);
    checkNonEmptyString(
      item.suggestedAction,
      `${label}.suggestedAction`,
      errors,
    );
  });
  return reviewedPointIds;
}

function validateGenerationManifest(
  manifest,
  indexContext,
  course,
  errors,
) {
  const label = 'generation/manifest.json';
  const result = {
    sourceById: new Map(),
    evidenceByPointId: new Map(),
  };
  if (!checkExactKeys(
    manifest,
    ['schema_version', 'subject', 'generation', 'sources', 'pointEvidence', 'reviewQueue'],
    label,
    errors,
  )) {
    return result;
  }

  if (manifest.schema_version !== 'course-content-generation/1.0') {
    errors.push(
      `${label}.schema_version 必须是 "course-content-generation/1.0"`,
    );
  }
  validateSubject(manifest.subject, errors);
  validateGeneration(manifest.generation, errors);
  result.sourceById = validateSources(manifest.sources, errors);
  result.evidenceByPointId = validatePointEvidence(
    manifest.pointEvidence,
    result.sourceById,
    errors,
  );
  validateEvidenceIdentity(manifest.pointEvidence, indexContext, errors);
  const reviewedPointIds = validateReviewQueue(
    manifest.reviewQueue,
    indexContext,
    errors,
  );
  for (const [pointId, evidence] of result.evidenceByPointId) {
    const requiresReview = (
      evidence.scopeStatus === 'boundary'
      || evidence.scopeStatus === 'needs-review'
      || (
        typeof evidence.confidence === 'number'
        && evidence.confidence < 0.5
      )
    );
    if (requiresReview && !reviewedPointIds.has(pointId)) {
      errors.push(
        `知识点 ${pointId} 的 scopeStatus/confidence 要求至少一个相同 pointId 的 reviewQueue 项`,
      );
    }
  }

  if (isRecord(course) && isRecord(manifest.subject)) {
    if (manifest.subject.id !== course.id) {
      errors.push(
        `manifest.subject.id 必须与 course.id 一致：${JSON.stringify(manifest.subject.id)} !== ${JSON.stringify(course.id)}`,
      );
    }
    if (manifest.subject.language !== course.language) {
      errors.push(
        `manifest.subject.language 必须与 course.language 一致`,
      );
    }
  }
  if (
    isRecord(manifest.generation)
    && Number.isInteger(manifest.generation.pointCount)
    && indexContext.hasPointArray
    && manifest.generation.pointCount !== indexContext.orderedIds.length
  ) {
    errors.push(
      `manifest.generation.pointCount 为 ${manifest.generation.pointCount}，但 index 有 ${indexContext.orderedIds.length} 个知识点`,
    );
  }

  if (indexContext.hasPointArray) {
    for (const id of indexContext.pointById.keys()) {
      if (!result.evidenceByPointId.has(id)) {
        errors.push(`index 知识点缺少 pointEvidence: ${id}`);
      }
    }
    for (const id of result.evidenceByPointId.keys()) {
      if (!indexContext.pointById.has(id)) {
        errors.push(`pointEvidence 包含 index 不存在的知识点: ${id}`);
      }
    }
  }

  const mode = isRecord(manifest.generation)
    ? manifest.generation.evidenceMode
    : null;
  if (mode === 'researched') {
    validateResearchedLocators(manifest.sources, errors);
    if (result.sourceById.size < 3) {
      errors.push('researched 模式至少需要 3 个 ID 唯一的来源');
    }
    const sourceTypes = new Set(
      [...result.sourceById.values()].map((source) => source.type),
    );
    if (sourceTypes.size < 2) {
      errors.push('researched 模式的来源至少覆盖 2 种类型');
    }
    for (const [pointId, evidence] of result.evidenceByPointId) {
      if (
        !Array.isArray(evidence.sourceRefs)
        || evidence.sourceRefs.length < 1
      ) {
        errors.push(`researched 模式下 ${pointId} 至少需要 1 个 sourceRefs`);
      }
    }
  } else if (mode === 'model-only') {
    if (Array.isArray(manifest.sources) && manifest.sources.length !== 0) {
      errors.push('model-only 模式的 sources 必须为空');
    }
    for (const [pointId, evidence] of result.evidenceByPointId) {
      if (
        Array.isArray(evidence.sourceRefs)
        && evidence.sourceRefs.length !== 0
      ) {
        errors.push(`model-only 模式下 ${pointId} 的 sourceRefs 必须为空`);
      }
      if (
        typeof evidence.confidence === 'number'
        && evidence.confidence > 0.6
      ) {
        errors.push(`model-only 模式下 ${pointId} 的 confidence 不得高于 0.6`);
      }
    }
  }
  return result;
}

function validateIndexStage(root, errors) {
  const coursePath = join(root, 'src/data/course.json');
  const indexPath = join(root, 'src/data/index.json');
  const manifestPath = join(root, 'generation/manifest.json');

  const course = readJsonForValidation(coursePath, errors);
  const index = readJsonForValidation(indexPath, errors);
  const manifest = readJsonForValidation(manifestPath, errors);
  findForbiddenClusterFiles(root, errors);
  validateAllJsonClusterLayout(root, errors);

  if (course !== null) validateCourse(course, errors);
  const indexContext = index !== null
    ? validateIndex(index, errors)
    : {
      hasPointArray: false,
      pointById: new Map(),
      orderedIds: [],
      orderedPoints: [],
    };
  if (manifest !== null) {
    validateGenerationManifest(manifest, indexContext, course, errors);
  }

  if (isRecord(course) && isRecord(index)) {
    if (index.courseId !== course.id) {
      errors.push(
        `index.courseId 必须与 course.id 一致：${JSON.stringify(index.courseId)} !== ${JSON.stringify(course.id)}`,
      );
    }
  }

  return {
    ...indexContext,
    course,
    index,
    manifest,
  };
}

function compareArtifactSet(expectedIds, actualIds, missingMessage, extraMessage, errors) {
  for (const id of expectedIds) {
    if (!actualIds.has(id)) errors.push(missingMessage(id));
  }
  for (const id of actualIds) {
    if (!expectedIds.has(id)) errors.push(extraMessage(id));
  }
}

function loadPointAndRequestArtifacts(root, expectedIds, errors) {
  const pointsRoot = join(root, 'src/data/points');
  const requestsRoot = join(root, 'generation/animation-requests');
  const pointArtifacts = listJsonArtifacts(pointsRoot, errors);
  const requestArtifacts = listJsonArtifacts(requestsRoot, errors);
  const pointById = new Map();
  const requestById = new Map();
  const pointInternalOwners = new Map();
  const requestInternalOwners = new Map();

  for (const artifact of pointArtifacts) {
    const label = `src/data/points/${artifact.filename}`;
    if (!ID_PATTERN.test(artifact.fileId)) {
      errors.push(`${label} 文件名必须是 ASCII kebab-case ID`);
    }
    pointById.set(artifact.fileId, artifact.value);
    if (artifact.value === null) continue;
    if (!isRecord(artifact.value)) {
      errors.push(`${label} 顶层必须是对象`);
      continue;
    }
    if (artifact.value.id !== artifact.fileId) {
      errors.push(
        `${label} 的 id 必须与文件名一致，期望 ${JSON.stringify(artifact.fileId)}，实际为 ${JSON.stringify(artifact.value.id)}`,
      );
    }
    if (typeof artifact.value.id === 'string') {
      const owner = pointInternalOwners.get(artifact.value.id);
      if (owner) {
        errors.push(
          `详情内部 id 重复: ${owner} 与 ${artifact.filename} 均为 ${artifact.value.id}`,
        );
      } else {
        pointInternalOwners.set(artifact.value.id, artifact.filename);
      }
    }
  }

  if (pointArtifacts.length === 0) {
    errors.push('src/data/points/ 中没有知识点 JSON');
  }
  const pointFileIds = new Set(pointById.keys());
  if (expectedIds !== null) {
    compareArtifactSet(
      expectedIds,
      pointFileIds,
      (id) => `index.json 中的知识点缺少详情文件: ${id}.json`,
      (id) => `详情文件未进入 index.json: ${id}.json`,
      errors,
    );
  }
  const universeIds = expectedIds ?? pointFileIds;

  for (const artifact of requestArtifacts) {
    const label = `generation/animation-requests/${artifact.filename}`;
    if (!ID_PATTERN.test(artifact.fileId)) {
      errors.push(`${label} 文件名必须是 ASCII kebab-case ID`);
    }
    requestById.set(artifact.fileId, artifact.value);
    if (artifact.value === null) continue;
    checkAnimationRequest(artifact.value, label, errors);
    if (!isRecord(artifact.value)) continue;
    if (artifact.value.pointId !== artifact.fileId) {
      errors.push(
        `${label} 的 pointId 必须与文件名一致，期望 ${JSON.stringify(artifact.fileId)}，实际为 ${JSON.stringify(artifact.value.pointId)}`,
      );
    }
    if (typeof artifact.value.pointId === 'string') {
      const owner = requestInternalOwners.get(artifact.value.pointId);
      if (owner) {
        errors.push(
          `动画请求 pointId 重复: ${owner} 与 ${artifact.filename} 均为 ${artifact.value.pointId}`,
        );
      } else {
        requestInternalOwners.set(
          artifact.value.pointId,
          artifact.filename,
        );
      }
    }
  }

  compareArtifactSet(
    universeIds,
    new Set(requestById.keys()),
    (id) => `知识点 ${id} 缺少同名动画请求文件`,
    (id) => `动画请求没有对应知识点: ${id}.json`,
    errors,
  );
  return {
    pointArtifacts,
    requestArtifacts,
    pointById,
    requestById,
    universeIds,
  };
}

function checkPrerequisiteGraph(ids, prerequisitesById, errors) {
  const state = new Map([...ids].map((id) => [id, 0]));
  const stack = [];
  const reportedCycles = new Set();

  function visit(id) {
    state.set(id, 1);
    stack.push(id);
    for (const prerequisite of prerequisitesById.get(id) ?? []) {
      if (!ids.has(prerequisite) || prerequisite === id) continue;
      const prerequisiteState = state.get(prerequisite) ?? 0;
      if (prerequisiteState === 0) {
        visit(prerequisite);
      } else if (prerequisiteState === 1) {
        const start = stack.lastIndexOf(prerequisite);
        const cycle = [...stack.slice(start), prerequisite];
        const key = sortStrings(new Set(cycle.slice(0, -1))).join('|');
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          errors.push(`前置依赖存在环: ${cycle.join(' -> ')}`);
        }
      }
    }
    stack.pop();
    state.set(id, 2);
  }

  for (const id of sortStrings(ids)) {
    if (state.get(id) === 0) visit(id);
  }
}

function validatePointsStage(
  indexContext,
  artifacts,
  errors,
  { requireDraftAnimations = false } = {},
) {
  const prerequisitesById = new Map();
  for (const artifact of artifacts.pointArtifacts) {
    const point = artifact.value;
    const label = `src/data/points/${artifact.filename}`;
    if (!isRecord(point)) continue;

    checkPoint(point, label, errors);
    collectForbiddenFields(point, label, errors);
    if (requireDraftAnimations) {
      if (point.animationType !== 'none') {
        errors.push(
          `${label}.animationType 在 points 初稿阶段必须为 "none"`,
        );
      }
      if ('animationSuggestion' in point) {
        errors.push(
          `${label} 在 points 初稿阶段不得包含 animationSuggestion`,
        );
      }
    }
    const meta = indexContext.pointById.get(artifact.fileId);
    if (meta) {
      if (point.id !== meta.id) {
        errors.push(
          `知识点 ${artifact.fileId} 的 id 已冻结：index 为 ${JSON.stringify(meta.id)}，详情为 ${JSON.stringify(point.id)}`,
        );
      }
      if (point.title !== meta.title) {
        errors.push(
          `知识点 ${artifact.fileId} 的 title 已冻结：index 为 ${JSON.stringify(meta.title)}，详情为 ${JSON.stringify(point.title)}`,
        );
      }
    }

    const prerequisites = Array.isArray(point.prerequisites)
      ? point.prerequisites.filter((id) => typeof id === 'string')
      : [];
    prerequisitesById.set(artifact.fileId, prerequisites);
    for (const prerequisite of prerequisites) {
      if (
        prerequisite === artifact.fileId
        || prerequisite === point.id
      ) {
        errors.push(`${label}.prerequisites 不允许自环: ${prerequisite}`);
      } else if (!artifacts.universeIds.has(prerequisite)) {
        errors.push(`${label} 前置依赖悬空: ${prerequisite}`);
      }
    }
  }

  checkPrerequisiteGraph(
    artifacts.universeIds,
    prerequisitesById,
    errors,
  );
}

function buildBindingMaps(manifest) {
  const bindingCounts = new Map();
  const bindingByPointId = new Map();
  if (!isRecord(manifest) || !Array.isArray(manifest.animations)) {
    return { bindingCounts, bindingByPointId };
  }

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
    }
  }
  return { bindingCounts, bindingByPointId };
}

function readTextForValidation(path, errors) {
  if (!existsSync(path)) {
    errors.push(`缺少文件: ${path}`);
    return null;
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      errors.push(`源码文件不得是符号链接: ${path}`);
      return null;
    }
    if (!stat.isFile()) {
      errors.push(`源码路径不是普通文件: ${path}`);
      return null;
    }
    return readFileSync(path, 'utf8');
  } catch (error) {
    errors.push(`无法读取文件: ${path}: ${error.message}`);
    return null;
  }
}

function hasNamedDefaultExport(source, component) {
  const name = escapeRegExp(component);
  return (
    new RegExp(`export\\s+default\\s+function\\s+${name}\\b`).test(source)
    || new RegExp(`export\\s+default\\s+class\\s+${name}\\b`).test(source)
    || new RegExp(`export\\s+default\\s+${name}\\s*;?`).test(source)
    || new RegExp(
      `export\\s*\\{\\s*${name}\\s+as\\s+default\\s*\\}`,
    ).test(source)
  );
}

function hasInteractiveControl(source, label) {
  const buttons = source.match(
    /<button\b[\s\S]*?(?:<\/button>|\/>)/g,
  ) ?? [];
  return buttons.some((button) => (
    /onClick\s*=/.test(button)
    && button.includes(label)
  ));
}

function validateAnimationFileSet(root, animations, errors) {
  const animationsRoot = join(root, 'src/animations');
  const expectedTsx = new Set();
  const expectedCss = new Set();
  for (const animation of animations) {
    if (
      !isRecord(animation)
      || typeof animation.component !== 'string'
      || !COMPONENT_PATTERN.test(animation.component)
    ) {
      continue;
    }
    expectedTsx.add(`${animation.component}.tsx`);
    expectedCss.add(`${animation.component}.css`);
  }

  let entries;
  try {
    const rootStat = lstatSync(animationsRoot);
    if (rootStat.isSymbolicLink()) {
      errors.push(`src/animations 不得是符号链接目录: ${animationsRoot}`);
      return;
    }
    if (!rootStat.isDirectory()) {
      errors.push(`src/animations 不是目录: ${animationsRoot}`);
      return;
    }
    entries = readdirSync(animationsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' && expectedTsx.size === 0) return;
    errors.push(`无法读取动画目录: ${animationsRoot}: ${error.message}`);
    return;
  }

  const actualTsx = new Set();
  const actualCss = new Set();
  for (const entry of entries) {
    if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.css')) continue;
    if (entry.isSymbolicLink()) {
      errors.push(`src/animations 不允许符号链接源码: ${entry.name}`);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.tsx')) actualTsx.add(entry.name);
    if (entry.name.endsWith('.css')) actualCss.add(entry.name);
  }

  compareArtifactSet(
    expectedTsx,
    actualTsx,
    (name) => `manifest 动画缺少 TSX 文件: src/animations/${name}`,
    (name) => `src/animations 存在 manifest 未声明的 TSX 文件: ${name}`,
    errors,
  );
  compareArtifactSet(
    expectedCss,
    actualCss,
    (name) => `manifest 动画缺少 CSS 文件: src/animations/${name}`,
    (name) => `src/animations 存在 manifest 未声明的 CSS 文件: ${name}`,
    errors,
  );
}

function validateAnimationDynamics(animation, source, css, tsxPath, errors) {
  const usesReactState = /\b(?:useState|useReducer)\s*(?:<[^;\n(){}]+>)?\s*\(/.test(source);
  const usesSmil = /<(?:animate|animateMotion|set)(?:\s|>)/.test(source);
  const usesCssKeyframes = css !== null && /@keyframes\b/i.test(css);
  if (!usesReactState && !usesSmil && !usesCssKeyframes) {
    errors.push(
      `${tsxPath} 缺少真实动态信号（useState/useReducer、SVG SMIL 或 CSS @keyframes）`,
    );
  }

  if (!hasInteractiveControl(source, '重播')) {
    errors.push(`${tsxPath} 必须提供带 onClick 的“重播”按钮`);
  }
  if (
    isRecord(animation.mechanism)
    && animation.mechanism.replayMode === 'both'
  ) {
    if (!hasInteractiveControl(source, '重新生成')) {
      errors.push(
        `${tsxPath} 的 replayMode=both，必须提供带 onClick 的“重新生成”按钮`,
      );
    }
    if (!/seed/i.test(source)) {
      errors.push(`${tsxPath} 的随机重放过程必须使用显式 seed`);
    }
  }

  const cleanupPairs = [
    ['setInterval', /\bsetInterval\s*\(/, /\bclearInterval\s*\(/],
    ['setTimeout', /\bsetTimeout\s*\(/, /\bclearTimeout\s*\(/],
    [
      'requestAnimationFrame',
      /\brequestAnimationFrame\s*\(/,
      /\bcancelAnimationFrame\s*\(/,
    ],
    [
      'addEventListener',
      /\baddEventListener\s*\(/,
      /\bremoveEventListener\s*\(/,
    ],
    [
      'ResizeObserver',
      /\bResizeObserver\s*\(/,
      /\.disconnect\s*\(/,
    ],
    [
      'IntersectionObserver',
      /\bIntersectionObserver\s*\(/,
      /\.disconnect\s*\(/,
    ],
  ];
  for (const [resource, usagePattern, cleanupPattern] of cleanupPairs) {
    if (usagePattern.test(source) && !cleanupPattern.test(source)) {
      errors.push(`${tsxPath} 使用 ${resource} 时必须包含对应清理逻辑`);
    }
  }

  const usesJsClock = (
    /\b(?:setInterval|setTimeout|requestAnimationFrame)\s*\(/.test(source)
  );
  if (
    (usesJsClock || usesSmil)
    && !/prefers-reduced-motion/.test(source)
  ) {
    errors.push(
      `${tsxPath} 使用 JS timer/RAF 或 SVG SMIL 时必须显式处理 prefers-reduced-motion`,
    );
  }
  if (/\bMath\.random\s*\(/.test(source)) {
    errors.push(`${tsxPath} 禁止使用 Math.random，随机过程必须使用 seed`);
  }
  if (
    /(?:random|getRandomValues)/i.test(source)
    && !/seed/i.test(source)
  ) {
    errors.push(`${tsxPath} 的随机过程缺少显式 seed`);
  }
}

function validateAnimationComponents(root, animations, errors) {
  validateAnimationFileSet(root, animations, errors);
  for (const animation of animations) {
    if (
      !isRecord(animation)
      || typeof animation.component !== 'string'
      || !COMPONENT_PATTERN.test(animation.component)
    ) {
      continue;
    }
    const component = animation.component;
    const tsxPath = join(root, 'src/animations', `${component}.tsx`);
    const cssPath = join(root, 'src/animations', `${component}.css`);
    const source = readTextForValidation(tsxPath, errors);
    const css = readTextForValidation(cssPath, errors);

    if (source !== null) {
      if (!hasNamedDefaultExport(source, component)) {
        errors.push(`${tsxPath} 必须默认导出同名组件 ${component}`);
      }
      const cssImport = new RegExp(
        `import\\s+['"]\\./${escapeRegExp(component)}\\.css['"]`,
      );
      if (!cssImport.test(source)) {
        errors.push(`${tsxPath} 必须直接导入 ./${component}.css`);
      }
      if (!/animation-stage/.test(source)) {
        errors.push(`${tsxPath} 根视图必须包含 animation-stage`);
      }
      if (!/aria-label\s*=/.test(source)) {
        errors.push(`${tsxPath} 根视图缺少 aria-label`);
      }
      if (
        !/role\s*=\s*(?:"img"|'img'|\{\s*["']img["']\s*\})/.test(source)
      ) {
        errors.push(`${tsxPath} 的主 SVG 缺少 role="img"`);
      }
      if (!/<title(?:\s|>)/.test(source)) {
        errors.push(`${tsxPath} 的主 SVG 缺少 <title>`);
      }
      if (!/<svg\b[\s\S]*?\bviewBox\s*=/.test(source)) {
        errors.push(`${tsxPath} 的主 SVG 缺少响应式 viewBox`);
      }
      validateAnimationDynamics(animation, source, css, tsxPath, errors);
    }
    if (
      css !== null
      && !/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/.test(css)
    ) {
      errors.push(`${cssPath} 缺少 prefers-reduced-motion 降级`);
    }
  }
}

function validateGeneratedRegistry(root, animations, errors) {
  const canRender = animations.every((animation) => (
    isRecord(animation)
    && typeof animation.type === 'string'
    && ANIMATION_TYPE_PATTERN.test(animation.type)
    && animation.type !== 'none'
    && typeof animation.component === 'string'
    && COMPONENT_PATTERN.test(animation.component)
    && typeof animation.title === 'string'
  ));
  if (!canRender) return;

  let expectedSources;
  try {
    expectedSources = [
      {
        path: join(root, 'src/data/courseKnowledge.ts'),
        label: 'src/data/courseKnowledge.ts',
        contents: renderCourseKnowledge(
          animations.map((animation) => animation.type),
        ),
      },
      {
        path: join(root, 'src/components/AnimationBlock.tsx'),
        label: 'src/components/AnimationBlock.tsx',
        contents: renderAnimationBlock(animations),
      },
      {
        path: join(root, 'src/components/AnimationBlock.css'),
        label: 'src/components/AnimationBlock.css',
        contents: renderAnimationBlockCss(),
      },
    ];
  } catch (error) {
    errors.push(`无法根据 animation manifest 渲染注册层: ${error.message}`);
    return;
  }

  for (const expected of expectedSources) {
    const actual = readTextForValidation(expected.path, errors);
    if (actual !== null && actual !== expected.contents) {
      errors.push(
        `${expected.label} 与 build_animation_registry.mjs 的确定性输出不一致`,
      );
    }
  }
}

function validateAnimationsStage(root, artifacts, errors) {
  const manifestPath = join(root, 'generation/animation-manifest.json');
  const manifest = readJsonForValidation(manifestPath, errors);
  if (manifest === null) {
    return { animationTypes: [], manifest: null };
  }
  checkAnimationManifest(
    manifest,
    'generation/animation-manifest.json',
    errors,
  );
  const animations = isRecord(manifest) && Array.isArray(manifest.animations)
    ? manifest.animations
    : [];
  const { bindingCounts, bindingByPointId } = buildBindingMaps(manifest);

  for (const pointId of bindingByPointId.keys()) {
    if (!artifacts.pointById.has(pointId)) {
      errors.push(`动画绑定指向不存在的知识点: ${pointId}`);
    }
    if (!artifacts.requestById.has(pointId)) {
      errors.push(`动画绑定缺少对应请求: ${pointId}`);
    }
  }
  for (const [id, request] of artifacts.requestById) {
    if (!isRecord(request)) continue;
    const count = bindingCounts.get(id) ?? 0;
    if (request.needed === true && count !== 1) {
      errors.push(`needed=true 的知识点 ${id} 必须恰好绑定一次，实际为 ${count}`);
    }
    if (request.needed === false && count !== 0) {
      errors.push(`needed=false 的知识点 ${id} 不得绑定动画`);
    }
    if (
      request.needed === true
      && count === 1
      && bindingByPointId.get(id)?.suggestion !== request.suggestion
    ) {
      errors.push(
        `动画绑定 ${id} 的 suggestion 必须与 needed=true 请求完全一致`,
      );
    }
  }

  for (const [id, point] of artifacts.pointById) {
    if (!isRecord(point)) continue;
    const binding = bindingByPointId.get(id);
    if (binding) {
      if (point.animationType !== binding.type) {
        errors.push(
          `points/${id}.json.animationType 应为 ${JSON.stringify(binding.type)}，实际为 ${JSON.stringify(point.animationType)}`,
        );
      }
      if (point.animationSuggestion !== binding.suggestion) {
        errors.push(
          `points/${id}.json.animationSuggestion 必须与 manifest 绑定一致`,
        );
      }
    } else {
      if (point.animationType !== 'none') {
        errors.push(
          `未绑定动画的 points/${id}.json.animationType 必须为 "none"`,
        );
      }
      if ('animationSuggestion' in point) {
        errors.push(
          `未绑定动画的 points/${id}.json 不应有 animationSuggestion`,
        );
      }
    }
  }

  validateAnimationComponents(root, animations, errors);
  validateGeneratedRegistry(root, animations, errors);
  return {
    manifest,
    animationTypes: sortStrings(new Set(
      animations
        .filter((animation) => (
          isRecord(animation)
          && typeof animation.type === 'string'
          && ANIMATION_TYPE_PATTERN.test(animation.type)
          && animation.type !== 'none'
        ))
        .map((animation) => animation.type),
    )),
  };
}

function validateDeepIndexSync(indexContext, artifacts, errors) {
  if (!indexContext.hasPointArray) return;
  for (const [id, meta] of indexContext.pointById) {
    const point = artifacts.pointById.get(id);
    if (!isRecord(point)) continue;
    for (const key of INDEX_POINT_KEYS) {
      if (!sameJsonValue(meta[key], point[key])) {
        errors.push(
          `all 阶段要求知识点 ${id} 的 ${key} 在 index 与详情中深度一致`,
        );
      }
    }
  }
}

export function validateProject(projectRoot, options = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error('projectRoot 必须是非空目录字符串');
  }
  const phase = typeof options === 'string'
    ? options
    : options.phase ?? 'all';
  if (!PHASES.has(phase)) {
    throw new Error(`未知校验阶段: ${phase}`);
  }

  const root = resolve(projectRoot);
  const errors = [];
  const warnings = [];
  let indexContext = {
    hasPointArray: false,
    pointById: new Map(),
    orderedIds: [],
    orderedPoints: [],
  };
  let artifacts = null;
  let animationResult = { animationTypes: [] };
  let outputIsSelfContained = true;

  try {
    const symbolicLinks = listSymbolicLinks(root);
    for (const path of symbolicLinks) {
      errors.push(
        path === root
          ? `output root 本身不得是符号链接: ${root}`
          : `output root 必须自包含，不允许符号链接: ${path}`,
      );
    }
    outputIsSelfContained = symbolicLinks.length === 0;
  } catch (error) {
    errors.push(error.message);
    outputIsSelfContained = false;
  }

  if (
    outputIsSelfContained
    && (phase === 'index' || phase === 'points' || phase === 'all')
  ) {
    indexContext = validateIndexStage(root, errors);
  }
  if (
    outputIsSelfContained
    && (phase === 'points' || phase === 'all')
  ) {
    const expectedIds = indexContext.hasPointArray
      ? new Set(indexContext.pointById.keys())
      : null;
    artifacts = loadPointAndRequestArtifacts(root, expectedIds, errors);
    validatePointsStage(indexContext, artifacts, errors, {
      requireDraftAnimations: phase === 'points',
    });
  }
  if (
    outputIsSelfContained
    && (phase === 'animations' || phase === 'all')
  ) {
    if (artifacts === null) {
      artifacts = loadPointAndRequestArtifacts(root, null, errors);
    }
    animationResult = validateAnimationsStage(root, artifacts, errors);
  }
  if (
    outputIsSelfContained
    && phase === 'all'
    && artifacts !== null
  ) {
    validateDeepIndexSync(indexContext, artifacts, errors);
  }

  const uniqueErrors = [...new Set(errors)];
  const uniqueWarnings = [...new Set(warnings)];
  const validatedPointIds = artifacts === null
    ? [...new Set(indexContext.orderedIds)].filter((id) => (
      indexContext.pointById.has(id)
    ))
    : (
      indexContext.hasPointArray
        ? [...new Set(indexContext.orderedIds)].filter((id) => (
          artifacts.pointById.has(id)
        ))
        : sortStrings(artifacts.pointById.keys())
    );

  return {
    root,
    phase,
    errors: uniqueErrors,
    warnings: uniqueWarnings,
    validatedPointIds,
    animationTypes: animationResult.animationTypes,
    counts: {
      indexPoints: indexContext.pointById.size,
      pointFiles: artifacts?.pointArtifacts.length ?? 0,
      animationRequests: artifacts?.requestArtifacts.length ?? 0,
      animations: animationResult.animationTypes.length,
    },
  };
}

export function parseArgs(argv) {
  let root = null;
  let phase = 'all';

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
    } else if (argument === '--phase') {
      phase = argv[index + 1];
      if (!phase || phase.startsWith('--')) {
        throw new Error('--phase 需要阶段参数');
      }
      index += 1;
    } else if (argument.startsWith('--phase=')) {
      phase = argument.slice('--phase='.length);
    } else if (argument === '--help' || argument === '-h') {
      return { help: true, root, phase };
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }

  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('--root 为必填目录');
  }
  if (!PHASES.has(phase)) {
    throw new Error('--phase 只能是 index/points/animations/all');
  }
  return { help: false, root, phase };
}

function printUsage() {
  console.log(`用法:
  node scripts/validate_output.mjs --root <output-root> [--phase index|points|animations|all]

默认执行 all。points 包含 index 阶段校验；all 还要求 index 六项元数据
与详情深度一致。`);
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

  let result;
  try {
    result = validateProject(options.root, { phase: options.phase });
  } catch (error) {
    console.error(`校验无法执行: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  for (const warning of result.warnings) {
    console.warn(`警告: ${warning}`);
  }
  if (result.errors.length > 0) {
    console.error(`校验失败（${result.errors.length} 项）:`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  const animationSummary = result.animationTypes.length > 0
    ? result.animationTypes.join(', ')
    : 'none';
  console.log(
    `校验通过：阶段 ${result.phase}；${result.validatedPointIds.length} 个知识点；动画类型 ${animationSummary}`,
  );
}

if (isDirectRun(import.meta.url)) main();
