#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeAtomicWriteJson } from '../../../candidate-knowledge-point-generator/scripts/lib/safe-write.mjs';

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

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
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
    const allowedKeys = new Set([...Object.keys(source), ...RELATION_FIELDS]);
    const unknownKeys = Object.keys(overlay).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      problems.push(`${source.id} 含契约外字段: ${unknownKeys.join(', ')}`);
    }

    for (const key of RELATION_FIELDS) {
      if (!hasOwn(overlay, key)) problems.push(`${source.id} 缺少关系字段 ${key}`);
    }

    for (const key of Object.keys(source)) {
      if (key === 'prerequisites' || !hasOwn(overlay, key)) continue;
      if (!equal(source[key], overlay[key])) {
        restoredContentFields.push(`${source.id}.${key}`);
      }
    }

    const assembled = { ...source };
    if (hasOwn(overlay, 'prerequisites')) {
      assembled.prerequisites = overlay.prerequisites;
    }
    for (const key of RELATION_FIELDS) assembled[key] = overlay[key];
    return assembled;
  });

  if (problems.length > 0) {
    throw new Error(
      `无法机械装配 clustered-graph points：\n- ${problems.join('\n- ')}\n`
      + '只在图草稿中填写 id/prerequisites/clusterIds/role/related；正文和 subject 由本脚本从上游补齐。',
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
        message: 'graph.points 尚未由上游完整对象机械装配，请先不带 --check 运行本命令',
      }
      : result;
    if (options.asJson) console.log(JSON.stringify(checked, null, 2));
    else if (!checked.ok) console.error(`❌ ${checked.message}`);
    else {
      console.log(
        `✅ 图 points ${result.changed ? '已机械装配' : '已是完整对象'}：`
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
