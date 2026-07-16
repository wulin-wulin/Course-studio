import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function isInside(root, target) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === ''
    || (
      pathFromRoot !== '..'
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    )
  );
}

function resolveSafeRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error('安全写入 root 必须是非空目录字符串');
  }
  const lexicalRoot = resolve(projectRoot);
  const rootStat = lstatOrNull(lexicalRoot);
  if (rootStat === null) throw new Error(`安全写入 root 不存在: ${lexicalRoot}`);

  const canonicalRoot = realpathSync(lexicalRoot);
  const canonicalStat = lstatOrNull(canonicalRoot);
  if (canonicalStat === null || !canonicalStat.isDirectory()) {
    throw new Error(`安全写入 root 必须是目录: ${lexicalRoot}`);
  }
  return { lexicalRoot, canonicalRoot };
}

function resolveSafeTarget(rootInfo, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new Error('安全写入目标必须是非空路径字符串');
  }
  const lexicalTarget = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(rootInfo.lexicalRoot, targetPath);
  if (!isInside(rootInfo.lexicalRoot, lexicalTarget)) {
    throw new Error(`安全写入目标越过 output root: ${targetPath}`);
  }

  const relativeTarget = relative(rootInfo.lexicalRoot, lexicalTarget);
  const canonicalTarget = resolve(rootInfo.canonicalRoot, relativeTarget);
  if (
    canonicalTarget === rootInfo.canonicalRoot
    || !isInside(rootInfo.canonicalRoot, canonicalTarget)
  ) {
    throw new Error(`安全写入目标不在 canonical root 内: ${targetPath}`);
  }
  return canonicalTarget;
}

function ensureSafeDirectoryChain(rootInfo, targetDirectory, createdDirectories) {
  if (!isInside(rootInfo.canonicalRoot, targetDirectory)) {
    throw new Error(`目标父目录不在 canonical root 内: ${targetDirectory}`);
  }

  const parts = relative(rootInfo.canonicalRoot, targetDirectory)
    .split(sep)
    .filter(Boolean);
  let current = rootInfo.canonicalRoot;
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (stat !== null) {
      if (stat.isSymbolicLink()) {
        throw new Error(`拒绝符号链接父目录: ${current}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`目标父路径不是目录: ${current}`);
      }
      continue;
    }

    mkdirSync(current);
    createdDirectories.push(current);
    const createdStat = lstatOrNull(current);
    if (
      createdStat === null
      || createdStat.isSymbolicLink()
      || !createdStat.isDirectory()
    ) {
      throw new Error(`无法安全创建目标父目录: ${current}`);
    }
  }

  const canonicalParent = realpathSync(targetDirectory);
  if (!isInside(rootInfo.canonicalRoot, canonicalParent)) {
    throw new Error(`目标父目录解析后越过 canonical root: ${targetDirectory}`);
  }
}

function inspectSafeTarget(rootInfo, target, createdDirectories) {
  ensureSafeDirectoryChain(rootInfo, dirname(target), createdDirectories);
  const stat = lstatOrNull(target);
  if (stat?.isSymbolicLink()) {
    throw new Error(`拒绝写入符号链接目标: ${target}`);
  }
  if (stat !== null && !stat.isFile()) {
    throw new Error(`安全写入目标不是普通文件: ${target}`);
  }
  return stat;
}

function uniqueSiblingPath(target, purpose) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(
      dirname(target),
      `.${basename(target)}.${purpose}-${randomUUID()}`,
    );
    if (lstatOrNull(candidate) === null) return candidate;
  }
  throw new Error(`无法为安全写入分配临时文件: ${target}`);
}

function fileIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(':');
}

function removeIfPresent(path) {
  const stat = lstatOrNull(path);
  if (stat !== null) unlinkSync(path);
}

function removeCreatedDirectories(createdDirectories) {
  for (const directory of [...createdDirectories].reverse()) {
    try {
      rmdirSync(directory);
    } catch {
      // 目录非空或已由外部使用时保留，避免破坏并发写入。
    }
  }
}

function rollbackPrepared(prepared, createdDirectories) {
  const rollbackErrors = [];
  for (const entry of [...prepared].reverse()) {
    try {
      if (entry.installed) {
        const installedStat = lstatOrNull(entry.target);
        if (
          installedStat === null
          || installedStat.isSymbolicLink()
          || !installedStat.isFile()
          || (
            entry.installedIdentity !== null
            && fileIdentity(installedStat) !== entry.installedIdentity
          )
        ) {
          throw new Error(`已提交目标在回滚前发生变化: ${entry.target}`);
        }
        if (entry.hadOriginal) {
          const backupStat = lstatOrNull(entry.backup);
          if (
            backupStat === null
            || backupStat.isSymbolicLink()
            || !backupStat.isFile()
            || fileIdentity(backupStat) !== entry.backupIdentity
          ) {
            throw new Error(`原文件备份丢失: ${entry.backup}`);
          }
          try {
            renameSync(entry.backup, entry.target);
          } catch {
            removeIfPresent(entry.target);
            renameSync(entry.backup, entry.target);
          }
        } else {
          removeIfPresent(entry.target);
        }
      }
    } catch (error) {
      rollbackErrors.push(`${entry.target}: ${error.message}`);
    }
    for (const [path, wasCreated] of [
      [entry.temporary, entry.temporaryCreated],
      [entry.backup, entry.backupCreated],
    ]) {
      if (!path || !wasCreated) continue;
      try {
        removeIfPresent(path);
      } catch (error) {
        rollbackErrors.push(`${path}: ${error.message}`);
      }
    }
  }
  removeCreatedDirectories(createdDirectories);
  return rollbackErrors;
}

export function serializeJson(value) {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string') {
    throw new Error('安全 JSON 写入值无法序列化');
  }
  return `${serialized}\n`;
}

export function safeWriteTransaction(projectRoot, writes) {
  if (!Array.isArray(writes) || writes.length === 0) {
    throw new Error('安全写入事务至少需要一个目标');
  }

  const rootInfo = resolveSafeRoot(projectRoot);
  const createdDirectories = [];
  const prepared = [];
  const targetSet = new Set();

  try {
    for (const write of writes) {
      if (
        write === null
        || typeof write !== 'object'
        || !('path' in write)
        || !(
          typeof write.contents === 'string'
          || Buffer.isBuffer(write.contents)
        )
      ) {
        throw new Error('安全写入项必须包含 path 和字符串或 Buffer contents');
      }

      const target = resolveSafeTarget(rootInfo, write.path);
      if (targetSet.has(target)) {
        throw new Error(`安全写入事务包含重复目标: ${target}`);
      }
      targetSet.add(target);

      const originalStat = inspectSafeTarget(
        rootInfo,
        target,
        createdDirectories,
      );
      const temporary = uniqueSiblingPath(target, 'new');
      const backup = originalStat === null
        ? null
        : uniqueSiblingPath(target, 'backup');
      const mode = originalStat === null ? 0o666 : originalStat.mode & 0o777;
      const preparedEntry = {
        target,
        temporary,
        backup,
        hadOriginal: originalStat !== null,
        originalIdentity: originalStat === null
          ? null
          : fileIdentity(originalStat),
        temporaryCreated: false,
        temporaryIdentity: null,
        backupCreated: false,
        backupIdentity: null,
        installed: false,
        installedIdentity: null,
      };
      prepared.push(preparedEntry);
      let descriptor = null;
      try {
        descriptor = openSync(temporary, 'wx', mode);
        preparedEntry.temporaryCreated = true;
        writeFileSync(descriptor, write.contents);
        fsyncSync(descriptor);
      } finally {
        if (descriptor !== null) closeSync(descriptor);
      }
      const temporaryStat = lstatOrNull(temporary);
      if (
        temporaryStat === null
        || temporaryStat.isSymbolicLink()
        || !temporaryStat.isFile()
      ) {
        throw new Error(`安全写入临时目标不是普通文件: ${temporary}`);
      }
      preparedEntry.temporaryIdentity = fileIdentity(temporaryStat);
      if (backup !== null) {
        copyFileSync(target, backup, constants.COPYFILE_EXCL);
        preparedEntry.backupCreated = true;
        const backupStat = lstatOrNull(backup);
        if (
          backupStat === null
          || backupStat.isSymbolicLink()
          || !backupStat.isFile()
        ) {
          throw new Error(`安全写入备份不是普通文件: ${backup}`);
        }
        preparedEntry.backupIdentity = fileIdentity(backupStat);
      }
    }
  } catch (error) {
    const rollbackErrors = rollbackPrepared(prepared, createdDirectories);
    const suffix = rollbackErrors.length > 0
      ? `；清理失败: ${rollbackErrors.join('；')}`
      : '';
    throw new Error(`安全写入事务准备失败: ${error.message}${suffix}`);
  }

  try {
    for (const entry of prepared) {
      inspectSafeTarget(rootInfo, entry.target, createdDirectories);
      const currentStat = lstatOrNull(entry.target);
      if (entry.hadOriginal) {
        if (
          currentStat === null
          || fileIdentity(currentStat) !== entry.originalIdentity
        ) {
          throw new Error(`目标在事务提交前发生变化: ${entry.target}`);
        }
      } else if (currentStat !== null) {
        throw new Error(`目标在事务提交前被创建: ${entry.target}`);
      }
      const temporaryStat = lstatOrNull(entry.temporary);
      if (
        temporaryStat === null
        || temporaryStat.isSymbolicLink()
        || !temporaryStat.isFile()
        || fileIdentity(temporaryStat) !== entry.temporaryIdentity
      ) {
        throw new Error(`事务临时文件在提交前发生变化: ${entry.temporary}`);
      }
      if (entry.hadOriginal) {
        const backupStat = lstatOrNull(entry.backup);
        if (
          backupStat === null
          || backupStat.isSymbolicLink()
          || !backupStat.isFile()
          || fileIdentity(backupStat) !== entry.backupIdentity
        ) {
          throw new Error(`事务备份在提交前发生变化: ${entry.backup}`);
        }
      }

      renameSync(entry.temporary, entry.target);
      entry.installed = true;
      const installedStat = lstatOrNull(entry.target);
      if (
        installedStat === null
        || installedStat.isSymbolicLink()
        || !installedStat.isFile()
      ) {
        throw new Error(`事务目标提交后不是普通文件: ${entry.target}`);
      }
      entry.installedIdentity = fileIdentity(installedStat);
    }
  } catch (error) {
    const rollbackErrors = rollbackPrepared(prepared, createdDirectories);
    const suffix = rollbackErrors.length > 0
      ? `；回滚失败: ${rollbackErrors.join('；')}`
      : '';
    throw new Error(`安全写入事务提交失败: ${error.message}${suffix}`);
  }

  for (const entry of prepared) {
    if (entry.backup === null || !entry.backupCreated) continue;
    try {
      removeIfPresent(entry.backup);
    } catch {
      // 新版本已全部提交，备份清理失败不破坏事务一致性。
    }
  }

  return {
    root: rootInfo.canonicalRoot,
    files: prepared.map((entry) => entry.target),
  };
}

export function safeAtomicWriteText(projectRoot, targetPath, contents) {
  return safeWriteTransaction(projectRoot, [
    { path: targetPath, contents },
  ]);
}

export function safeAtomicWriteJson(projectRoot, targetPath, value) {
  return safeAtomicWriteText(
    projectRoot,
    targetPath,
    serializeJson(value),
  );
}
