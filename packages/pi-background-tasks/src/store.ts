import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { RecordData } from './types.ts';
import { isActive } from './types.ts';

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const validId = (id: string): boolean => /^bg-[a-f0-9]{12}$/.test(id);
const noFollow = constants.O_NOFOLLOW ?? 0;

export async function privateDirectory(path: string): Promise<void> {
  // Check every existing component so an attacker cannot redirect runtime writes with a symlink.
  const absolute = resolve(path);
  let current = absolute.startsWith('/') ? '/' : absolute.split(/[/\\]/)[0]!;
  for (const part of absolute.slice(current.length).split(/[/\\]/).filter(Boolean)) {
    current = join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Background storage cannot traverse symlinks or non-directories.');
  }
}
export async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  try {
    await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close();
    await fs.rename(temporary, path);
  } catch (e) { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); throw e; }
}
export class Store {
  readonly root: string;
  readonly recordsDir: string;
  readonly sessionId: string;
  constructor(root: string, sessionId: string) {
    this.root = resolve(root); this.sessionId = sessionId;
    this.recordsDir = join(this.root, 'sessions', hash(sessionId));
  }
  async init(): Promise<void> { await privateDirectory(this.recordsDir); await privateDirectory(join(this.root, 'locks')); }
  path(id: string, suffix: 'json' | 'md'): string {
    if (!validId(id)) throw new Error('Invalid background task ID.');
    return join(this.recordsDir, `${id}.${suffix}`);
  }
  async write(record: RecordData, output?: string): Promise<void> {
    if (output !== undefined) await atomicPrivateWrite(this.path(record.id, 'md'), output);
    await atomicPrivateWrite(this.path(record.id, 'json'), JSON.stringify(record, null, 2) + '\n');
  }
  async output(id: string): Promise<string> {
    const handle = await fs.open(this.path(id, 'md'), constants.O_RDONLY | noFollow);
    try { return await handle.readFile('utf8'); } finally { await handle.close(); }
  }
  async restore(): Promise<RecordData[]> {
    const records: RecordData[] = [];
    for (const file of await fs.readdir(this.recordsDir)) {
      if (!/^bg-[a-f0-9]{12}\.json$/.test(file)) continue;
      const handle = await fs.open(join(this.recordsDir, file), constants.O_RDONLY | noFollow);
      let record: RecordData;
      try { record = JSON.parse(await handle.readFile('utf8')) as RecordData; } finally { await handle.close(); }
      if (record.version !== 1 || record.sessionId !== this.sessionId || `${record.id}.json` !== file ||
          !['running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(record.status) ||
          (record.contextMode !== undefined && !['brief', 'selected', 'full'].includes(record.contextMode))) throw new Error('Invalid background task metadata.');
      if (isActive(record.status)) {
        record.status = 'interrupted'; record.finishedAt = Date.now(); record.notification = 'pending';
        record.error = 'Pi stopped or reloaded before this task settled. Effects may be partial. It was NOT replayed.';
        await this.write(record);
      }
      records.push(record);
    }
    return records.sort((a, b) => a.startedAt - b.startedAt);
  }
  async acquireWriter(cwd: string): Promise<() => Promise<void>> {
    const path = join(this.root, 'locks', `${hash(cwd)}.json`);
    const token = randomUUID();
    // Never steal a live or malformed lease, and never silently replay work after a crash.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, sessionId: this.sessionId, token }), 'utf8'); }
        finally { await handle.close(); }
        return async () => {
          try {
            const existing = await readLock(path);
            if (existing.token === token) await fs.unlink(path);
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const existing = await readLock(path);
        if (!Number.isSafeInteger(existing.pid) || existing.pid < 1) throw new Error('Malformed workspace writer lease; inspect storage before proceeding.');
        let alive = true;
        try { process.kill(existing.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new Error('A live background writer already owns this workspace. Finish/cancel it first.');
        await fs.unlink(path);
      }
    }
    throw new Error('Could not acquire the workspace writer lease.');
  }
}
async function readLock(path: string): Promise<{ pid: number; token: string }> {
  const handle = await fs.open(path, constants.O_RDONLY | noFollow);
  try { return JSON.parse(await handle.readFile('utf8')) as { pid: number; token: string }; } finally { await handle.close(); }
}
