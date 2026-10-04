import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { Directory, digest, literalPath, readRegular } from './files.ts';
import { normalizeResources, type ResourceLocks } from './resources.ts';
import { within, plainArgs } from './effects.ts';

export type StageSpec = { inputs: string[]; outputs: string[]; immutable_refs?: string[] };
function textFile(data: Buffer): void {
  if (data.includes(0)) throw new Error('Staging supports UTF-8 text files only.');
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error('Staging supports UTF-8 text files only.'); }
}
interface Base { path: string; hash: string | null; parentDev: number; parentIno: number; mode: number }
export interface OutputManifest { version: 1; taskId: string; outputs: { path: string; baseHash: string | null; outputHash: string; bytes: number }[]; hash: string }
export function safeManifest(value: OutputManifest, taskId: string): OutputManifest {
  if (!plainArgs(value) || value.version !== 1 || value.taskId !== taskId || !Array.isArray(value.outputs) || value.outputs.length > 128) throw new Error('Invalid staged manifest.');
  const outputs = value.outputs.map(o => {
    if (!plainArgs(o) || (o.baseHash !== null && !/^[a-f0-9]{64}$/.test(o.baseHash)) || !/^[a-f0-9]{64}$/.test(o.outputHash) || !Number.isSafeInteger(o.bytes) || o.bytes < 0 || o.bytes > 4 * 1024 * 1024) throw new Error('Invalid staged manifest output.');
    return { path: stagePath(o.path), baseHash: o.baseHash, outputHash: o.outputHash, bytes: o.bytes };
  });
  const payload = { version: 1 as const, taskId, outputs };
  if (digest(JSON.stringify(payload)) !== value.hash || new Set(outputs.map(o => o.path)).size !== outputs.length) throw new Error('Staged manifest hash/ownership mismatch.');
  return { ...payload, hash: value.hash };
}
export function stagePath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..') || /[\\\0]/.test(value) || /^[@~]|^file:/i.test(value)) throw new Error('Staged paths must be explicit relative regular-file paths.');
  literalPath(value); return value;
}
export function validateStage(spec: StageSpec): StageSpec {
  if (!plainArgs(spec) || Object.keys(spec).some(k => !['inputs', 'outputs', 'immutable_refs'].includes(k)) || !Array.isArray(spec.inputs) || !Array.isArray(spec.outputs) || (spec.immutable_refs !== undefined && !Array.isArray(spec.immutable_refs)) || !spec.outputs.length || spec.inputs.length + spec.outputs.length + (spec.immutable_refs?.length ?? 0) > 128) throw new Error('Invalid staged file contract.');
  const inputs = spec.inputs.map(stagePath), outputs = spec.outputs.map(stagePath);
  if (new Set(inputs).size !== inputs.length || new Set(outputs).size !== outputs.length) throw new Error('Duplicate staged files.');
  const immutable_refs = spec.immutable_refs?.map(literalPath) ?? [];
  const resources = outputs.map(path => ({ path: join('/stage', path), mode: 'write' as const }));
  for (let i = 0; i < resources.length; i++) for (const next of resources.slice(i + 1)) if (within(next.path, resources[i]!.path) || within(resources[i]!.path, next.path)) throw new Error('Overlapping staged output paths.');
  return { inputs, outputs, immutable_refs };
}
/** Supported staging contract: bounded regular files, no shell, custom extension execution,
 * delete, directories, symlinks or implicit reads of live parent files. Worker file operations
 * use the host-validated broker, never tools bound to the parent's cwd.
 */
export class Stage {
  private bases = new Map<string, Base>();
  private refs = new Map<string, string>();
  private refHashes = new Map<string, string>();
  private bytes = 0;
  private anchor?: Directory;
  private operations = Promise.resolve();
  manifest?: OutputManifest;
  published = false;
  readonly taskId: string;
  readonly cwd: string;
  readonly root: string;
  readonly spec: StageSpec;
  constructor(taskId: string, cwd: string, root: string, spec: StageSpec) { this.taskId = taskId; this.cwd = cwd; this.root = root; this.spec = spec; }
  snapshotResources() { return normalizeResources([...this.spec.inputs, ...this.spec.outputs].map(p => ({ path: join(this.cwd, p), mode: 'read' as const })).concat((this.spec.immutable_refs ?? []).map(path => ({ path, mode: 'read' as const })))); }
  private async readPrivate(path: string): Promise<Buffer | null> {
    const directory = await this.anchor!.child(dirname(path)); try { return await directory.read(basename(path)); } finally { await directory.close(); }
  }
  private async writePrivate(path: string, data: Buffer): Promise<void> {
    const directory = await this.anchor!.child(dirname(path), true); try { await directory.replace(basename(path), data); } finally { await directory.close(); }
  }
  async close(): Promise<void> { await this.anchor?.close(); this.anchor = undefined; }
  async saveProfile(profile: { provider: string; model: string; thinking: string }): Promise<void> {
    await this.writePrivate(join('profile', 'selection.json'), Buffer.from(JSON.stringify({ provider: profile.provider, model: profile.model, thinking: profile.thinking })));
  }
  async snapshot(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); this.anchor = await Directory.open(this.root, true);
    const owned = await this.anchor.handle.stat(); if ((owned.mode & 0o077) || (process.getuid && owned.uid !== process.getuid())) throw new Error('Staging namespace is not private and owned.');
    for (const name of ['input', 'output', 'references', 'cache', 'temp', 'profile', 'recovery']) { const dir = await this.anchor.child(name, true); await dir.close(); }
    for (const path of new Set([...this.spec.inputs, ...this.spec.outputs])) {
      signal?.throwIfAborted(); const absolute = join(this.cwd, path); const parent = await Directory.open(dirname(absolute));
      try {
        const entry = await parent.readEntry(basename(absolute)); const data = entry?.data; const stat = await parent.handle.stat();
        if (!data && !this.spec.outputs.includes(path)) throw new Error('A declared snapshot input is missing.');
        const fileStat = entry?.stat;
        const mode = fileStat ? fileStat.mode & 0o7777 : 0o644;
        if (this.spec.outputs.includes(path) && fileStat && (![0o600, 0o644].includes(mode) || (process.getuid && fileStat.uid !== process.getuid()))) throw new Error('Staged publication supports only owned 0600/0644 regular files, not executable/special-mode files.');
        this.bases.set(path, { path, hash: data ? digest(data) : null, parentDev: stat.dev, parentIno: stat.ino, mode });
        if (data) {
          textFile(data); this.count(data); await this.writePrivate(join('input', path), data);
          if (this.spec.outputs.includes(path)) await this.writePrivate(join('output', path), data);
          if (digest((await parent.read(basename(absolute)))!) !== digest(data)) throw new Error('Source changed during snapshot.');
        }
      } finally { await parent.close(); }
    }
    for (const path of this.spec.immutable_refs ?? []) {
      signal?.throwIfAborted(); const data = await readRegular(path); if (!data) throw new Error('An immutable reference is missing.'); textFile(data); this.count(data);
      const alias = join('references', digest(path)); await this.writePrivate(alias, data); this.refs.set(path, alias); this.refHashes.set(path, digest(data));
      if (digest((await readRegular(path))!) !== digest(data)) throw new Error('Reference changed during snapshot.');
    }
    await this.writePrivate('base.json', Buffer.from(JSON.stringify([...this.bases.values()])));
  }
  private count(data: Buffer): void { this.bytes += data.length; if (this.bytes > 16 * 1024 * 1024) throw new Error('Snapshot byte limit exceeded.'); }
  private resolve(path: string, write: boolean): string {
    if (this.refs.has(path)) { if (write) throw new Error('Immutable reference cannot be changed.'); return this.refs.get(path)!; }
    if (isAbsolute(path)) { if (!within(path, this.cwd)) throw new Error('Path escapes staged file contract.'); path = relative(this.cwd, path); }
    stagePath(path);
    if (this.spec.outputs.includes(path)) return join('output', path);
    if (!write && this.spec.inputs.includes(path)) return join('input', path);
    throw new Error('Path is not a declared staged input/output.');
  }
  describe(): string { return `Private staged workspace: ${join(this.root, 'output')}. File tools use only the declared snapshot. Inputs: ${JSON.stringify(this.spec.inputs)}. Outputs: ${JSON.stringify(this.spec.outputs)}. Immutable reference paths: ${JSON.stringify([...this.refs.keys()])}. Shells and unreviewed extension tools are unavailable. No changes are automatically published; the main chat must review the manifest and explicitly publish authorized outputs.`; }
  async file(operation: 'read' | 'write' | 'edit', path: string, content?: string, edits?: { oldText: string; newText: string }[], signal?: AbortSignal): Promise<string> {
    const execute = async () => {
      signal?.throwIfAborted(); if (this.manifest || this.published) throw new Error('Staged outputs are sealed.');
      const target = this.resolve(path, operation !== 'read');
      if (operation === 'read') { const data = await this.readPrivate(target); if (!data) throw new Error('Staged file is missing.'); textFile(data); return data.toString(); }
      let data: string;
      if (operation === 'write') { if (typeof content !== 'string') throw new Error('Content is required.'); data = content; }
      else {
        const original = await this.readPrivate(target); if (!original || !edits?.length || edits.length > 128) throw new Error('Invalid staged edit.');
        textFile(original); const text = original.toString(); const replacements = edits.map(e => {
          if (!e.oldText || typeof e.newText !== 'string') throw new Error('Invalid staged edit.');
          const start = text.indexOf(e.oldText); if (start < 0 || text.indexOf(e.oldText, start + 1) >= 0) throw new Error('Staged edit must match uniquely.');
          return { start, end: start + e.oldText.length, text: e.newText };
        }).sort((a, b) => a.start - b.start);
        if (replacements.some((e, i) => i > 0 && e.start < replacements[i - 1]!.end)) throw new Error('Overlapping staged edits.');
        data = text; for (const edit of replacements.reverse()) data = data.slice(0, edit.start) + edit.text + data.slice(edit.end);
      }
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new Error('Staged output byte limit exceeded.');
      const encoded = Buffer.from(data); textFile(encoded);
      signal?.throwIfAborted(); await this.writePrivate(target, encoded); return 'Staged file updated. Parent workspace unchanged.';
    };
    const next = this.operations.catch(() => {}).then(execute); this.operations = next.then(() => {}, () => {}); return next;
  }
  async seal(): Promise<OutputManifest> {
    await this.operations;
    const outputs: OutputManifest['outputs'] = [];
    for (const path of this.spec.outputs) {
      const data = await this.readPrivate(join('output', path)); if (!data) continue; textFile(data);
      const base = this.bases.get(path)!; const outputHash = digest(data);
      if (outputHash !== base.hash) outputs.push({ path, baseHash: base.hash, outputHash, bytes: data.length });
    }
    const payload = { version: 1 as const, taskId: this.taskId, outputs }; this.manifest = { ...payload, hash: digest(JSON.stringify(payload)) };
    await this.writePrivate('manifest.json', Buffer.from(JSON.stringify(this.manifest))); return this.manifest;
  }
  async publish(locks: ResourceLocks, expectedHash: string, signal?: AbortSignal, fault?: (index: number) => void): Promise<void> {
    if (!this.manifest || this.manifest.hash !== expectedHash || this.published || !this.manifest.outputs.length) throw new Error('Review a nonempty sealed manifest before publication.');
    const outputs = this.manifest.outputs;
    const changedPaths = new Set(outputs.map(o => o.path));
    const temporaryNames = new Map(outputs.map(o => [o.path, `.bg-${randomUUID()}.tmp`]));
    const rollbackNames = new Map(outputs.map(o => [o.path, `.bg-${randomUUID()}.tmp`]));
    const resources = [...this.bases.keys()].map(path => ({ path: join(this.cwd, path), mode: changedPaths.has(path) ? 'write' as const : 'read' as const })).concat([...this.refHashes.keys()].map(path => ({ path, mode: 'read' as const })))
      .concat([{ path: this.root, mode: 'write' as const }], outputs.flatMap(o => [temporaryNames.get(o.path)!, rollbackNames.get(o.path)!].map(name => ({ path: join(this.cwd, dirname(o.path), name), mode: 'write' as const }))));
    let release: (() => Promise<void>) | undefined;
    // Brief lock-table contention is not a conflicting publication. True target
    // conflicts return immediately for review; no foreground tool waits on them.
    for (let i = 0; i < 20 && !release; i++) {
      signal?.throwIfAborted(); release = await locks.acquire(resources, true);
      if (!release && locks.conflicts(resources)) break;
      if (!release) await new Promise(r => setTimeout(r, 10));
    }
    if (!release) throw new Error('Publication resources are busy. No output was changed; retry after review.');
    const prepared: { dir: Directory; output: typeof outputs[number]; temp: string; before: Buffer | null; identity: Stats; published?: Stats }[] = [];
    let changed = 0, rollbackFailed = false;
    try {
      const validateInputs = async () => {
        for (const [path, base] of this.bases) {
          if (changedPaths.has(path)) continue;
          const dir = await Directory.open(dirname(join(this.cwd, path)));
          try { const stat = await dir.handle.stat(); const data = await dir.read(basename(path)); if (stat.ino !== base.parentIno || stat.dev !== base.parentDev || (data ? digest(data) : null) !== base.hash) throw new Error('Stale input version. Review source changes before publication.'); }
          finally { await dir.close(); }
        }
        for (const [path, hash] of this.refHashes) { const data = await readRegular(path); if (!data || digest(data) !== hash) throw new Error('Stale immutable-reference version.'); }
      };
      await validateInputs();
      await this.writePrivate(join('recovery', 'journal.json'), Buffer.from(JSON.stringify({ version: 1, state: 'preparing', manifest: this.manifest, changed: 0, temporaryNames: Object.fromEntries(temporaryNames), rollbackNames: Object.fromEntries(rollbackNames) })));
      // Prepare every backup and replacement before changing any target.
      for (const output of outputs) {
        signal?.throwIfAborted(); const base = this.bases.get(output.path)!;
        const dir = await Directory.open(dirname(join(this.cwd, output.path))); const stat = await dir.handle.stat();
        try {
          if (stat.ino !== base.parentIno || stat.dev !== base.parentDev) throw new Error('Publication parent identity changed.');
          const entry = await dir.readEntry(basename(output.path)); const before = entry?.data ?? null;
          if (entry && ((entry.stat.mode & 0o7777) !== base.mode || (process.getuid && entry.stat.uid !== process.getuid()))) throw new Error('Publication target ownership/mode changed.');
          if ((before ? digest(before) : null) !== base.hash) throw new Error('Stale publication base. Review source changes; no merge was attempted.');
          const data = await this.readPrivate(join('output', output.path));
          if (!data || digest(data) !== output.outputHash) throw new Error('Staged output changed after review.');
          if (before) await this.writePrivate(join('recovery', digest(output.path)), before);
          const temp = await dir.prepare(data, base.mode, temporaryNames.get(output.path)!);
          const identity = (await dir.readEntry(temp))!.stat; prepared.push({ dir, output, temp, before, identity });
        } catch (e) { await dir.close(); throw e; }
      }
      const journal = (state: string) => this.writePrivate(join('recovery', 'journal.json'), Buffer.from(JSON.stringify({ version: 1, state, manifest: this.manifest, changed, temporaryNames: Object.fromEntries(temporaryNames), rollbackNames: Object.fromEntries(rollbackNames) })));
      await validateInputs(); await journal('prepared');
      for (const item of prepared) {
        await validateInputs();
        signal?.throwIfAborted(); await item.dir.check();
        fault?.(changed); // Fault fixtures run BEFORE the last execution-time validation.
        const current = await item.dir.readEntry(basename(item.output.path));
        if ((current ? digest(current.data) : null) !== item.output.baseHash) throw new Error('Publication base changed at execution.');
        if (current && ((current.stat.mode & 0o7777) !== this.bases.get(item.output.path)!.mode || (process.getuid && current.stat.uid !== process.getuid()))) throw new Error('Publication mode/ownership changed at execution.');
        const replacement = await item.dir.readEntry(item.temp);
        if (!replacement || digest(replacement.data) !== item.output.outputHash || replacement.stat.ino !== item.identity.ino || replacement.stat.dev !== item.identity.dev || (replacement.stat.mode & 0o7777) !== this.bases.get(item.output.path)!.mode) throw new Error('Prepared publication replacement changed.');
        await fs.rename(item.dir.entry(item.temp), item.dir.entry(basename(item.output.path))); changed++;
        item.published = (await item.dir.readEntry(basename(item.output.path)))!.stat;
        if (item.published.ino !== item.identity.ino || item.published.dev !== item.identity.dev) throw new Error('Published replacement identity changed.');
        await item.dir.handle.sync(); await journal('publishing');
      }
      await journal('committed'); this.published = true;
    } catch (e) {
      // Rollback only our replacement, never overwrite an uncoordinated later change.
      for (const item of prepared.slice(0, changed).reverse()) try {
        const owned = item.published ?? item.identity;
        const validateOwned = async () => {
          const current = await item.dir.readEntry(basename(item.output.path));
          if (!current || digest(current.data) !== item.output.outputHash || current.stat.ino !== owned.ino || current.stat.dev !== owned.dev || (item.published && current.stat.ctimeMs !== owned.ctimeMs)) throw new Error('Rollback target changed.');
        };
        await validateOwned();
        if (item.before) {
          const temp = await item.dir.prepare(item.before, this.bases.get(item.output.path)!.mode, rollbackNames.get(item.output.path)!);
          try { await validateOwned(); await item.dir.check(); await fs.rename(item.dir.entry(temp), item.dir.entry(basename(item.output.path))); }
          finally { await fs.unlink(item.dir.entry(temp)).catch(() => {}); }
        } else { await validateOwned(); await item.dir.check(); await fs.unlink(item.dir.entry(basename(item.output.path))); }
        await item.dir.handle.sync();
      } catch { rollbackFailed = true; }
      await this.writePrivate(join('recovery', 'journal.json'), Buffer.from(JSON.stringify({ version: 1, state: rollbackFailed ? 'review-required' : 'rolled-back', manifest: this.manifest, changed }))).catch(() => { rollbackFailed = true; });
      throw new Error(rollbackFailed ? 'Publication recovery requires review. Resource locks retained; no automatic replay.' : e instanceof Error ? e.message : 'Publication failed and rolled back.');
    } finally {
      for (const item of prepared) { await fs.unlink(item.dir.entry(item.temp)).catch(() => {}); await item.dir.close(); }
      if (!rollbackFailed) await release();
    }
  }
}
