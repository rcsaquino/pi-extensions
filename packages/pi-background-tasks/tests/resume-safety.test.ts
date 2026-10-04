import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BackgroundManager } from '../src/manager.ts';
import { ResourceLocks } from '../src/resources.ts';
import { SafeWeb } from '../src/web.ts';
import { Stage } from '../src/staging.ts';
import { Store, atomicPrivateWrite } from '../src/store.ts';
import { Admission } from '../src/admission.ts';
import { revalidateProfile } from '../src/policy.ts';
import { emptyUsage } from '../src/types.ts';
import type { RecordData } from '../src/types.ts';
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { scratch } from './helpers.ts';

async function fixture(t: test.TestContext) {
  const root = await scratch('resume-safety-');
  const pi = { getFlag: () => undefined, getAllTools: () => [...['read', 'write', 'bash'].map(name => ({ name, exposure: 'direct', sourceInfo: { path: `builtin:${name}` } })), { name: 'background_stage_file', exposure: 'codemode', sourceInfo: { path: '/synthetic/source' } }], events: { emit: () => {} }, appendEntry: () => {}, sendMessage: () => {} } as unknown as ExtensionAPI;
  const ctx = { cwd: join(root, 'parent'), mode: 'rpc', hasUI: false, isIdle: () => false, hasPendingMessages: () => false, sessionManager: { getSessionId: () => 'synthetic', getBranch: () => [] }, ui: { notify: () => {} } } as unknown as ExtensionContext;
  await fs.mkdir(ctx.cwd);
  const manager = new BackgroundManager(pi); await manager.init(ctx);
  t.after(async () => { await manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, manager, ctx };
}
const recordFor = (cwd: string): RecordData => ({ version: 1, id: 'bg-aaaaaaaaaaaa', title: 'Synthetic', sessionId: 'synthetic', cwd, provider: 'fake', model: 'fake', thinking: 'off', status: 'running', access: 'write', execution: 'direct', startedAt: Date.now(), etaSeconds: 300, etaMaxSeconds: 300, estimateReason: 'Synthetic', lastActivityAt: Date.now(), toolCalls: 0, turns: 0, usage: emptyUsage(), usageReported: false, notification: 'read', overrunNotified: false });
const call = (toolCallId: string, toolName: string, path?: string) => ({ type: 'tool_call', toolCallId, ...(toolCallId.includes('/') ? { parentToolCallId: toolCallId.slice(0, toolCallId.lastIndexOf('/')) } : {}), toolName, input: path ? { path, content: 'synthetic' } : { command: 'synthetic' } }) as ToolCallEvent;

test('direct worker escaping writes and opaque tools cannot bypass another protected namespace', async t => {
  const { root, manager, ctx } = await fixture(t);
  const record = recordFor(ctx.cwd);
  const direct = await manager.locks!.acquire([{ path: ctx.cwd, mode: 'write' }], true, false, false); assert.ok(direct);
  manager.jobs.set(record.id, { record, rootCallId: 'dispatch', controller: new AbortController(), release: direct, resourceLease: direct });
  const target = join(root, 'other-stage'); const staged = await manager.locks!.acquire([{ path: target, mode: 'write' }], false, false, true); assert.ok(staged);
  t.after(async () => { await staged(); await direct(); manager.jobs.delete(record.id); });
  assert.equal(manager.guard(call('dispatch/1', 'write', join(target, 'file')), ctx)?.block, true);
  assert.equal(manager.guard(call('dispatch/2', 'bash'), ctx)?.block, true);
});

test('dead or replaced resource mutex is uncertainty, not a concurrently stealable lock', async t => {
  const { root } = await fixture(t); const locks = new ResourceLocks(join(root, 'independent-locks'));
  await fs.mkdir(locks.root); await fs.writeFile(join(locks.root, 'resources.mutex'), JSON.stringify({ pid: 2147483647, token: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
  assert.equal(await locks.acquire([{ path: root, mode: 'write' }]), undefined);
  assert.ok(await fs.stat(join(locks.root, 'resources.mutex')), 'do not unlink a mutex inspected earlier and race a new live owner');
});

test('clearing web ownership aborts or invalidates pending work and prevents late result/cache publication', async () => {
  let finish!: (data: unknown) => void;
  const web = new SafeWeb(async () => new Promise(resolve => { finish = resolve; }), async () => ({ provider: 'parallel', parallelApiKey: '$RESUME_INERT_KEY' }));
  const previous = process.env.RESUME_INERT_KEY; process.env.RESUME_INERT_KEY = 'synthetic';
  try {
    const pending = web.search({ query: 'synthetic' }, 'session');
    await new Promise(r => setImmediate(r)); web.clear(); finish({ results: [{ title: 'Synthetic', url: 'https://example.com', text: 'Synthetic' }] });
    await assert.rejects(pending, /abort|cancel|ownership|stale|changed/i);
  } finally { if (previous === undefined) delete process.env.RESUME_INERT_KEY; else process.env.RESUME_INERT_KEY = previous; }
});

test('direct effects beyond cwd hold atomic tool resources, with safe ancestor-call ownership and no sibling exemption', async t => {
  const { root, manager, ctx } = await fixture(t); const record = recordFor(ctx.cwd);
  const direct = await manager.locks!.acquire([{ path: ctx.cwd, mode: 'write' }], true, false, false); assert.ok(direct);
  manager.jobs.set(record.id, { record, rootCallId: 'dispatch', controller: new AbortController(), release: direct, resourceLease: direct });
  t.after(async () => { await direct(); manager.jobs.delete(record.id); });
  const other = new ResourceLocks(manager.locks!.root), target = join(root, 'outside-cwd');
  assert.equal(await manager.guardAndAcquire(call('dispatch/1', 'write', target), ctx), undefined);
  assert.equal(await other.acquire([{ path: target, mode: 'read' }]), undefined);
  await manager.toolEnded('dispatch/1');
  assert.equal(await manager.guardAndAcquire(call('dispatch/2', 'opaque_fixture'), ctx), undefined);
  assert.equal(await other.acquire([{ path: join(root, 'private-stage'), mode: 'write' }]), undefined, 'opaque live effects block new snapshot admission atomically');
  assert.equal(await manager.guardAndAcquire(call('dispatch/2/1', 'read', target), ctx), undefined, 'owning ancestor capability covers the child');
  assert.equal((await manager.guardAndAcquire(call('dispatch/3', 'write', target), ctx))?.block, true, 'sibling cannot inherit another invocation lease');
  assert.equal(await manager.guardAndAcquire(call('foreground-read', 'read', target), ctx), undefined, 'compatibility foreground readers remain available during opaque direct work');
  await manager.toolEnded('foreground-read');
  await manager.toolEnded('dispatch/2');
  const now = await other.acquire([{ path: target, mode: 'write' }]); assert.ok(now); await now();
});

test('captured model/provider definition is revalidated without resolving credentials or silently substituting a new profile', () => {
  const model = { provider: 'synthetic', id: 'captured', api: 'synthetic-api' }, runtime = { id: 'synthetic' };
  const profile = { model, thinking: 'high', providerRuntime: runtime } as Parameters<typeof revalidateProfile>[0];
  let current = model, provider = runtime;
  const ctx = { modelRegistry: { find: () => current, getProvider: () => provider, getApiKeyAndHeaders: () => { throw new Error('Credential resolution is forbidden during preflight'); } } } as unknown as ExtensionContext;
  revalidateProfile(profile, ctx); current = { ...model, api: 'changed' }; assert.throws(() => revalidateProfile(profile, ctx), /definition changed/);
  current = model; provider = { id: 'synthetic' }; assert.throws(() => revalidateProfile(profile, ctx), /definition changed/);
});

test('queued cancel settles even with storage failure and retains an honest once-only in-memory report', async t => {
  const { manager, ctx } = await fixture(t); const record = { ...recordFor(ctx.cwd), status: 'queued' as const, queuedAt: Date.now() - 40000 };
  let finished = false; manager.jobs.set(record.id, { record, controller: new AbortController(), finish: () => { finished = true; } });
  manager.store!.write = async () => { throw new Error('Synthetic storage failure'); };
  assert.equal((await manager.cancel(record.id)).status, 'cancelled'); assert.equal(finished, true);
  assert.equal(record.terminalDiagnostics?.category, 'queue_cancelled');
  const first = await manager.result(record.id); assert.match(JSON.stringify(first), /Queued task cancelled before worker effects started/); assert.match(JSON.stringify(first), /Runtime: 0s/);
  assert.equal((first.details as { reportDurable: boolean }).reportDurable, false); assert.ok(first.usage); assert.equal((await manager.result(record.id)).usage, undefined);
});

test('closed admission rejects new work; aged full lanes wake on release rather than a hot timer', async () => {
  const admission = new Admission(1, 8, 1); const release = await admission.acquire('model'); admission.setForeground(true);
  const pending = admission.acquire('model'); await new Promise(r => setTimeout(r, 15));
  assert.equal((admission as unknown as { timer?: unknown }).timer, undefined); release(); (await pending)(); admission.close(); await assert.rejects(admission.acquire('model'), /stopped/);
});

test('storage ancestor aliases and hardlinked private results fail closed without outside reads, writes or chmod', async t => {
  const { root } = await fixture(t), store = new Store(join(root, 'private-state'), 'synthetic'); await store.init();
  const outside = join(root, 'outside.txt'); await fs.writeFile(outside, 'outside unchanged', { mode: 0o644 });
  await fs.link(outside, store.path('bg-aaaaaaaaaaaa', 'md')); await assert.rejects(store.output('bg-aaaaaaaaaaaa'), /Unsafe/);
  await fs.rename(store.recordsDir, store.recordsDir + '-old'); await fs.symlink(join(root), store.recordsDir);
  await assert.rejects(atomicPrivateWrite(store.path('bg-aaaaaaaaaaaa', 'md'), 'must not escape'));
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside unchanged'); assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
  await assert.rejects(fs.stat(join(root, 'bg-aaaaaaaaaaaa.md')), { code: 'ENOENT' });
});

async function publication(t: test.TestContext) {
  const f = await fixture(t); await fs.writeFile(join(f.ctx.cwd, 'a.txt'), 'base a'); await fs.writeFile(join(f.ctx.cwd, 'b.txt'), 'base b');
  const stage = new Stage('bg-aaaaaaaaaaaa', f.ctx.cwd, join(f.root, 'private-stage'), { inputs: [], outputs: ['a.txt', 'b.txt'] }); await stage.snapshot(); t.after(() => stage.close());
  await stage.file('write', 'a.txt', 'new a'); await stage.file('write', 'b.txt', 'new b'); const manifest = await stage.seal(); return { ...f, stage, manifest };
}

test('rollback refuses an unowned replacement even when its bytes match the published output', async t => {
  const f = await publication(t);
  await assert.rejects(f.stage.publish(f.manager.locks!, f.manifest.hash, undefined, index => {
    if (index === 1) { unlinkSync(join(f.ctx.cwd, 'a.txt')); writeFileSync(join(f.ctx.cwd, 'a.txt'), 'new a'); throw new Error('Synthetic second-file failure'); }
  }), /recovery requires review/);
  assert.equal(await fs.readFile(join(f.ctx.cwd, 'a.txt'), 'utf8'), 'new a'); assert.equal(await fs.readFile(join(f.ctx.cwd, 'b.txt'), 'utf8'), 'base b');
  assert.equal(f.manager.locks!.conflicts([{ path: join(f.ctx.cwd, 'a.txt'), mode: 'read' }], true), true);
});

test('last publication validation catches prepared symlink swaps and locks rollback temps before any destructive effect', async t => {
  const f = await publication(t); const outside = join(f.root, 'outside.txt'); await fs.writeFile(outside, 'outside unchanged', { mode: 0o644 });
  await assert.rejects(f.stage.publish(f.manager.locks!, f.manifest.hash, undefined, index => {
    if (index !== 0) return;
    const journal = JSON.parse(readFileSync(join(f.stage.root, 'recovery', 'journal.json'), 'utf8'));
    assert.equal(f.manager.locks!.conflicts([{ path: join(f.ctx.cwd, journal.rollbackNames['a.txt']), mode: 'write' }]), true);
    const temp = join(f.ctx.cwd, journal.temporaryNames['a.txt']); unlinkSync(temp); symlinkSync(outside, temp);
  }));
  assert.equal(await fs.readFile(join(f.ctx.cwd, 'a.txt'), 'utf8'), 'base a'); assert.equal(await fs.readFile(join(f.ctx.cwd, 'b.txt'), 'utf8'), 'base b');
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside unchanged'); assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
  assert.equal(f.manager.locks!.conflicts([{ path: f.ctx.cwd, mode: 'write' }]), false);
});

test('foreground provider IDs cannot impersonate an owning staged broker or worker web namespace by prefix alone', async t => {
  const f = await publication(t); const record = { ...recordFor(f.ctx.cwd), execution: 'staged' as const };
  f.manager.jobs.set(record.id, { record, stage: f.stage, rootCallId: 'dispatch', controller: new AbortController() });
  t.after(() => f.manager.jobs.delete(record.id));
  const spoof = { type: 'tool_call', toolCallId: 'dispatch/forged', toolName: 'background_stage_file', input: { id: record.id, operation: 'write', path: 'a.txt', content: 'spoof' } } as ToolCallEvent;
  assert.equal(f.manager.guard(spoof, f.ctx)?.block, true);
  assert.equal(f.manager.webScope(spoof.toolCallId, f.ctx), 'synthetic:foreground');
  await assert.rejects(f.manager.stageFile(spoof.toolCallId, spoof.input as never), /owning/);
});
