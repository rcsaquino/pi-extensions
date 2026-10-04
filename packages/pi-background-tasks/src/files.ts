import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export function literalPath(path: string): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\0\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(path) || /^[@~]|^file:/i.test(path)) throw new Error('Unsupported literal path.');
  const absolute = resolve(path); if (absolute.length > 4096) throw new Error('Resource path exceeds limit.'); return absolute;
}
/** Linux descriptor-anchored I/O. Never chmod, follow a component symlink, or write a hardlink.
 * The identity checks detect path replacement; descriptor paths keep effects in the opened
 * directory even if same-user code races a check. This is not a hostile-process sandbox.
 */
export class Directory {
  readonly path: string;
  readonly handle: FileHandle;
  private constructor(path: string, handle: FileHandle) { this.path = path; this.handle = handle; }
  static async open(path: string, create = false): Promise<Directory> {
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW) throw new Error('Descriptor-safe file operations require Linux.');
    const absolute = literalPath(path);
    let handle = await fs.open('/', directoryFlags), current = '/';
    try {
      for (const part of absolute.split('/').filter(Boolean)) {
        const child = `/proc/self/fd/${handle.fd}/${part}`;
        if (create) await fs.mkdir(child, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        const next = await fs.open(child, directoryFlags); await handle.close(); handle = next; current = join(current, part);
      }
      const dir = new Directory(current, handle); await dir.check(); return dir;
    } catch (e) { await handle.close().catch(() => {}); throw e; }
  }
  async check(): Promise<void> {
    const held = await this.handle.stat();
    // Reopen the whole chain without following symlinks, not just lstat(final).
    let check = await fs.open('/', directoryFlags);
    try {
      for (const part of this.path.split('/').filter(Boolean)) { const next = await fs.open(`/proc/self/fd/${check.fd}/${part}`, directoryFlags); await check.close(); check = next; }
      const now = await check.stat();
      if (now.ino !== held.ino || now.dev !== held.dev) throw new Error('Resource directory identity changed.');
    } finally { await check.close(); }
  }
  async child(path: string, create = false): Promise<Directory> {
    if (path !== '.' && path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid anchored child path.');
    await this.check(); let handle = await fs.open(`/proc/self/fd/${this.handle.fd}/.`, directoryFlags);
    try {
      for (const part of path === '.' ? [] : path.split('/')) {
        const child = `/proc/self/fd/${handle.fd}/${part}`;
        if (create) await fs.mkdir(child, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        const next = await fs.open(child, directoryFlags); await handle.close(); handle = next;
      }
      const directory = new Directory(join(this.path, path), handle); await directory.check(); return directory;
    } catch (e) { await handle.close().catch(() => {}); throw e; }
  }
  entry(name: string): string {
    if (!/^[^/\0]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid resource entry.');
    return `/proc/self/fd/${this.handle.fd}/${name}`;
  }
  async read(name: string, limit = 4 * 1024 * 1024): Promise<Buffer | null> {
    return (await this.readEntry(name, limit))?.data ?? null;
  }
  async readEntry(name: string, limit = 4 * 1024 * 1024): Promise<{ data: Buffer; stat: Stats } | null> {
    await this.check();
    let file: FileHandle;
    try { file = await fs.open(this.entry(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('Unsafe or oversized regular file.');
      const data = Buffer.alloc(before.size + 1); const { bytesRead } = await file.read(data, 0, data.length, 0);
      const after = await file.stat();
      const named = await fs.lstat(this.entry(name));
      if (bytesRead !== before.size || after.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || named.ino !== after.ino || named.dev !== after.dev || named.isSymbolicLink()) throw new Error('File changed during read.');
      await this.check(); return { data: data.subarray(0, bytesRead), stat: after };
    } finally { await file.close(); }
  }
  async prepare(data: Buffer, mode = 0o600, name = `.bg-${randomUUID()}.tmp`): Promise<string> {
    if (!/^\.bg-[a-f0-9-]{36}\.tmp$/.test(name)) throw new Error('Invalid prepared-file namespace.');
    await this.check();
    const file = await fs.open(this.entry(name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== mode) throw new Error('Prepared file ownership/mode is unsafe or prevented by the host umask.');
      await file.writeFile(data); await file.sync();
      const after = await file.stat(), named = await fs.lstat(this.entry(name));
      if (after.nlink !== 1 || (after.mode & 0o7777) !== mode || after.ino !== named.ino || after.dev !== named.dev || named.isSymbolicLink()) throw new Error('Prepared file identity changed.');
    } catch (e) { await fs.unlink(this.entry(name)).catch(() => {}); throw e; }
    finally { await file.close(); }
    return name;
  }
  async replace(name: string, data: Buffer, mode = 0o600): Promise<void> {
    // Validate existing entries even though rename would replace rather than modify them.
    await this.read(name); const temp = await this.prepare(data, mode);
    try { await this.check(); await fs.rename(this.entry(temp), this.entry(name)); await this.handle.sync(); }
    finally { await fs.unlink(this.entry(temp)).catch(() => {}); }
  }
  async close(): Promise<void> { await this.handle.close(); }
}
export async function readRegular(path: string, limit?: number): Promise<Buffer | null> {
  path = literalPath(path); const dir = await Directory.open(dirname(path));
  try { return await dir.read(path.slice(dirname(path).length + (dirname(path) === '/' ? 0 : 1)), limit); }
  finally { await dir.close(); }
}
export async function writeRegular(path: string, data: Buffer, createParents = false): Promise<void> {
  path = literalPath(path); const dir = await Directory.open(dirname(path), createParents);
  try { await dir.replace(path.slice(dirname(path).length + (dirname(path) === '/' ? 0 : 1)), data); }
  finally { await dir.close(); }
}
