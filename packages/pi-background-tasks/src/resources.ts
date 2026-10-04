import { constants, lstatSync, openSync, readFileSync, closeSync, fstatSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalPath, within } from './effects.ts';
import { Directory } from './files.ts';

export interface Resource { path: string; mode: 'read' | 'write' }
export type ResourceLease = (() => Promise<void>) & { readonly token: string; covers(resources: Resource[]): boolean; narrow(resources: Resource[]): Promise<void> };
interface Lease { token: string; pid: number; resources: Resource[]; retainOnCrash?: boolean; protectReads?: boolean }
export function normalizeResources(resources: Resource[]): Resource[] {
  if (!resources.length || resources.length > 512) throw new Error('Invalid resource count.');
  const normalized = new Map<string, Resource>();
  for (const resource of resources) {
    if (!['read', 'write'].includes(resource.mode)) throw new Error('Invalid resource mode.');
    const path = canonicalPath(resource.path);
    for (let p = resource.path;; p = dirname(p)) {
      try { const s = lstatSync(p); if (s.isSymbolicLink() || (p === resource.path && resource.mode === 'write' && s.nlink > 1 && s.isFile())) throw new Error('Unsafe resource alias.'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (dirname(p) === p) break;
    }
    const old = normalized.get(path); normalized.set(path, { path, mode: old?.mode === 'write' ? 'write' : resource.mode });
  }
  return [...normalized.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export const resourcesConflict = (a: Resource[], b: Resource[]): boolean => a.some(x => b.some(y =>
  (x.mode === 'write' || y.mode === 'write') && (within(x.path, y.path) || within(y.path, x.path))));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
function parse(data: Buffer | null): Lease[] {
  if (!data) return [];
  const value: unknown = JSON.parse(data.toString());
  if (!Array.isArray(value) || value.length > 256 || value.some(l => !l || typeof l.token !== 'string' || !/^[a-f0-9-]{36}$/.test(l.token) || !Number.isSafeInteger(l.pid) || l.pid < 1 || !Array.isArray(l.resources))) throw new Error('Malformed resource leases. Review state; no automatic replay.');
  return value.map(l => ({ token: l.token, pid: l.pid, resources: normalizeResources(l.resources), retainOnCrash: l.retainOnCrash === true, protectReads: l.protectReads === true || (l.protectReads === undefined && l.retainOnCrash === true) }));
}
/** Shared storage, all-or-nothing multi-resource acquisition. Cooperative Linux file locks,
 * not OS isolation. Dead-PID cleanup releases ownership only; work is never replayed.
 */
export class ResourceLocks {
  readonly path: string;
  readonly root: string;
  constructor(root: string) { this.root = root; this.path = join(root, 'resources.json'); }
  private async transaction<T>(operation: (leases: Lease[]) => Promise<{ leases: Lease[]; result: T }>): Promise<T | undefined> {
    const dir = await Directory.open(this.root, true); const token = randomUUID(); const mutex = dir.entry('resources.mutex');
    let owned = false;
    try {
      try {
        const file = await fs.open(mutex, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); owned = true; } finally { await file.close(); }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Never unlink an inspected mutex: another contender can replace it between
        // inspection and unlink, losing live ownership. Even a dead owner requires
        // explicit idle recovery review; no timeout/PID-based mutex stealing.
        return undefined;
      }
      const leases = parse(await dir.read('resources.json', 1024 * 1024)).filter(l => l.retainOnCrash || alive(l.pid));
      const next = await operation(leases), data = Buffer.from(JSON.stringify(next.leases));
      if (next.leases.length > 256 || data.length > 1024 * 1024) throw new Error('Resource lease capacity reached. No new lease was recorded.');
      await dir.replace('resources.json', data); return next.result;
    } finally {
      if (owned) { const owner = JSON.parse((await dir.read('resources.mutex', 4096))!.toString()); if (owner.token !== token) throw new Error('Resource mutex ownership changed.'); await fs.unlink(mutex); }
      await dir.close();
    }
  }
  async acquire(resources: Resource[], retainOnCrash = false, compatibilityRead = false, protectReads = retainOnCrash, parents: ResourceLease[] = []): Promise<ResourceLease | undefined> {
    let canonical = normalizeResources(resources); const token = randomUUID();
    const acquired = await this.transaction(async leases => {
      // Only manager-held live capabilities can exclude the owning job/ancestor call.
      // A new child lease still conflicts with every other job and sibling call.
      const excluded = new Set(parents.map(p => p.token));
      if ([...excluded].some(t => !leases.some(l => l.token === t && l.pid === process.pid))) throw new Error('Parent resource ownership lost.');
      return resourcesConflict(canonical, leases.filter(l => !excluded.has(l.token) && !(compatibilityRead && canonical.every(r => r.mode === 'read') && !l.protectReads)).flatMap(l => l.resources))
        ? { leases, result: false } : { leases: [...leases, { token, pid: process.pid, resources: canonical, retainOnCrash, protectReads }], result: true };
    });
    if (!acquired) return undefined;
    let released = false;
    const release = (async () => {
      if (released) return;
      // Cleanup may wait for the bounded in-process transaction, never foreground admission.
      for (let i = 0; i < 100; i++) {
        const ok = await this.transaction(async leases => ({ leases: leases.filter(l => l.token !== token), result: true }));
        if (ok) { released = true; return; }
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error('Resource release uncertain; ownership retained.');
    }) as ResourceLease;
    Object.defineProperty(release, 'token', { value: token });
    release.covers = resources => !released && normalizeResources(resources).every(r => canonical.some(held => within(r.path, held.path) && (held.mode === 'write' || r.mode === 'read')));
    release.narrow = async resources => {
      if (released) throw new Error('Cannot narrow released resources.');
      const next = normalizeResources(resources);
      for (let i = 0; i < 100; i++) {
        const ok = await this.transaction(async leases => {
          const owned = leases.find(l => l.token === token); if (!owned) throw new Error('Resource ownership lost.');
          if (next.some(n => !owned.resources.some(old => old.path === n.path && (old.mode === 'write' || old.mode === n.mode)))) throw new Error('Resource narrowing cannot expand access.');
          return { leases: leases.map(l => l.token === token ? { ...l, resources: next } : l), result: true };
        });
        if (ok) { canonical = next; return; } await new Promise(r => setTimeout(r, 10));
      }
      throw new Error('Resource narrowing uncertain; original ownership retained.');
    };
    return release;
  }
  conflicts(resources: Resource[], publicationOnly = false, parents: ResourceLease[] = []): boolean {
    // Synchronous and bounded tool-call guard. Never wait for a worker/publication lock.
    try {
      for (let p = this.path;; p = dirname(p)) { try { if (lstatSync(p).isSymbolicLink()) return true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } if (dirname(p) === p) break; }
      let file: number;
      try { file = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
      try { const stat = fstatSync(file); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) return true;
        return resourcesConflict(normalizeResources(resources), parse(readFileSync(file)).filter(l => !parents.some(p => p.token === l.token) && (!publicationOnly || l.protectReads) && (l.retainOnCrash || alive(l.pid))).flatMap(l => l.resources)); }
      finally { closeSync(file); }
    } catch { return true; }
  }
}
