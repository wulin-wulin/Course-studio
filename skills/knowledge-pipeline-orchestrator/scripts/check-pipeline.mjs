#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateProject } from '../../candidate-knowledge-point-generator/scripts/validate_output.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_CHECKER = path.resolve(
  HERE,
  '../../knowledge-cluster-builder/knowledge-cluster-builder/scripts/check-graph.mjs',
);
const CONTENT_SKILL = path.resolve(HERE, '../../candidate-knowledge-point-generator');
const BUNDLED_CONTENT_SKILL = path.resolve(
  HERE,
  '../../knowledge-cluster-builder/candidate-knowledge-point-generator',
);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ROLES = new Set(['trunk', 'branch', 'leaf']);
const RELATION_FIELDS = ['clusterIds', 'role', 'related'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function loadJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取或解析 ${file}: ${error.message}`);
  }
}

function snapshotDirectory(root, relative = '', snapshot = new Map()) {
  const directory = path.join(root, relative);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      snapshotDirectory(root, nextRelative, snapshot);
    } else if (entry.isFile()) {
      snapshot.set(nextRelative, readFileSync(path.join(root, nextRelative)));
    } else {
      snapshot.set(nextRelative, null);
    }
  }
  return snapshot;
}

function compareContentSkillCopies() {
  if (
    !existsSync(CONTENT_SKILL)
    || !existsSync(BUNDLED_CONTENT_SKILL)
    || !statSync(CONTENT_SKILL).isDirectory()
    || !statSync(BUNDLED_CONTENT_SKILL).isDirectory()
  ) return [];

  const canonical = snapshotDirectory(CONTENT_SKILL);
  const bundled = snapshotDirectory(BUNDLED_CONTENT_SKILL);
  const files = new Set([...canonical.keys(), ...bundled.keys()]);
  const differences = [];
  for (const file of [...files].sort()) {
    const left = canonical.get(file);
    const right = bundled.get(file);
    if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || !left.equals(right)) {
      differences.push(file);
    }
  }
  return differences;
}

function detectLegacyInputs(contentRoot, graphFile) {
  const candidates = [];
  const resolvedContent = path.resolve(contentRoot);
  if (existsSync(resolvedContent)) {
    if (statSync(resolvedContent).isFile()) {
      candidates.push(resolvedContent);
    } else {
      candidates.push(
        path.join(resolvedContent, 'candidate-points.json'),
        path.join(resolvedContent, 'clustered-graph.json'),
      );
    }
  }
  if (graphFile) candidates.push(path.resolve(graphFile));

  const legacy = [];
  for (const file of new Set(candidates)) {
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    try {
      const version = loadJson(file)?.schema_version;
      if (version === 'candidate-points/1.0' || version === 'clustered-graph/1.0') {
        legacy.push({ file, schemaVersion: version });
      }
    } catch {}
  }
  return legacy;
}

function add(findings, severity, stage, code, message, detail = {}) {
  findings.push({ severity, stage, code, message, ...detail });
}

function checkShape(
  value,
  required,
  optional,
  findings,
  stage,
  code,
  label,
) {
  if (!isRecord(value)) {
    add(findings, 'error', stage, code, `${label} 必须是对象`);
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0) {
    add(
      findings,
      'error',
      stage,
      code,
      `${label} 缺少字段: ${missing.join(', ')}`,
    );
  }
  if (extra.length > 0) {
    add(
      findings,
      'error',
      stage,
      code,
      `${label} 包含未知字段: ${extra.join(', ')}`,
    );
  }
  return missing.length === 0 && extra.length === 0;
}

function checkString(value, findings, stage, code, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    add(findings, 'error', stage, code, `${label} 必须是非空字符串`);
    return false;
  }
  return true;
}

function checkUniqueStrings(value, findings, stage, code, label, { min = 0 } = {}) {
  if (!Array.isArray(value)) {
    add(findings, 'error', stage, code, `${label} 必须是数组`);
    return false;
  }
  if (value.length < min) {
    add(findings, 'error', stage, code, `${label} 至少需要 ${min} 项`);
  }
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    add(findings, 'error', stage, code, `${label} 只能包含非空字符串`);
  }
  if (new Set(value).size !== value.length) {
    add(findings, 'error', stage, code, `${label} 不允许重复项`);
  }
  return true;
}

function edgeKey(from, to) {
  return `${from}\u0000${to}`;
}

function splitEdge(key) {
  return key.split('\u0000');
}

function collectEdges(points) {
  const edges = new Set();
  for (const point of points) {
    for (const prerequisite of Array.isArray(point?.prerequisites)
      ? point.prerequisites
      : []) {
      edges.add(edgeKey(point.id, prerequisite));
    }
  }
  return edges;
}

function validateGraphShape(graph, findings) {
  if (!checkShape(
    graph,
    ['schema_version', 'subject', 'generation', 'clusters', 'points'],
    [],
    findings,
    'graph',
    'bad-top-level-shape',
    'clustered-graph.json',
  )) return;

  if (graph.schema_version !== 'clustered-graph/2.0') {
    add(
      findings,
      'error',
      'graph',
      'bad-schema-version',
      'schema_version 必须为 clustered-graph/2.0',
    );
  }

  const generation = graph.generation;
  if (checkShape(
    generation,
    [
      'generatedAt',
      'sourceCourseId',
      'pointCount',
      'clusterCount',
      'brokenCycleEdges',
      'refinedPrerequisiteEdges',
    ],
    [],
    findings,
    'graph',
    'bad-generation-shape',
    'generation',
  )) {
    if (typeof generation.generatedAt !== 'string' || !DATE.test(generation.generatedAt)) {
      add(findings, 'error', 'graph', 'bad-generated-at', 'generation.generatedAt 必须是 YYYY-MM-DD');
    }
    if (typeof generation.sourceCourseId !== 'string' || !KEBAB.test(generation.sourceCourseId)) {
      add(findings, 'error', 'graph', 'bad-source-course-id', 'generation.sourceCourseId 必须是 kebab-case');
    }
    for (const key of ['pointCount', 'clusterCount']) {
      if (!Number.isInteger(generation[key]) || generation[key] < 0) {
        add(findings, 'error', 'graph', 'bad-count', `generation.${key} 必须是非负整数`);
      }
    }
    for (const key of ['brokenCycleEdges', 'refinedPrerequisiteEdges']) {
      if (!Array.isArray(generation[key])) {
        add(findings, 'error', 'graph', 'audit-not-array', `generation.${key} 必须是数组`);
      }
    }
  }

  if (!Array.isArray(graph.clusters) || graph.clusters.length === 0) {
    add(findings, 'error', 'graph', 'clusters-invalid', 'clusters 必须是非空数组');
  } else {
    const ids = new Set();
    const orders = new Set();
    graph.clusters.forEach((cluster, index) => {
      const label = `clusters[${index}]`;
      const record = isRecord(cluster) ? cluster : {};
      checkShape(
        cluster,
        ['id', 'title', 'subtitle', 'description', 'order'],
        ['accent', 'soft', 'dark'],
        findings,
        'graph',
        'bad-cluster-shape',
        label,
      );
      if (typeof record.id !== 'string' || !KEBAB.test(record.id)) {
        add(findings, 'error', 'graph', 'bad-cluster-id', `${label}.id 必须是 kebab-case`);
      } else if (ids.has(record.id)) {
        add(findings, 'error', 'graph', 'duplicate-cluster-id', `簇 id 重复: ${record.id}`);
      } else {
        ids.add(record.id);
      }
      for (const key of ['title', 'subtitle', 'description']) {
        checkString(record[key], findings, 'graph', 'bad-cluster-text', `${label}.${key}`);
      }
      if (!Number.isInteger(record.order) || record.order < 0) {
        add(findings, 'error', 'graph', 'bad-cluster-order', `${label}.order 必须是非负整数`);
      } else if (orders.has(record.order)) {
        add(findings, 'warning', 'graph', 'duplicate-cluster-order', `多个簇使用 order=${record.order}`);
      } else {
        orders.add(record.order);
      }
      for (const key of ['accent', 'soft', 'dark']) {
        if (key in record && (typeof record[key] !== 'string' || !HEX.test(record[key]))) {
          add(findings, 'error', 'graph', 'bad-cluster-color', `${label}.${key} 必须是 6 位十六进制颜色`);
        }
      }
    });
  }

  if (!Array.isArray(graph.points)) {
    add(findings, 'error', 'graph', 'points-not-array', 'points 必须是数组');
  }
}

function validateEdgeAudit(sourceEdges, targetEdges, graph, pointIds, findings) {
  const refinements = Array.isArray(graph.generation?.refinedPrerequisiteEdges)
    ? graph.generation.refinedPrerequisiteEdges
    : [];
  const replayed = new Set(sourceEdges);
  const seenOperations = new Set();

  refinements.forEach((entry, index) => {
    const label = `generation.refinedPrerequisiteEdges[${index}]`;
    if (!checkShape(
      entry,
      ['op', 'from', 'to', 'reason'],
      [],
      findings,
      'handoff',
      'bad-refinement-shape',
      label,
    )) return;

    if (!['add', 'remove'].includes(entry.op)) {
      add(findings, 'error', 'handoff', 'bad-refinement-op', `${label}.op 必须是 add 或 remove`);
    }
    for (const key of ['from', 'to']) {
      if (typeof entry[key] !== 'string' || !pointIds.has(entry[key])) {
        add(findings, 'error', 'handoff', 'bad-refinement-ref', `${label}.${key} 必须引用现有点 id`);
      }
    }
    checkString(entry.reason, findings, 'handoff', 'bad-refinement-reason', `${label}.reason`);
    if (entry.from === entry.to) {
      add(findings, 'error', 'handoff', 'self-refinement', `${label} 不得操作自环`);
    }

    const operationKey = `${entry.op}\u0000${edgeKey(entry.from, entry.to)}`;
    seenOperations.add(operationKey);

    const key = edgeKey(entry.from, entry.to);
    if (entry.op === 'add') {
      if (replayed.has(key)) {
        add(findings, 'error', 'handoff', 'refinement-add-existing', `${label} 试图添加已存在的前置边`);
      } else {
        replayed.add(key);
      }
    } else if (entry.op === 'remove') {
      if (!replayed.has(key)) {
        add(findings, 'error', 'handoff', 'refinement-remove-missing', `${label} 试图移除当时不存在的前置边`);
      } else {
        replayed.delete(key);
      }
    }
  });

  if (!equal([...replayed].sort(), [...targetEdges].sort())) {
    const missing = [...targetEdges].filter((key) => !replayed.has(key)).map(splitEdge);
    const extra = [...replayed].filter((key) => !targetEdges.has(key)).map(splitEdge);
    add(
      findings,
      'error',
      'handoff',
      'edge-audit-mismatch',
      '按 refinedPrerequisiteEdges 顺序重放后，无法得到图中的 prerequisites',
      { missingFromAuditReplay: missing, extraFromAuditReplay: extra },
    );
  }

  const broken = Array.isArray(graph.generation?.brokenCycleEdges)
    ? graph.generation.brokenCycleEdges
    : [];
  broken.forEach((entry, index) => {
    const label = `generation.brokenCycleEdges[${index}]`;
    if (!checkShape(
      entry,
      ['from', 'to', 'reason'],
      [],
      findings,
      'handoff',
      'bad-broken-edge-shape',
      label,
    )) return;
    checkString(entry.reason, findings, 'handoff', 'bad-broken-edge-reason', `${label}.reason`);
    const removeKey = `remove\u0000${edgeKey(entry.from, entry.to)}`;
    if (!seenOperations.has(removeKey)) {
      add(
        findings,
        'error',
        'handoff',
        'broken-edge-not-refined',
        `${label} 必须同时有对应的 refinedPrerequisiteEdges remove 记录`,
      );
    }
    if (targetEdges.has(edgeKey(entry.from, entry.to))) {
      add(findings, 'error', 'handoff', 'broken-edge-still-present', `${label} 声称移除的边仍存在于图中`);
    }
  });
}

function validateGraphHandoff(contentRoot, graphFile, findings) {
  let course;
  let index;
  let manifest;
  let graph;
  let sourcePoints;
  try {
    course = loadJson(path.join(contentRoot, 'src/data/course.json'));
    index = loadJson(path.join(contentRoot, 'src/data/index.json'));
    manifest = loadJson(path.join(contentRoot, 'generation/manifest.json'));
    sourcePoints = index.points.map((point) => loadJson(
      path.join(contentRoot, 'src/data/points', `${point.id}.json`),
    ));
    graph = loadJson(graphFile);
  } catch (error) {
    add(findings, 'error', 'handoff', 'read-failed', error.message);
    return {};
  }

  validateGraphShape(graph, findings);
  if (!Array.isArray(graph.points) || !Array.isArray(graph.clusters) || !isRecord(graph.generation)) {
    return {};
  }

  if (!equal(manifest.subject, graph.subject)) {
    add(findings, 'error', 'handoff', 'subject-changed', 'graph.subject 未从 manifest 原样透传');
  }
  if (graph.generation.sourceCourseId !== course.id || course.id !== index.courseId) {
    add(
      findings,
      'error',
      'handoff',
      'course-id-mismatch',
      'course.id、index.courseId 与 graph.generation.sourceCourseId 必须一致',
    );
  }
  if (graph.generation.pointCount !== graph.points.length) {
    add(findings, 'error', 'graph', 'point-count-mismatch', 'generation.pointCount 与 points 长度不等');
  }
  if (graph.generation.clusterCount !== graph.clusters.length) {
    add(findings, 'error', 'graph', 'cluster-count-mismatch', 'generation.clusterCount 与 clusters 长度不等');
  }

  const sourceIds = sourcePoints.map((point) => point.id);
  const targetIds = graph.points.map((point) => point?.id);
  if (!equal(sourceIds, targetIds)) {
    const sourceSet = new Set(sourceIds);
    const targetSet = new Set(targetIds);
    add(
      findings,
      'error',
      'handoff',
      'point-order-or-set-changed',
      'graph.points 必须与 index/points 保持相同点集和顺序',
      {
        missingPoints: sourceIds.filter((id) => !targetSet.has(id)),
        extraPoints: targetIds.filter((id) => !sourceSet.has(id)),
      },
    );
  }

  const targetById = new Map();
  for (const point of graph.points) {
    if (isRecord(point) && typeof point.id === 'string') {
      if (targetById.has(point.id)) {
        add(findings, 'error', 'graph', 'duplicate-point-id', `图中点 id 重复: ${point.id}`);
      }
      targetById.set(point.id, point);
    }
  }

  for (const source of sourcePoints) {
    const target = targetById.get(source.id);
    if (!target) continue;
    const expectedKeys = [...Object.keys(source), ...RELATION_FIELDS].sort();
    const actualKeys = Object.keys(target).sort();
    if (!equal(expectedKeys, actualKeys)) {
      add(
        findings,
        'error',
        'handoff',
        'point-shape-changed',
        `${source.id} 必须只在上游字段之外追加 clusterIds/role/related`,
        { pointId: source.id, expectedKeys, actualKeys },
      );
    }
    for (const key of Object.keys(source)) {
      if (key !== 'prerequisites' && !equal(source[key], target[key])) {
        add(
          findings,
          'error',
          'handoff',
          'content-changed',
          `${source.id}.${key} 未原样透传`,
          { pointId: source.id, field: key },
        );
      }
    }
  }

  const pointIds = new Set(sourceIds);
  const clusterIds = new Set(graph.clusters.map((cluster) => cluster?.id));
  const sourceEdges = collectEdges(sourcePoints);
  const targetEdges = collectEdges(graph.points);
  const dependentCounts = new Map(sourceIds.map((id) => [id, 0]));
  for (const key of targetEdges) {
    const [, prerequisite] = splitEdge(key);
    if (dependentCounts.has(prerequisite)) {
      dependentCounts.set(prerequisite, dependentCounts.get(prerequisite) + 1);
    }
  }

  for (const point of graph.points) {
    if (!isRecord(point) || typeof point.id !== 'string') continue;
    checkUniqueStrings(point.clusterIds, findings, 'relations', 'bad-cluster-ids', `${point.id}.clusterIds`, { min: 1 });
    checkUniqueStrings(point.prerequisites, findings, 'relations', 'bad-prerequisites', `${point.id}.prerequisites`);
    checkUniqueStrings(point.related, findings, 'relations', 'bad-related', `${point.id}.related`);
    if (!ROLES.has(point.role)) {
      add(findings, 'error', 'roles', 'bad-role', `${point.id}.role 必须是 trunk/branch/leaf`);
    }
    for (const clusterId of Array.isArray(point.clusterIds) ? point.clusterIds : []) {
      if (!clusterIds.has(clusterId)) {
        add(findings, 'error', 'relations', 'bad-cluster-ref', `${point.id}.clusterIds 引用不存在的簇 ${clusterId}`);
      }
    }
    for (const relatedId of Array.isArray(point.related) ? point.related : []) {
      if (!pointIds.has(relatedId)) continue;
      if (targetEdges.has(edgeKey(point.id, relatedId)) || targetEdges.has(edgeKey(relatedId, point.id))) {
        add(
          findings,
          'error',
          'relations',
          'relation-type-conflict',
          `${point.id} 与 ${relatedId} 同时存在 related 和 prerequisites`,
          { pointId: point.id, value: relatedId },
        );
      }
      if (!targetById.get(relatedId)?.related?.includes(point.id)) {
        add(
          findings,
          'warning',
          'relations',
          'related-not-symmetric',
          `${point.id} related ${relatedId} 未对称声明`,
        );
      }
    }
    if (point.role === 'leaf' && (dependentCounts.get(point.id) ?? 0) > 0) {
      add(findings, 'error', 'roles', 'leaf-has-dependents', `${point.id} 标为 leaf 但仍被其他点依赖`);
    }
  }

  for (const cluster of graph.clusters) {
    const clusterId = isRecord(cluster) ? cluster.id : undefined;
    if (typeof clusterId !== 'string') continue;
    const primary = graph.points.filter((point) => point?.clusterIds?.[0] === clusterId);
    const anyMembership = graph.points.some((point) => point?.clusterIds?.includes(clusterId));
    if (primary.length > 0 && !primary.some((point) => point.role === 'trunk')) {
      add(findings, 'error', 'roles', 'cluster-without-trunk', `${clusterId} 的主簇成员中没有 trunk`);
    } else if (primary.length === 0 && anyMembership) {
      add(findings, 'warning', 'roles', 'cluster-without-primary', `${clusterId} 只有附加归属，没有主簇成员`);
    } else if (!anyMembership) {
      add(findings, 'warning', 'relations', 'empty-cluster', `${clusterId} 没有任何成员`);
    }
  }

  validateEdgeAudit(sourceEdges, targetEdges, graph, pointIds, findings);

  const graphCheck = spawnSync(
    process.execPath,
    [GRAPH_CHECKER, graphFile, '--json'],
    { encoding: 'utf8' },
  );
  if (graphCheck.status !== 0) {
    let detail = graphCheck.stderr || graphCheck.stdout;
    try {
      detail = JSON.parse(graphCheck.stdout).findings;
    } catch {}
    add(findings, 'error', 'graph', 'check-graph-failed', 'check-graph.mjs 校验失败', { detail });
  }

  return {
    graphPoints: graph.points.length,
    clusters: graph.clusters.length,
    prerequisiteEdges: targetEdges.size,
    multiClusterPoints: graph.points.filter((point) => point?.clusterIds?.length > 1).length,
    refinedEdges: Array.isArray(graph.generation.refinedPrerequisiteEdges)
      ? graph.generation.refinedPrerequisiteEdges.length
      : 0,
    brokenCycleEdges: Array.isArray(graph.generation.brokenCycleEdges)
      ? graph.generation.brokenCycleEdges.length
      : 0,
  };
}

function run(contentRoot, graphFile, phase = 'all') {
  const findings = [];
  const skillDifferences = compareContentSkillCopies();
  if (skillDifferences.length > 0) {
    add(
      findings,
      'error',
      'input',
      'duplicate-skill-drift',
      '两个 candidate-knowledge-point-generator 目录内容不一致，无法确定应使用的契约和脚本',
      { differingFiles: skillDifferences },
    );
    return {
      ok: false,
      phase,
      contentRoot: path.resolve(contentRoot),
      graphFile: graphFile ? path.resolve(graphFile) : null,
      counts: {
        indexPoints: 0,
        pointFiles: 0,
        animationRequests: 0,
        animations: 0,
        errors: 1,
        warnings: 0,
      },
      findings,
    };
  }
  const legacyInputs = detectLegacyInputs(contentRoot, graphFile);
  if (legacyInputs.length > 0) {
    add(
      findings,
      'error',
      'input',
      'legacy-v1-input',
      '检测到 v1 流水线产物，不能作为 v2 resume/validate 输入；请显式迁移或从 G1 生成新的 course-content 包',
      { legacyInputs },
    );
    return {
      ok: false,
      phase,
      contentRoot: path.resolve(contentRoot),
      graphFile: graphFile ? path.resolve(graphFile) : null,
      counts: {
        indexPoints: 0,
        pointFiles: 0,
        animationRequests: 0,
        animations: 0,
        errors: 1,
        warnings: 0,
      },
      findings,
    };
  }
  let content;
  try {
    content = validateProject(contentRoot, { phase });
    for (const message of content.errors) {
      add(findings, 'error', 'content', 'content-invalid', message);
    }
    for (const message of content.warnings) {
      add(findings, 'warning', 'content', 'content-warning', message);
    }
  } catch (error) {
    add(findings, 'error', 'content', 'content-check-failed', error.message);
    content = {
      counts: {},
      animationTypes: [],
      validatedPointIds: [],
    };
  }

  let graphCounts = {};
  if (graphFile) {
    if (phase !== 'all') {
      add(findings, 'error', 'handoff', 'graph-requires-all', '校验 graph 时 --phase 必须是 all');
    } else if (!findings.some((finding) => finding.severity === 'error')) {
      graphCounts = validateGraphHandoff(
        path.resolve(contentRoot),
        path.resolve(graphFile),
        findings,
      );
    }
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    phase,
    contentRoot: path.resolve(contentRoot),
    graphFile: graphFile ? path.resolve(graphFile) : null,
    counts: {
      indexPoints: content.counts?.indexPoints ?? 0,
      pointFiles: content.counts?.pointFiles ?? 0,
      animationRequests: content.counts?.animationRequests ?? 0,
      animations: content.counts?.animations ?? 0,
      ...graphCounts,
      errors: findings.filter((finding) => finding.severity === 'error').length,
      warnings: findings.filter((finding) => finding.severity === 'warning').length,
    },
    findings,
  };
}

async function selfTest() {
  const cleanups = [];
  const t = { after: (cleanup) => cleanups.push(cleanup) };
  const graphDir = mkdtempSync(path.join(tmpdir(), 'pipeline-v2-graph-'));
  try {
    const [{ createCourseFixture }, { buildAnimationRegistry }] = await Promise.all([
      import('../../candidate-knowledge-point-generator/scripts/test-fixture.mjs'),
      import('../../candidate-knowledge-point-generator/scripts/build_animation_registry.mjs'),
    ]);
    const { root } = createCourseFixture(t, { withAnimation: false });
    buildAnimationRegistry(root);

    const manifest = loadJson(path.join(root, 'generation/manifest.json'));
    const index = loadJson(path.join(root, 'src/data/index.json'));
    const points = index.points.map((point) => loadJson(
      path.join(root, 'src/data/points', `${point.id}.json`),
    ));
    const graph = {
      schema_version: 'clustered-graph/2.0',
      subject: manifest.subject,
      generation: {
        generatedAt: '2026-07-16',
        sourceCourseId: index.courseId,
        pointCount: points.length,
        clusterCount: 1,
        brokenCycleEdges: [],
        refinedPrerequisiteEdges: [],
      },
      clusters: [{
        id: 'state-process',
        title: '状态过程',
        subtitle: '从输入状态到终止条件',
        description: '描述状态按规则变化并在明确条件下停止。',
        order: 1,
      }],
      points: points.map((point, indexValue) => ({
        ...point,
        clusterIds: ['state-process'],
        role: indexValue === 0 ? 'trunk' : indexValue === 2 ? 'leaf' : 'branch',
        related: [],
      })),
    };
    const graphFile = path.join(graphDir, 'clustered-graph.json');
    writeFileSync(graphFile, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

    const valid = run(root, graphFile);
    if (!valid.ok) throw new Error(`正例失败: ${JSON.stringify(valid.findings)}`);

    const changed = structuredClone(graph);
    changed.points[0].coreIdea = '被下游擅自改写的内容';
    writeFileSync(graphFile, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
    const contentChanged = run(root, graphFile);
    if (!contentChanged.findings.some((finding) => finding.code === 'content-changed')) {
      throw new Error('未捕获内容字段漂移');
    }

    const unaudited = structuredClone(graph);
    unaudited.points[2].prerequisites.push('input-state');
    writeFileSync(graphFile, `${JSON.stringify(unaudited, null, 2)}\n`, 'utf8');
    const auditFailed = run(root, graphFile);
    if (!auditFailed.findings.some((finding) => finding.code === 'edge-audit-mismatch')) {
      throw new Error('未捕获未经审计的 prerequisite 变化');
    }

    const conflicted = structuredClone(graph);
    conflicted.points[0].related = ['state-transition'];
    conflicted.points[1].related = ['input-state'];
    writeFileSync(graphFile, `${JSON.stringify(conflicted, null, 2)}\n`, 'utf8');
    const relationFailed = run(root, graphFile);
    if (!relationFailed.findings.some((finding) => finding.code === 'relation-type-conflict')) {
      throw new Error('未捕获 related/prerequisites 冲突');
    }

    console.log('自测通过：v2 正例合格，内容漂移、边审计缺失和关系冲突均被拦截。');
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    rmSync(graphDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {
    asJson: false,
    phase: 'all',
    selfTest: false,
    files: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.asJson = true;
    else if (argument === '--self-test') options.selfTest = true;
    else if (argument === '--phase') {
      options.phase = argv[index + 1];
      index += 1;
    } else if (argument.startsWith('--phase=')) {
      options.phase = argument.slice('--phase='.length);
    } else if (argument.startsWith('--')) {
      throw new Error(`未知参数: ${argument}`);
    } else {
      options.files.push(argument);
    }
  }
  if (!['index', 'points', 'animations', 'all'].includes(options.phase)) {
    throw new Error('--phase 只能是 index/points/animations/all');
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  if (options.selfTest) {
    try {
      await selfTest();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }

  if (options.files.length < 1 || options.files.length > 2) {
    console.error('用法: node check-pipeline.mjs <content-root> [clustered-graph.json] [--phase index|points|animations|all] [--json]');
    process.exitCode = 2;
    return;
  }

  const result = run(options.files[0], options.files[1], options.phase);
  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `${result.ok ? '✅' : '❌'} v2 流水线校验${result.ok ? '通过' : '失败'}：`
      + `${result.counts.indexPoints} 个索引点，${result.counts.pointFiles} 个详情，`
      + `${result.counts.animations} 个动画类型，${result.counts.clusters ?? 0} 个簇，`
      + `${result.counts.errors} 个错误，${result.counts.warnings} 个警告。`,
    );
    for (const finding of result.findings) {
      console.log(`  [${finding.severity}] ${finding.stage}/${finding.code}: ${finding.message}`);
    }
  }
  process.exitCode = result.ok ? 0 : 1;
}

await main();
