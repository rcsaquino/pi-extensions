import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SkillFile } from './types.ts';

export const MAX_TREE_BYTES = 10 * 1024 * 1024;
export const MAX_TREE_FILES = 256;
export function hash(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
export function within(root: string, target: string): boolean {
  const r = relative(resolve(root), resolve(target));
  return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`));
}
export function safeRelative(p: string): string {
  if (!p || isAbsolute(p) || p.includes('\\') || p.includes('\0') || p.split('/').some(x => !x || x === '.' || x === '..' || x.startsWith('.') || ['__proto__', 'prototype', 'constructor'].includes(x))) throw new Error('Unsafe relative path');
  if (p.length > 256) throw new Error('Path too long');
  return p;
}
export function targetPath(root: string, rel: string): string {
  const path = resolve(root, safeRelative(rel));
  if (!within(root, path) || path === resolve(root)) throw new Error('Path escapes root');
  return path;
}
export async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function noLinks(path: string, allowMissing = false): Promise<void> {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let p: string = sep;
  for (let i = 0; i < parts.length; i++) {
    p = join(p, parts[i]);
    let info;
    try { info = await fs.lstat(p); } catch (e) {
      if (allowMissing && (e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    if (i < parts.length - 1 && !info.isDirectory()) throw new Error('Parent is not a directory');
    if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error('Special or multi-linked files are not allowed');
  }
}
export async function secureDirectory(path: string): Promise<void> {
  await noLinks(path, true);
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  await noLinks(path);
  if (!(await fs.lstat(path)).isDirectory()) throw new Error('Expected a directory');
}
export async function readFileSafe(path: string, maxBytes = MAX_TREE_BYTES): Promise<Buffer> {
  await noLinks(path);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('File is unsafe or oversized');
    const data = await handle.readFile();
    if (data.length > maxBytes) throw new Error('File is oversized');
    return data;
  } finally { await handle.close(); }
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function atomicWrite(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const parent = dirname(path);
  await secureDirectory(parent);
  await noLinks(path, true);
  const temp = join(parent, `.al-write-${randomUUID()}`);
  const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode & 0o777);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  try {
    await noLinks(parent);
    await noLinks(path, true);
    await fs.rename(temp, path);
    await syncDirectory(parent);
  } finally { await fs.unlink(temp).catch(() => undefined); }
}
export async function tree(path: string): Promise<SkillFile[]> {
  await noLinks(path);
  if (!(await fs.lstat(path)).isDirectory()) throw new Error('Skill is not a directory');
  const files: SkillFile[] = [];
  let total = 0;
  async function walk(dir: string, prefix = ''): Promise<void> {
    await noLinks(dir);
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // No hidden content is silently omitted from a destructive snapshot.
      if (entry.name.includes('\\') || entry.name.includes('\0')) throw new Error('Unsafe filename');
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const p = join(dir, entry.name);
      const stat = await fs.lstat(p);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('Unsafe object in skill tree');
      if (stat.isDirectory()) {
        if (files.length >= MAX_TREE_FILES) throw new Error('Skill tree exceeds archive limits');
        files.push({ path: rel, content: Buffer.alloc(0), mode: stat.mode & 0o777, directory: true });
        await walk(p, rel); continue;
      }
      if (files.length >= MAX_TREE_FILES || total + stat.size > MAX_TREE_BYTES) throw new Error('Skill tree exceeds archive limits');
      const content = await readFileSafe(p);
      total += content.length;
      if (total > MAX_TREE_BYTES) throw new Error('Skill tree exceeds archive limits');
      files.push({ path: rel, content, mode: stat.mode & 0o777 });
    }
  }
  await walk(path);
  return files;
}
export function treeHash(files: SkillFile[]): string {
  const h = createHash('sha256');
  for (const file of [...normalizedFiles(files)].sort((a, b) => a.path.localeCompare(b.path))) h.update(JSON.stringify([file.path, file.mode, Boolean(file.directory), hash(file.content)]) + '\n');
  return h.digest('hex');
}
export function normalizedFiles(files: SkillFile[]): SkillFile[] {
  const map = new Map(files.map(f => [f.path, f]));
  for (const file of files) {
    let parent = dirname(file.path);
    while (parent !== '.') {
      if (!map.has(parent)) map.set(parent, { path: parent, content: Buffer.alloc(0), mode: 0o700, directory: true });
      parent = dirname(parent);
    }
  }
  return [...map.values()].sort((a, b) => Number(Boolean(b.directory)) - Number(Boolean(a.directory)) || a.path.localeCompare(b.path));
}
export async function writeTree(path: string, files: SkillFile[]): Promise<void> {
  await secureDirectory(path);
  for (const file of normalizedFiles(files)) {
    // Archived existing trees may have dotfiles; still enforce containment.
    const p = resolve(path, file.path);
    if (!within(path, p) || p === resolve(path) || file.path.includes('\\')) throw new Error('Unsafe snapshot path');
    if (file.directory) { await secureDirectory(p); await fs.chmod(p, file.mode); }
    else await atomicWrite(p, file.content, file.mode);
  }
  if (treeHash(await tree(path)) !== treeHash(files)) throw new Error('Snapshot verification failed');
}
export async function removeOwnedTree(root: string, path: string): Promise<void> {
  if (!within(root, path) || resolve(root) === resolve(path)) throw new Error('Unsafe removal');
  await tree(path); // Refuse links/special files rather than following them.
  await noLinks(dirname(path));
  await fs.rm(path, { recursive: true });
  await syncDirectory(dirname(path));
}
