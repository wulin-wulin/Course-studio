#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isDirectRun,
  isRecord,
  listSymbolicLinks,
  sortStrings,
} from './lib/common.mjs';
import {
  TEXTBOOK_CONTENT_SCHEMA,
  isTextbookContentPoint,
} from './lib/contracts.mjs';
import {
  safeWriteTransaction,
  serializeJson,
} from './lib/safe-write.mjs';
import {
  buildSourceSpanRefMap,
  collectUnexpandedSourceSpanRefs,
  forEachBlockSourceSpans,
} from './lib/source-span-refs.mjs';

const VALIDATOR = join(
  dirname(fileURLToPath(import.meta.url)),
  'validate_output.mjs',
);

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function listPointFiles(pointsRoot) {
  let entries;
  try {
    if (!lstatSync(pointsRoot).isDirectory()) return [];
    entries = readdirSync(pointsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return sortStrings(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name),
  );
}

// 把 worker 写入的 sourceSpans ref 机械替换为 manifest.pointEvidence 中可信 span 的深拷贝。
// 只处理已开始且能解析的教材 v2 详情；任一未知 ref 时整个文件保持原样，记入 unknownRefPointIds。
// 未知 ref 的逐项定位由草稿校验器报告（它同样按 lib/source-span-refs 的规则比对），这里不重复；
// errors 只收集校验器看不出的展开阻断原因。
export function materializePointSourceSpans(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error('projectRoot 必须是非空目录字符串');
  }
  const root = resolve(projectRoot);
  const symbolicLinks = listSymbolicLinks(root);
  if (symbolicLinks.length > 0) {
    throw new Error(
      `output root 必须自包含，不允许符号链接: ${symbolicLinks.join(', ')}`,
    );
  }

  const manifest = readJsonOrNull(join(root, 'generation/manifest.json'));
  if (
    !isRecord(manifest?.generation)
    || manifest.generation.evidenceMode !== 'textbook-grounded'
    || manifest.generation.contentContract !== TEXTBOOK_CONTENT_SCHEMA
  ) {
    return {
      applied: false,
      expandedPointIds: [],
      expandedRefs: 0,
      unknownRefPointIds: [],
      errors: [],
    };
  }

  const evidenceById = new Map(
    (Array.isArray(manifest.pointEvidence) ? manifest.pointEvidence : [])
      .filter((evidence) => isRecord(evidence) && typeof evidence.pointId === 'string')
      .map((evidence) => [evidence.pointId, evidence]),
  );
  const pointsRoot = join(root, 'src/data/points');
  const writes = [];
  const expandedPointIds = [];
  const unknownRefPointIds = [];
  const errors = [];
  let expandedRefs = 0;

  for (const filename of listPointFiles(pointsRoot)) {
    const point = readJsonOrNull(join(pointsRoot, filename));
    if (!isRecord(point) || collectUnexpandedSourceSpanRefs(point).length === 0) {
      continue;
    }
    const pointId = basename(filename, '.json');
    const label = `src/data/points/${filename}`;
    if (!isTextbookContentPoint(point)) {
      errors.push(
        `${label} 的 content.schema_version 不是 ${TEXTBOOK_CONTENT_SCHEMA}，`
        + `不能展开其中的 sourceSpans ref；须先把 content.schema_version 改为 ${TEXTBOOK_CONTENT_SCHEMA}，该文件未修改`,
      );
      continue;
    }
    const evidence = evidenceById.get(pointId);
    if (!isRecord(evidence)) {
      errors.push(`${label} 没有对应的 manifest.pointEvidence，无法展开 sourceSpans ref；该文件未修改`);
      continue;
    }
    const refErrors = [];
    const trustedByRef = buildSourceSpanRefMap(
      evidence.sourceSpans,
      `generation/manifest.json pointEvidence(${pointId}).sourceSpans`,
      refErrors,
    );
    if (refErrors.length > 0) {
      errors.push(...refErrors.map((error) => `${error}；${label} 未修改`));
      continue;
    }

    const expanded = structuredClone(point);
    let hasUnknownRef = false;
    let pointRefs = 0;
    forEachBlockSourceSpans(expanded, (spans) => {
      spans.forEach((span, spanIndex) => {
        if (typeof span !== 'string') return;
        const trusted = trustedByRef.get(span);
        if (trusted === undefined) {
          hasUnknownRef = true;
          return;
        }
        spans[spanIndex] = structuredClone(trusted);
        pointRefs += 1;
      });
    });
    if (hasUnknownRef) {
      unknownRefPointIds.push(pointId);
      continue;
    }
    writes.push({
      path: join(pointsRoot, filename),
      contents: serializeJson(expanded),
    });
    expandedPointIds.push(pointId);
    expandedRefs += pointRefs;
  }

  if (writes.length > 0) safeWriteTransaction(root, writes);
  return {
    applied: true,
    expandedPointIds,
    expandedRefs,
    unknownRefPointIds,
    errors,
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
  node scripts/finalize_point_drafts.mjs --root <output-root>

textbook-content/2.0 课程先把详情 blocks 中的 sourceSpans ref 展开为
manifest.pointEvidence 的完整 span，再执行与 --phase point-drafts 相同的草稿校验；
其他课程只做草稿校验。`);
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

  let materialized;
  try {
    materialized = materializePointSourceSpans(options.root);
  } catch (error) {
    console.error(`溯源展开无法执行: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  // 直接复用草稿校验器进程，保证报告与 validate-point-drafts 逐字一致。
  const validation = spawnSync(
    process.execPath,
    [VALIDATOR, '--root', options.root, '--phase', 'point-drafts'],
    { stdio: 'inherit', shell: false },
  );
  if (materialized.applied) {
    const unknown = materialized.unknownRefPointIds.length;
    console.log(
      `溯源展开：写回 ${materialized.expandedPointIds.length} 个知识点，`
      + `展开 ${materialized.expandedRefs} 个 sourceSpans ref`
      + (unknown > 0
        ? `；${unknown} 个知识点含未知 ref 未展开（逐项位置见校验失败列表）`
        : ''),
    );
  } else {
    console.log(`溯源展开：跳过（课程未声明 ${TEXTBOOK_CONTENT_SCHEMA}）`);
  }
  if (materialized.errors.length > 0) {
    console.error(`溯源展开失败（${materialized.errors.length} 项）:`);
    for (const error of materialized.errors) console.error(`- ${error}`);
  }
  if (validation.error) {
    console.error(`草稿校验无法启动: ${validation.error.message}`);
  }
  process.exitCode = (
    validation.status === 0
    && materialized.errors.length === 0
    && materialized.unknownRefPointIds.length === 0
  ) ? 0 : 1;
}

if (isDirectRun(import.meta.url)) main();
