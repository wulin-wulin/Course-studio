#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeAtomicWriteJson } from '../../../candidate-knowledge-point-generator/scripts/lib/safe-write.mjs';

const LEGACY_GRAPH_SCHEMA = 'clustered-graph/2.0';
const THIN_GRAPH_SCHEMA = 'clustered-graph/3.0';
const TEXTBOOK_CONTENT_SCHEMA = 'textbook-content/2.0';
const RELATION_FIELDS = ['clusterIds', 'role', 'related'];
const THIN_POINT_FIELDS = [
  'id',
  'title',
  'origin',
  'clusterIds',
  'role',
  'prerequisites',
  'related',
];

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

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function edgeKey(dependentId, prerequisiteId) {
  return `${dependentId}\u0000${prerequisiteId}`;
}

function edgeParts(key) {
  return key.split('\u0000');
}

function prerequisiteEdges(points) {
  const edges = new Set();
  for (const point of points) {
    for (const prerequisite of Array.isArray(point?.prerequisites)
      ? point.prerequisites
      : []) {
      if (typeof point?.id === 'string' && typeof prerequisite === 'string') {
        edges.add(edgeKey(point.id, prerequisite));
      }
    }
  }
  return edges;
}

/**
 * Keep prerequisite audit entries deterministic and replayable.
 *
 * The canonical edge direction is `from=dependent, to=prerequisite`, matching
 * point.prerequisites and the backend review contract. Model drafts commonly
 * write the visual direction (prerequisite -> dependent) or list every final
 * edge instead of only the delta. The assembler has both canonical and target
 * points, so it can normalize those harmless presentation mistakes without
 * asking the agent to hand-maintain an audit replay.
 */
function normalizePrerequisiteAudit(sourcePoints, targetPoints, generation) {
  const sourceEdges = prerequisiteEdges(sourcePoints);
  const targetEdges = prerequisiteEdges(targetPoints);
  const changes = new Map();
  for (const key of targetEdges) {
    if (!sourceEdges.has(key)) changes.set(`add\u0000${key}`, 'add');
  }
  for (const key of sourceEdges) {
    if (!targetEdges.has(key)) changes.set(`remove\u0000${key}`, 'remove');
  }

  const rawAudit = generation?.refinedPrerequisiteEdges;
  if (rawAudit !== undefined && !Array.isArray(rawAudit)) {
    throw new Error('generation.refinedPrerequisiteEdges 必须是数组');
  }

  const reasons = new Map();
  for (const [index, entry] of (rawAudit ?? []).entries()) {
    if (
      !isRecord(entry)
      || !['op', 'from', 'to', 'reason'].every((key) => hasOwn(entry, key))
    ) {
      throw new Error(`generation.refinedPrerequisiteEdges[${index}] 必须包含 op/from/to/reason`);
    }
    const op = String(entry.op ?? '').trim();
    const from = String(entry.from ?? '').trim();
    const to = String(entry.to ?? '').trim();
    const reason = String(entry.reason ?? '').trim();
    if (!['add', 'remove'].includes(op) || !from || !to || !reason) {
      throw new Error(`generation.refinedPrerequisiteEdges[${index}] 的 op/from/to/reason 无效`);
    }

    const direct = `${op}\u0000${edgeKey(from, to)}`;
    const reversed = `${op}\u0000${edgeKey(to, from)}`;
    const canonical = changes.has(direct)
      ? direct
      : (changes.has(reversed) ? reversed : null);
    // Stale entries are usually caused by a model listing all final edges.
    // They do not describe a change and must not poison replay validation.
    if (canonical === null) continue;
    // Treat repeated direct/reversed entries as one audit item. The graph
    // delta is authoritative; keeping the first non-empty reason makes the
    // result deterministic while avoiding a needless retry loop.
    if (!reasons.has(canonical)) reasons.set(canonical, reason);
  }

  return [...changes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([changeKey, op]) => {
      const edge = changeKey.slice(`${op}\u0000`.length);
      const [from, to] = edgeParts(edge);
      return {
        op,
        from,
        to,
        reason: reasons.get(changeKey)
          || (op === 'add'
            ? '图谱草稿相对 canonical prerequisites 新增，待 G6 审核确认'
            : '图谱草稿相对 canonical prerequisites 移除，待 G6 审核确认'),
      };
    });
}

function normalizeBrokenCycleEdges(sourcePoints, targetPoints, generation) {
  const sourceEdges = prerequisiteEdges(sourcePoints);
  const targetEdges = prerequisiteEdges(targetPoints);
  const removedEdges = new Set(
    [...sourceEdges].filter((key) => !targetEdges.has(key)),
  );
  const rawBroken = generation?.brokenCycleEdges;
  if (rawBroken !== undefined && !Array.isArray(rawBroken)) {
    throw new Error('generation.brokenCycleEdges 必须是数组');
  }

  const seen = new Set();
  const normalized = [];
  for (const [index, entry] of (rawBroken ?? []).entries()) {
    if (
      !isRecord(entry)
      || !['from', 'to'].every((key) => hasOwn(entry, key))
    ) {
      throw new Error(`generation.brokenCycleEdges[${index}] 必须包含 from/to/reason`);
    }
    const from = String(entry.from ?? '').trim();
    const to = String(entry.to ?? '').trim();
    if (!from || !to) {
      throw new Error(`generation.brokenCycleEdges[${index}] 的 from/to 无效`);
    }

    const direct = edgeKey(from, to);
    const reversed = edgeKey(to, from);
    const canonical = removedEdges.has(direct)
      ? direct
      : (removedEdges.has(reversed) ? reversed : null);
    // A stale cycle record does not describe a removed edge in the target
    // graph and would otherwise fail broken-edge-not-refined.
    if (canonical === null || seen.has(canonical)) continue;
    seen.add(canonical);
    const [canonicalFrom, canonicalTo] = edgeParts(canonical);
    normalized.push({
      from: canonicalFrom,
      to: canonicalTo,
      reason: String(entry.reason ?? '').trim()
        || '图谱草稿为破环移除该 prerequisite，待 G6 审核确认',
    });
  }

  return normalized.sort((left, right) => (
    edgeKey(left.from, left.to).localeCompare(edgeKey(right.from, right.to))
  ));
}

function loadJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取或解析${label} ${file}: ${error.message}`);
  }
}

function assertUniqueIds(records, label) {
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    if (!isRecord(record) || typeof record.id !== 'string' || record.id === '') {
      throw new Error(`${label}[${index}] 缺少字符串 id`);
    }
    if (seen.has(record.id)) throw new Error(`${label} 中 id 重复: ${record.id}`);
    seen.add(record.id);
  }
  return seen;
}

/**
 * Assemble graph point objects from immutable upstream point files plus a
 * relation overlay. Immutable handoff fields always come from upstream; any
 * model-authored copies are discarded so summarisation cannot corrupt them.
 */
export function assembleGraphPoints(contentRootInput, graphFileInput, { write = true } = {}) {
  const contentRoot = path.resolve(contentRootInput);
  const graphFile = path.resolve(graphFileInput);
  const index = loadJson(path.join(contentRoot, 'src/data/index.json'), '课程索引');
  const manifest = loadJson(
    path.join(contentRoot, 'generation/manifest.json'),
    '生成清单',
  );
  const graph = loadJson(graphFile, '聚类图');

  if (!Array.isArray(index.points)) throw new Error('课程索引 points 必须是数组');
  if (typeof index.courseId !== 'string' || index.courseId === '') {
    throw new Error('课程索引 courseId 必须是非空字符串');
  }
  if (!isRecord(manifest.subject)) throw new Error('生成清单 subject 必须是对象');
  if (!Array.isArray(graph.points)) throw new Error('聚类图 points 必须是数组');
  if (!Array.isArray(graph.clusters)) throw new Error('聚类图 clusters 必须是数组');
  if (!isRecord(graph.generation)) throw new Error('聚类图 generation 必须是对象');
  if (![LEGACY_GRAPH_SCHEMA, THIN_GRAPH_SCHEMA].includes(graph.schema_version)) {
    throw new Error(
      `聚类图 schema_version 必须是 ${LEGACY_GRAPH_SCHEMA} 或 ${THIN_GRAPH_SCHEMA}`,
    );
  }
  const usesThinGraph = graph.schema_version === THIN_GRAPH_SCHEMA;
  if (
    usesThinGraph
    && manifest.generation?.contentContract !== TEXTBOOK_CONTENT_SCHEMA
  ) {
    throw new Error(
      `${THIN_GRAPH_SCHEMA} 只用于 ${TEXTBOOK_CONTENT_SCHEMA} 内容包`,
    );
  }

  const indexIds = assertUniqueIds(index.points, 'index.points');
  const overlayIds = assertUniqueIds(graph.points, 'graph.points');
  const missing = [...indexIds].filter((id) => !overlayIds.has(id));
  const extra = [...overlayIds].filter((id) => !indexIds.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `图关系草稿必须与 index 保持相同点集；缺少: ${missing.join(', ') || '(无)'}；`
      + `多出: ${extra.join(', ') || '(无)'}`,
    );
  }

  const sourcePoints = index.points.map(({ id }) => {
    const point = loadJson(
      path.join(contentRoot, 'src/data/points', `${id}.json`),
      `知识点 ${id}`,
    );
    if (!isRecord(point) || point.id !== id) {
      throw new Error(`知识点文件 ${id}.json 的 id 与 index 不一致`);
    }
    return point;
  });
  const overlayById = new Map(graph.points.map((point) => [point.id, point]));
  const problems = [];
  const restoredContentFields = [];

  const assembledPoints = sourcePoints.map((source) => {
    const overlay = overlayById.get(source.id);
    const allowedKeys = usesThinGraph
      ? new Set(THIN_POINT_FIELDS)
      : new Set([...Object.keys(source), ...RELATION_FIELDS]);
    const unknownKeys = Object.keys(overlay).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      problems.push(`${source.id} 含契约外字段: ${unknownKeys.join(', ')}`);
    }

    for (const key of RELATION_FIELDS) {
      if (!hasOwn(overlay, key)) problems.push(`${source.id} 缺少关系字段 ${key}`);
    }

    for (const key of usesThinGraph ? ['title', 'origin'] : Object.keys(source)) {
      if (key === 'prerequisites' || !hasOwn(overlay, key)) continue;
      if (!equal(source[key], overlay[key])) restoredContentFields.push(`${source.id}.${key}`);
    }

    if (usesThinGraph) {
      if (typeof source.title !== 'string' || source.title.trim() === '') {
        problems.push(`${source.id} 的 canonical point 缺少 title`);
      }
      if (!['textbook', 'llm-extension', 'user'].includes(source.origin)) {
        problems.push(`${source.id} 的 canonical point 缺少合法 origin`);
      }
      return {
        id: source.id,
        title: source.title,
        origin: source.origin,
        clusterIds: overlay.clusterIds,
        role: overlay.role,
        prerequisites: hasOwn(overlay, 'prerequisites')
          ? overlay.prerequisites
          : source.prerequisites,
        related: overlay.related,
      };
    }

    const assembled = { ...source };
    if (hasOwn(overlay, 'prerequisites')) assembled.prerequisites = overlay.prerequisites;
    for (const key of RELATION_FIELDS) assembled[key] = overlay[key];
    return assembled;
  });

  if (problems.length > 0) {
    throw new Error(
      `无法机械装配 clustered-graph points：\n- ${problems.join('\n- ')}\n`
      + (usesThinGraph
        ? `图草稿只允许 ${THIN_POINT_FIELDS.join('/')}；title/origin 从 canonical point 恢复。`
        : '只在图草稿中填写 id/prerequisites/clusterIds/role/related；正文和 subject 由本脚本从上游补齐。'),
    );
  }

  const assembledGraph = {
    ...graph,
    subject: manifest.subject,
    generation: {
      ...graph.generation,
      sourceCourseId: index.courseId,
      pointCount: assembledPoints.length,
      clusterCount: graph.clusters.length,
      refinedPrerequisiteEdges: normalizePrerequisiteAudit(
        sourcePoints,
        assembledPoints,
        graph.generation,
      ),
      brokenCycleEdges: normalizeBrokenCycleEdges(
        sourcePoints,
        assembledPoints,
        graph.generation,
      ),
    },
    points: assembledPoints,
  };
  const changed = !equal(graph, assembledGraph);
  if (write && changed) {
    safeAtomicWriteJson(path.dirname(graphFile), graphFile, assembledGraph);
  }

  return {
    ok: true,
    changed,
    graphFile,
    points: assembledPoints.length,
    clusters: graph.clusters.length,
    restoredContentFields: restoredContentFields.length,
    restoredSubject: !equal(graph.subject, manifest.subject),
    schemaVersion: graph.schema_version,
    thinGraph: usesThinGraph,
  };
}

function parseArgs(argv) {
  const options = { check: false, asJson: false, files: [] };
  for (const argument of argv) {
    if (argument === '--check') options.check = true;
    else if (argument === '--json') options.asJson = true;
    else if (argument.startsWith('--')) throw new Error(`未知参数: ${argument}`);
    else options.files.push(argument);
  }
  if (options.files.length !== 2) {
    throw new Error(
      '用法: node assemble-graph-points.mjs <course-content-root> <clustered-graph.json> [--check] [--json]',
    );
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const result = assembleGraphPoints(options.files[0], options.files[1], {
      write: !options.check,
    });
    const checked = options.check && result.changed
      ? {
        ...result,
        ok: false,
        message: result.thinGraph
          ? 'graph.points 尚未机械规范化为薄关系点，请先不带 --check 运行本命令'
          : 'graph.points 尚未由上游完整对象机械装配，请先不带 --check 运行本命令',
      }
      : result;
    if (options.asJson) console.log(JSON.stringify(checked, null, 2));
    else if (!checked.ok) console.error(`❌ ${checked.message}`);
    else {
      console.log(
        `✅ 图 points ${result.changed ? '已机械装配' : (result.thinGraph ? '已是规范薄关系点' : '已是完整对象')}：`
        + `${result.points} 个知识点，${result.clusters} 个簇，`
        + `恢复 ${result.restoredContentFields} 个被改写正文。`,
      );
    }
    process.exitCode = checked.ok ? 0 : 1;
  } catch (error) {
    const failure = { ok: false, message: error.message };
    if (options?.asJson) console.log(JSON.stringify(failure, null, 2));
    else console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
