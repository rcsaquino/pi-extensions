import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';

export type EffectKind = 'filesystem-read' | 'network-read' | 'declared-write' | 'external-mutation' | 'unknown';
export interface ToolEffects {
  kind: EffectKind;
  reads?: string[];
  writes?: string[];
  /** All non-session persistent writes, including eviction/chmod, must stay here. */
  privateCache?: string;
}
export interface EffectContract {
  name: string;
  /** Exact host-provided source identity, not a tool annotation or model argument. */
  source: string;
  readCandidate: boolean;
  classify(args: Record<string, unknown>, cwd: string): ToolEffects;
}
const unknown = (): ToolEffects => ({ kind: 'unknown' });
const overlap = (a: string, b: string): boolean => within(a, b) || within(b, a);
export function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
/** Resolve existing components; dangling symlinks, loops and inaccessible paths fail closed. */
export function canonicalPath(path: string, cwd = process.cwd()): string {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('Invalid resource path.');
  let target = resolve(cwd, path);
  const tail: string[] = [];
  for (;;) {
    try { lstatSync(target); return resolve(realpathSync(target), ...tail); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      // lstat succeeds on a dangling link, so ENOENT here may have come from realpath.
      try { if (lstatSync(target).isSymbolicLink()) throw new Error('Unresolved resource symlink.'); }
      catch (inner) { if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner; }
      const parent = dirname(target);
      if (parent === target) throw new Error('Unresolved resource path.');
      tail.unshift(target.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))); target = parent;
    }
  }
}
function privateRoot(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  let current = absolute;
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe cache root.');
      if (current === absolute && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) throw new Error('Cache is not private.');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return canonicalPath(absolute);
}
export function plainArgs(args: unknown): args is Record<string, unknown> {
  return !!args && typeof args === 'object' && !Array.isArray(args) &&
    (Object.getPrototypeOf(args) === Object.prototype || Object.getPrototypeOf(args) === null) &&
    Object.values(Object.getOwnPropertyDescriptors(args)).every(d => 'value' in d);
}

/** Contracts are reviewed CODE supplied at construction, never registered by an event/tool/config hint.
 * A contract's implementation must enforce its declared confinement through completion (including
 * detached work), and reject symlink/hardlink aliases before any cache mutation.
 * Source identity alone is NOT proof of effects. No pi-web-access contract is shipped:
 * cached configuration/credential commands and extraction paths lack a public confinement contract.
 */
export class EffectRegistry {
  private readonly contracts: ReadonlyArray<EffectContract>;
  constructor(contracts: EffectContract[] = []) { this.contracts = contracts.map(c => Object.freeze({ ...c })); }
  candidate(name: string, info?: ToolInfo): boolean {
    if (['read', 'ls'].includes(name) && info?.sourceInfo?.path === `builtin:${name}`) return true;
    return this.contracts.some(c => c.name === name && c.source === info?.sourceInfo?.path && c.readCandidate);
  }
  classify(name: string, args: unknown, cwd: string, info?: ToolInfo): ToolEffects {
    if (!plainArgs(args)) return unknown();
    try {
      let effects: ToolEffects;
      if (['read', 'ls', 'write', 'edit'].includes(name) && info?.sourceInfo?.path === `builtin:${name}`) {
        const path = args.path ?? args.file_path ?? (name === 'ls' ? cwd : undefined);
        // Pi expands tilde, @ and file: URLs and normalizes Unicode spaces. Do not
        // grant disjoint-write permission for an alternative interpretation of a path.
        if (typeof path !== 'string' || /^[@~]|^file:/i.test(path) || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(path)) return unknown();
        const resource = canonicalPath(path, cwd);
        effects = ['write', 'edit'].includes(name) ? { kind: 'declared-write', writes: [resource] } : { kind: 'filesystem-read', reads: [resource] };
      } else {
        const contract = this.contracts.find(c => c.name === name && c.source === info?.sourceInfo?.path);
        if (!contract) return unknown();
        effects = contract.classify(args, cwd);
      }
      if (!['filesystem-read', 'network-read', 'declared-write', 'external-mutation', 'unknown'].includes(effects.kind)) return unknown();
      const reads = effects.reads?.map(p => canonicalPath(p, cwd));
      const writes = effects.writes?.map(p => canonicalPath(p, cwd));
      for (const path of writes ?? []) {
        try { if (lstatSync(path).nlink > 1) return unknown(); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      const cache = effects.privateCache ? privateRoot(effects.privateCache, cwd) : undefined;
      if (effects.kind === 'filesystem-read' && (cache || writes?.length)) return unknown();
      if (effects.kind === 'network-read' && writes?.some(p => !cache || !within(p, cache))) return unknown();
      if (effects.kind === 'declared-write' && !writes?.length) return unknown();
      return { kind: effects.kind, reads, writes, privateCache: cache };
    } catch { return unknown(); }
  }
  safeRead(effects: ToolEffects, workspace: string): boolean {
    return effects.kind === 'filesystem-read' || (effects.kind === 'network-read' &&
      (!effects.privateCache || !overlap(effects.privateCache, workspace)));
  }
  conflicts(effects: ToolEffects, workspace: string): boolean {
    if (effects.kind === 'filesystem-read') return false;
    if (effects.kind === 'network-read') return !!effects.privateCache && overlap(effects.privateCache, workspace);
    if (effects.kind === 'declared-write') return !!effects.writes?.some(p => overlap(p, workspace));
    return true;
  }
}
