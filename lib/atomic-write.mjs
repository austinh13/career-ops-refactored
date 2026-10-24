/**
 * atomic-write.mjs — write a file by renaming a fsynced temp file into place,
 * so a reader never sees a half-written file.
 */

import {
  closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function isIgnorableDirectoryFsyncError(err, platform = process.platform) {
  return ['EINVAL', 'ENOTSUP', 'ENOSYS'].includes(err?.code)
    || (platform === 'win32' && ['EACCES', 'EPERM'].includes(err?.code));
}

export function atomicWriteFile(filePath, text) {
  const fileStat = lstatSync(filePath, { throwIfNoEntry: false });
  const targetPath = fileStat?.isSymbolicLink() ? realpathSync(filePath) : filePath;
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let fd = null;
  let directoryFd = null;
  try {
    const existingMode = existsSync(targetPath) ? statSync(targetPath).mode & 0o7777 : null;
    fd = openSync(tempPath, 'wx', 0o600);
    if (existingMode !== null) fchmodSync(fd, existingMode);
    writeFileSync(fd, text, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, targetPath);
    try {
      directoryFd = openSync(path.dirname(targetPath), 'r');
      fsyncSync(directoryFd);
    } catch (err) {
      if (!isIgnorableDirectoryFsyncError(err)) throw err;
    } finally {
      if (directoryFd !== null) closeSync(directoryFd);
      directoryFd = null;
    }
  } catch (err) {
    if (fd !== null) closeSync(fd);
    if (directoryFd !== null) closeSync(directoryFd);
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    throw err;
  }
}
