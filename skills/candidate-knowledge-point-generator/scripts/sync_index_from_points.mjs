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
} from './lib/common.mjs';
import {
  ID_PATTERN,
  INDEX_POINT_KEYS,
  checkIndexPoint,
} from './lib/contracts.mjs';
import { safeAtomicWriteJson } from './lib/safe-write.mjs';

const SYNCED_KEYS = [
  'shortSummary',
  'difficulty',
  'importance',
  'keyTerms',
];

function validateIndexShape(index, errors) {
  if (!isRecord(index)) {
    errors.push('src/data/index.json 顶层必须是对象');
    return [];
  }

  const expectedKeys = new Set(['schema_version', 'courseId', 'points']);
  const missing = [...expectedKeys].filter((key) => !(key in index));
  const extra = Object.keys(index).filter((key) => !expectedKeys.has(key));
  if (missing.length > 0) {
    errors.push(`src/data/index.json 缺少字段: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    errors.push(`src/data/index.json 包含未知字段: ${extra.join(', ')}`);
  }
  if (index.schema_version !== 'course-content-index/1.0') {
    errors.push(
      'index.schema_version 必须是 "course-content-index/1.0"',
    );
  }
  if (typeof index.courseId !== 'string' || !ID_PATTERN.test(index.courseId)) {
    errors.push('index.courseId 必须是 ASCII kebab-case');
  }
  if (!Array.isArray(index.points)) {
    errors.push('index.points 必须是数组');
    return [];
  }
  if (index.points.length === 0) {
    errors.push('index.points 不能为空');
  }
  return index.points;
}

function validateIndexItemIdentity(item, indexNumber, errors) {
  const label = `index.points[${indexNumber}]`;
  if (!isRecord(item)) {
    errors.push(`${label} 必须是对象`);
    return;
  }

  const expected = new Set(INDEX_POINT_KEYS);
  const missing = INDEX_POINT_KEYS.filter((key) => !(key in item));
  const extra = Object.keys(item).filter((key) => !expected.has(key));
  if (missing.length > 0) {
    errors.push(`${label} 缺少字段: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    errors.push(`${label} 包含未知字段: ${extra.join(', ')}`);
  }
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) {
    errors.push(`${label}.id 必须是 ASCII kebab-case`);
  }
  if (typeof item.title !== 'string' || item.title.trim() === '') {
    errors.push(`${label}.title 必须是非空字符串`);
  }
}

function indexProjection(point) {
  return Object.fromEntries(
    INDEX_POINT_KEYS.map((key) => [key, point[key]]),
  );
}

function validateEvidenceIdentity(manifest, indexPoints, errors) {
  const label = 'generation/manifest.json.pointEvidence';
  if (!isRecord(manifest)) {
    errors.push('generation/manifest.json 顶层必须是对象');
    return;
  }
  if (!Array.isArray(manifest.pointEvidence)) {
    errors.push(`${label} 必须是数组`);
    return;
  }
  if (manifest.pointEvidence.length !== indexPoints.length) {
    errors.push(
      `${label} 必须与 index.points 等长且同序：${manifest.pointEvidence.length} !== ${indexPoints.length}`,
    );
  }

  indexPoints.forEach((meta, index) => {
    const evidence = manifest.pointEvidence[index];
    const itemLabel = `${label}[${index}]`;
    if (!isRecord(evidence)) {
      errors.push(`${itemLabel} 必须是对象并对应 index.points[${index}]`);
      return;
    }
    if (evidence.pointId !== meta?.id) {
      errors.push(
        `${itemLabel}.pointId 必须与 index.points[${index}].id 同序一致：${JSON.stringify(evidence.pointId)} !== ${JSON.stringify(meta?.id)}`,
      );
    }
    if (evidence.title !== meta?.title) {
      errors.push(
        `${itemLabel}.title 必须与 index.points[${index}].title 同序一致：${JSON.stringify(evidence.title)} !== ${JSON.stringify(meta?.title)}`,
      );
    }
  });
}

export function syncIndexFromPoints(projectRoot, { check = false } = {}) {
  const root = resolve(projectRoot);
  assertNoSymbolicLinks(root);
  const indexPath = join(root, 'src/data/index.json');
  const manifestPath = join(root, 'generation/manifest.json');
  const pointsRoot = join(root, 'src/data/points');
  const index = readJsonFile(indexPath);
  const manifest = readJsonFile(manifestPath);
  const pointFiles = listJsonFiles(pointsRoot);
  const errors = [];
  const indexPoints = validateIndexShape(index, errors);
  validateEvidenceIdentity(manifest, indexPoints, errors);

  const indexById = new Map();
  const titleOwners = new Map();
  indexPoints.forEach((item, indexNumber) => {
    validateIndexItemIdentity(item, indexNumber, errors);
    if (!isRecord(item) || typeof item.id !== 'string') return;
    if (indexById.has(item.id)) {
      errors.push(`index.points 中知识点 ID 重复: ${item.id}`);
    } else {
      indexById.set(item.id, item);
    }
    if (typeof item.title === 'string') {
      const normalized = item.title.trim().toLocaleLowerCase('zh-CN');
      if (titleOwners.has(normalized)) {
        errors.push(
          `index.points 中知识点标题重复: ${titleOwners.get(normalized)} 与 ${item.id}`,
        );
      } else {
        titleOwners.set(normalized, item.id);
      }
    }
  });

  const pointsByFileId = new Map();
  for (const filename of pointFiles) {
    const fileId = basename(filename, '.json');
    const path = join(pointsRoot, filename);
    const point = readJsonFile(path);
    const label = `src/data/points/${filename}`;
    if (!isRecord(point)) {
      errors.push(`${label} 顶层必须是对象`);
      continue;
    }
    if (point.id !== fileId) {
      errors.push(
        `${label} 内部 id 必须与文件名一致，期望 ${JSON.stringify(fileId)}，实际为 ${JSON.stringify(point.id)}`,
      );
    }
    if (pointsByFileId.has(fileId)) {
      errors.push(`points/ 中知识点文件 ID 重复: ${fileId}`);
    } else {
      pointsByFileId.set(fileId, point);
    }
  }

  for (const id of indexById.keys()) {
    if (!pointsByFileId.has(id)) {
      errors.push(`index.json 中的知识点缺少详情文件: ${id}.json`);
    }
  }
  for (const id of pointsByFileId.keys()) {
    if (!indexById.has(id)) {
      errors.push(`详情文件未进入 index.json: ${id}.json`);
    }
  }

  for (const [id, meta] of indexById) {
    const point = pointsByFileId.get(id);
    if (!point) continue;
    if (point.id !== meta.id) {
      errors.push(
        `知识点 ${id} 的 id 已冻结，详情为 ${JSON.stringify(point.id)}`,
      );
    }
    if (point.title !== meta.title) {
      errors.push(
        `知识点 ${id} 的 title 已冻结：index 为 ${JSON.stringify(meta.title)}，详情为 ${JSON.stringify(point.title)}`,
      );
    }
    checkIndexPoint(
      indexProjection(point),
      `points/${id}.json 的索引元数据`,
      errors,
    );
  }

  if (errors.length > 0) {
    throw new Error(formatErrors('索引同步前校验失败', errors));
  }

  const changedFields = [];
  const nextPoints = indexPoints.map((meta) => {
    const point = pointsByFileId.get(meta.id);
    const nextMeta = { ...meta };
    for (const key of SYNCED_KEYS) {
      if (!sameJsonValue(meta[key], point[key])) {
        changedFields.push(`${meta.id}.${key}`);
      }
      nextMeta[key] = point[key];
    }
    return nextMeta;
  });

  if (check && changedFields.length > 0) {
    throw new Error(formatErrors(
      'index.json 尚未与详情同步',
      changedFields.map((field) => `${field} 不一致`),
    ));
  }

  if (!check) {
    safeAtomicWriteJson(root, indexPath, { ...index, points: nextPoints });
  }

  return {
    root,
    pointCount: nextPoints.length,
    changed: changedFields.length > 0,
    changedFields,
    check,
  };
}

export function parseArgs(argv) {
  let root = null;
  let check = false;

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
    } else if (argument === '--check') {
      check = true;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true, root, check };
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }

  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('--root 为必填目录');
  }
  return { help: false, root, check };
}

function printUsage() {
  console.log(`用法:
  node scripts/sync_index_from_points.mjs --root <output-root> [--check]

默认从 points 详情回写 index 的摘要、难度、重要性和关键词。
--check 仅检查 index 是否已经同步，不写入文件。`);
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
    const result = syncIndexFromPoints(options.root, {
      check: options.check,
    });
    if (options.check) {
      console.log(`索引检查通过：${result.pointCount} 个知识点已同步`);
    } else if (result.changed) {
      console.log(
        `索引同步完成：${result.pointCount} 个知识点，更新 ${result.changedFields.length} 个字段`,
      );
    } else {
      console.log(`索引无需更新：${result.pointCount} 个知识点`);
    }
  } catch (error) {
    console.error(`索引同步失败: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
