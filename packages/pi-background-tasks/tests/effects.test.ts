import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import { EffectRegistry, canonicalPath, plainArgs } from '../src/effects.ts';
import { guardTool } from '../src/policy.ts';
import { inspectFilesystem, validateInspection } from '../src/inspect.ts';
import { emptyUsage } from '../src/types.ts';
import type { RecordData } from '../src/types.ts';
import { scratch } from './helpers.ts';

const info = (name: string, path = `builtin:${name}`) => ({ name, sourceInfo: { path }, annotations: { readOnlyHint: true }, exposure: 'direct' }) as ToolInfo;
const record = (cwd: string, access: 'read' | 'write' = 'write'): RecordData => ({ version: 1, id: 'bg-111111111111', title: 'Importer fixture', sessionId: 'fixture', cwd,
  provider: 'fixture', model: 'fixture', thinking: 'off', status: 'running', access, startedAt: 1, etaSeconds: 300, etaMaxSeconds: 300,
  estimateReason: 'fixture', lastActivityAt: 1, toolCalls: 0, turns: 0, usage: emptyUsage(), usageReported: false, notification: 'read', overrunNotified: false });

test('audited fixture: active importer plus cached/uncached network lookups, collisions, permission hooks and actual effects', async t => {
  const root = await scratch('effects-network-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), cache = join(root, 'private-cache');
  await fs.mkdir(workspace); await fs.mkdir(cache, { mode: 0o700 });
  const lookupInfo = info('fixture_lookup', '<audited-fixture>');
  // Synthetic, reviewed lookup implementation. Not a claim about pi-web-access.
  const registry = new EffectRegistry([{ name: 'fixture_lookup', source: '<audited-fixture>', readCandidate: true,
    classify: args => {
      if (!plainArgs(args) || Object.keys(args).some(k => !['key','mode'].includes(k)) || typeof args.key !== 'string' || !/^[a-z]{1,20}$/.test(args.key) || (args.mode !== undefined && args.mode !== 'lookup')) return { kind: 'unknown' };
      return { kind: 'network-read', privateCache: cache, writes: [join(cache, `${args.key}.json`)] };
    } }]);
  const writer = record(workspace), own = record(workspace, 'read');
  let providers = 0, hooks = 0, effects = 0;
  const inFlight = new Map<string, Promise<string>>();
  const lookup = async (args: Record<string, unknown>) => {
    const reason = guardTool('fixture_lookup', args, workspace, writer, undefined, lookupInfo, registry); if (reason) throw new Error(reason);
    // Stand-in for parent ctx.executeTool pipeline. Admission never skips its hooks.
    hooks++; if (args.key === 'denied') throw new Error('Parent permission hook denied');
    const key = args.key as string, path = join(cache, `${key}.json`);
    try { return await fs.readFile(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const running = inFlight.get(key); if (running) return running;
    const miss = (async () => {
      providers++; await new Promise(r => setImmediate(r));
      // O_EXCL and per-key coordination prevent colliding publication, no overwrite.
      const file = await fs.open(path, 'wx', 0o600); try { await file.writeFile('fixture source-linked result'); effects++; } finally { await file.close(); }
      return 'fixture source-linked result';
    })();
    inFlight.set(key, miss); try { return await miss; } finally { inFlight.delete(key); }
  };
  await fs.writeFile(join(workspace, 'importer.txt'), 'unchanged');
  assert.equal(await lookup({ key: 'cached' }), 'fixture source-linked result');
  assert.equal(await lookup({ key: 'cached' }), 'fixture source-linked result');
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => lookup({ key: 'collision' }))), Array(20).fill('fixture source-linked result'));
  await Promise.all([lookup({ key: 'other' }), lookup({ key: 'uncached' })]);
  assert.equal(providers, 4); assert.equal(effects, 4); assert.equal(hooks, 24);
  await assert.rejects(lookup({ key: 'denied' }), /Parent permission/); assert.equal(effects, 4);
  assert.equal(await fs.readFile(join(workspace, 'importer.txt'), 'utf8'), 'unchanged');
  assert.equal(guardTool('fixture_lookup', { key: 'safe' }, workspace, writer, own, lookupInfo, registry), undefined);
  for (const args of [{ key: '../escape' }, { key: 'safe', download: true }, { key: 'safe', mode: 'delete' }, { key: 'safe', auth: true }, { key: 'safe', frames: 3 }, { key: 'safe', command: 'touch file' }, [] as never, null as never]) await assert.rejects(lookup(args));
  assert.match(guardTool('fixture_lookup', { key: 'safe' }, workspace, writer, undefined, info('fixture_lookup', '<spoof>'), registry)!, /unknown/);
  for (const name of ['web_search','source_check','fetch_content','get_search_content','bash','powershell','unknown','memoria_add','telegram_send']) {
    assert.match(guardTool(name, { command: 'ls > bad; $(touch evil); find . -exec rm {} \\;' }, workspace, writer, undefined, info(name), registry)!, /could conflict/);
    assert.match(guardTool(name, {}, workspace, undefined, own, info(name), registry)!, /Read-only|main chat owns/);
  }
  await fs.symlink(join(workspace, 'importer.txt'), join(cache, 'symlink.json'));
  await fs.link(join(workspace, 'importer.txt'), join(cache, 'hardlink.json'));
  await assert.rejects(lookup({ key: 'symlink' }), /could conflict/);
  await assert.rejects(lookup({ key: 'hardlink' }), /could conflict/);
  assert.equal((await fs.readdir(workspace)).length, 1);
});

test('contracts normalize resources, reject symlink/unsafe cache ownership and conflicting writes', async t => {
  const root = await scratch('effects-paths-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), sibling = join(root, 'workspace-other'); await fs.mkdir(workspace); await fs.mkdir(sibling);
  await fs.symlink(workspace, join(root, 'alias')); await fs.symlink(join(root, 'missing'), join(root, 'dangling'));
  const writer = record(workspace);
  for (const path of [workspace, join(root, 'alias', 'new'), root, join(root, 'dangling', 'new'), '@' + join(workspace, 'new'), 'file://' + join(workspace, 'new'), '~/.x']) {
    assert.match(guardTool('write', { path }, root, writer, undefined, info('write'))!, /could conflict/);
  }
  assert.throws(() => canonicalPath(join(root, 'dangling', 'new')));
  assert.equal(guardTool('write', { path: join(sibling, 'new') }, root, writer, undefined, info('write')), undefined, 'disjoint is not authorization; parent hooks remain required');
  await fs.writeFile(join(workspace, 'existing'), 'fixture'); await fs.link(join(workspace, 'existing'), join(sibling, 'linked'));
  assert.match(guardTool('write', { path: join(sibling, 'linked') }, root, writer, undefined, info('write'))!, /unknown/);
  assert.match(guardTool('write', { path: join(sibling, 'new') }, root, writer, undefined, info('write','<extension-shadow>'))!, /unknown/);
  for (const cache of [workspace, join(root, 'alias'), join(sibling, 'cache')]) {
    if (cache.endsWith('cache')) await fs.mkdir(cache, { mode: 0o755 });
    const registry = new EffectRegistry([{ name: 'lookup', source: '<fixture>', readCandidate: true, classify: () => ({ kind: 'network-read', privateCache: cache }) }]);
    assert.match(guardTool('lookup', {}, root, writer, undefined, info('lookup','<fixture>'), registry)!, /could conflict/);
  }
  const registry = new EffectRegistry([{ name: 'mutate', source: '<fixture>', readCandidate: true, classify: () => ({ kind: 'external-mutation' }) }]);
  assert.match(guardTool('mutate', {}, root, writer, undefined, info('mutate','<fixture>'), registry)!, /external-mutation/);
});

test('structured filesystem inspection is useful during writer activity, bounded and inert for malicious shell-like arguments', async t => {
  const root = await scratch('effects-inspection-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, 'sub')); await fs.writeFile(join(root, 'sub', 'file.txt'), 'needle here\nno\nneedle again');
  await fs.symlink(join(root, 'sub'), join(root, 'alias')); await fs.writeFile(join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
  const registry = new EffectRegistry([{ name: 'background_fs_inspect', source: '<fixture>', readCandidate: true,
    classify: (args, cwd) => { validateInspection(args); return { kind: 'filesystem-read', reads: [canonicalPath(args.path as string, cwd)] }; } }]);
  const writer = record(root);
  const inspect = async (args: Record<string, unknown>) => {
    const reason = guardTool('background_fs_inspect', args, root, writer, undefined, info('background_fs_inspect','<fixture>'), registry);
    if (reason) throw new Error(reason); return inspectFilesystem(args, root);
  };
  assert.equal((await inspect({ action: 'grep', path: '.', text: 'needle' })).results.length, 2);
  assert.equal((await inspect({ action: 'grep', path: '.', text: 'needle' })).skipped, 2);
  assert.ok((await inspect({ action: 'find', path: '.', name_contains: 'file' })).results.some(x => x.path.endsWith('file.txt')));
  assert.equal((await inspect({ action: 'ls', path: '.' })).results.some(x => x.path.endsWith('file.txt')), false);
  assert.equal((await inspect({ action: 'find', path: '.', limit: 1 })).truncated, true);
  for (const text of ['$(touch evil)', 'needle; rm -rf sub', '>redirect', 'find . -exec touch evil \\;']) await inspect({ action: 'grep', path: '.', text });
  for (const args of [{ action: 'exec', path: '.' }, { action: 'find', path: '.', exec: 'touch evil' }, { action: 'grep', path: '.' }, { action: 'ls', path: '.', limit: Infinity }, { action: 'find', path: '.', max_depth: 100 }]) await assert.rejects(inspect(args));
  await assert.rejects(inspect({ action: 'find', path: 'alias' }), /symlinks/);
  await assert.rejects(inspectFilesystem({ action: 'ls', path: '.' }, root, AbortSignal.abort()));
  await assert.rejects(fs.stat(join(root, 'evil')), { code: 'ENOENT' });
  const getter = Object.defineProperty({}, 'path', { get() { throw new Error('getter must not run'); } });
  assert.equal(plainArgs(getter), false); assert.throws(() => validateInspection(getter), /Invalid/);
});
