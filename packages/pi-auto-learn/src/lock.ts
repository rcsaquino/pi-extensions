import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, noLinks, readFileSafe, secureDirectory } from './filesystem.ts';

export class BusyError extends Error { constructor() { super('Another auto-learn operation holds the lease'); this.name = 'BusyError'; } }
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
export async function acquireLock(root: string, name: string, waitMs = 0, signal?: AbortSignal): Promise<() => Promise<void>> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid lock name');
  await secureDirectory(join(root, 'locks'));
  const path = join(root, 'locks', name);
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  while (true) {
    signal?.throwIfAborted();
    try {
      await fs.mkdir(path, { mode: 0o700 });
      await atomicWrite(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, token, created: Date.now() }));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { await noLinks(path); } catch (check) { if ((check as NodeJS.ErrnoException).code === 'ENOENT') continue; throw check; }
      // Never steal a live process' lease, even after a long model call.
      let dead = false;
      try { dead = !alive(JSON.parse((await readFileSafe(join(path, 'owner.json'), 4096)).toString()).pid); }
      catch {
        try { dead = Date.now() - (await fs.stat(path)).mtimeMs > 30_000; }
        catch (gone) { if ((gone as NodeJS.ErrnoException).code === 'ENOENT') continue; throw gone; }
      }
      if (dead) {
        const stale = `${path}-stale-${randomUUID()}`;
        try { await fs.rename(path, stale); await fs.rm(stale, { recursive: true }); } catch (e2) { if ((e2 as NodeJS.ErrnoException).code !== 'ENOENT') throw e2; }
        continue;
      }
      if (Date.now() >= deadline) throw new BusyError();
      await new Promise(r => setTimeout(r, 15));
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await noLinks(path);
    const owner = JSON.parse((await readFileSafe(join(path, 'owner.json'), 4096)).toString());
    if (owner.token !== token) throw new Error('Lease owner changed');
    await fs.unlink(join(path, 'owner.json'));
    await fs.rmdir(path);
  };
}
export async function withLock<T>(root: string, name: string, body: () => Promise<T>, waitMs = 5000, signal?: AbortSignal): Promise<T> {
  const release = await acquireLock(root, name, waitMs, signal);
  try { return await body(); } finally { await release(); }
}
