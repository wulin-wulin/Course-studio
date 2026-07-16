import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function unicodeLength(value) {
  return typeof value === 'string' ? [...value].length : 0;
}

export function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sortStrings(values) {
  return [...values].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

export function listSymbolicLinks(projectRoot) {
  const root = resolve(projectRoot);
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw new Error(`无法检查 output root: ${root}: ${error.message}`);
  }
  if (rootStat.isSymbolicLink()) return [root];
  if (!rootStat.isDirectory()) {
    throw new Error(`output root 必须是目录: ${root}`);
  }

  const symbolicLinks = [];
  function visit(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`无法扫描 output root: ${directory}: ${error.message}`);
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        symbolicLinks.push(path);
      } else if (entry.isDirectory()) {
        visit(path);
      }
    }
  }

  visit(root);
  return sortStrings(symbolicLinks);
}

export function assertNoSymbolicLinks(projectRoot) {
  const root = resolve(projectRoot);
  const symbolicLinks = listSymbolicLinks(projectRoot);
  if (symbolicLinks.includes(root)) {
    throw new Error(`output root 本身不得是符号链接: ${root}`);
  }
  if (symbolicLinks.length > 0) {
    throw new Error(
      `output root 必须自包含，不允许符号链接: ${symbolicLinks.join(', ')}`,
    );
  }
  return root;
}

export function readJsonFile(path) {
  if (!existsSync(path)) throw new Error(`缺少文件: ${path}`);

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`JSON 无法解析: ${path}: ${error.message}`);
  }
}

export function readJsonForValidation(path, errors) {
  if (!existsSync(path)) {
    errors.push(`缺少文件: ${path}`);
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`JSON 无法解析: ${path}: ${error.message}`);
    return null;
  }
}

export function listJsonFiles(directory) {
  if (!existsSync(directory)) throw new Error(`缺少目录: ${directory}`);

  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort((left, right) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      });
  } catch (error) {
    throw new Error(`无法读取目录: ${directory}: ${error.message}`);
  }
}

export function listJsonArtifacts(directory, errors) {
  if (!existsSync(directory)) {
    errors.push(`缺少目录: ${directory}`);
    return [];
  }

  let filenames;
  try {
    filenames = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort((left, right) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      });
  } catch (error) {
    errors.push(`无法读取目录: ${directory}: ${error.message}`);
    return [];
  }

  return filenames.map((filename) => {
    const path = join(directory, filename);
    return {
      filename,
      fileId: basename(filename, '.json'),
      path,
      value: readJsonForValidation(path, errors),
    };
  });
}

export function writeTextFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

export function writeJsonFile(path, value) {
  writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function formatErrors(title, errors) {
  const uniqueErrors = [...new Set(errors)];
  return `${title}（${uniqueErrors.length} 项）:\n${uniqueErrors
    .map((error) => `- ${error}`)
    .join('\n')}`;
}

export function isDirectRun(metaUrl, argvEntry = process.argv[1]) {
  return Boolean(
    argvEntry
    && fileURLToPath(metaUrl) === resolve(argvEntry),
  );
}
