import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { Stage } from '../src/staging.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackgroundManager } from '../src/manager.ts';
import { emptyUsage } from '../src/types.ts';
import type { RecordData, NormalizedDispatch, Profile } from '../src/types.ts';
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { scratch } from './helpers.ts';

async function fixture(t: TestContext) {
  const root = await scratch('bg-manager-test-');
  const notices: string[] = [], entries: unknown[] = [];
  const pi = { getFlag: () => undefined, getAllTools: () => [], getSettings: () => ({}), events: { emit: () => {} },
    appendEntry: (_kind: string, data: unknown) => entries.push(data),
    sendMessage: (message: { content: string }, options: { deliverAs: string; triggerTurn: boolean }) => { assert.equal(options.deliverAs, 'followUp'); assert.equal(options.triggerTurn, true); notices.push(message.content); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: root, mode: 'rpc', hasUI: false, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => 'fixture', getBranch: () => [] }, ui: { notify: () => {} } } as unknown as ExtensionContext;
  const manager = new BackgroundManager(pi); await manager.init(ctx);
  t.after(async () => { await manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const record: RecordData = { version: 1, id: 'bg-123456abcdef', title: 'Fixture', sessionId: 'fixture', cwd: root, provider: 'fake', model: 'main', thinking: 'high', status: 'running', access: 'write', startedAt: Date.now(), etaSeconds: 30, etaMaxSeconds: 60, estimateReason: 'Original estimate', lastActivityAt: Date.now(), toolCalls: 0, turns: 0, usage: emptyUsage(), usageReported: false, notification: 'read', overrunNotified: false };
  return { root, manager, notices, entries, record, ctx };
}

test('ETA revision is remaining duration plus elapsed time, not a reset deadline', async t => {
  const f = await fixture(t); f.record.startedAt = Date.now() - 30_000;
  f.manager.jobs.set(f.record.id, { record: f.record, controller: new AbortController() });
  const revised = await f.manager.updateEta(f.record.id, 120, 180, 'Testing discovered an additional required pass.');
  assert.ok(revised.etaSeconds >= 150 && revised.etaSeconds <= 151); assert.ok(revised.etaMaxSeconds >= 210 && revised.etaMaxSeconds <= 211);
  assert.equal(f.notices.length, 1); assert.match(f.notices[0]!, /remaining/);
  await assert.rejects(f.manager.updateEta(f.record.id, 180, 120, 'Invalid range'));
  await assert.rejects(f.manager.updateEta(f.record.id, 100, undefined, '  '));
});
test('overdue notifications occur once per estimate and never invent a replacement ETA', async t => {
  const f = await fixture(t); f.record.startedAt = Date.now() - 100_000;
  f.manager.jobs.set(f.record.id, { record: f.record, controller: new AbortController() });
  await f.manager.monitor(); await f.manager.monitor();
  assert.equal(f.notices.length, 1); assert.match(f.notices[0]!, /no replacement ETA is known/);
  await f.manager.updateEta(f.record.id, 30, 60, 'Additional verification');
  assert.equal(f.record.overrunNotified, false); await f.manager.monitor(); assert.equal(f.notices.length, 2);
});
test('cancellation is cooperative and idempotent, and late nested calls are blocked', async t => {
  const f = await fixture(t); const controller = new AbortController();
  f.manager.jobs.set(f.record.id, { record: f.record, controller, rootCallId: 'dispatch' });
  assert.equal((await f.manager.cancel(f.record.id)).status, 'cancelling'); assert.equal(controller.signal.aborted, true);
  assert.equal((await f.manager.cancel(f.record.id)).status, 'cancelling');
  const event = { type: 'tool_call', toolCallId: 'dispatch/1', toolName: 'write', input: { path: 'file' } } as ToolCallEvent;
  assert.equal(f.manager.guard(event, f.ctx)?.block, true);
});
test('result pagination reports usage only once and accounts nothing during settlement', async t => {
  const f = await fixture(t); f.record.status = 'completed'; f.record.usage.totalTokens = 42;
  const job = { record: f.record, settling: true }; f.manager.jobs.set(f.record.id, job);
  await f.manager.store!.write(f.record, 'A'.repeat(30_000));
  const pending = await f.manager.result(f.record.id); assert.equal(pending.usage, undefined); assert.equal(f.record.usageReported, false);
  job.settling = false;
  const first = await f.manager.result(f.record.id, 0, 100); assert.equal(first.usage!.totalTokens, 42); assert.match(first.content[0]!.type === 'text' ? first.content[0]!.text : '', /offset 100/);
  const second = await f.manager.result(f.record.id, 100, 100); assert.equal(second.usage, undefined);
  await assert.rejects(f.manager.result(f.record.id, -1)); await assert.rejects(f.manager.result(f.record.id, 0, 24001));
});
test('completion notification waits for durable output and is queued only once', async t => {
  const f = await fixture(t); f.record.status = 'completed'; f.record.notification = 'pending';
  const job = { record: f.record, settling: true }; f.manager.jobs.set(f.record.id, job);
  const flush = () => (f.manager as unknown as { flushNotifications(): Promise<void> }).flushNotifications();
  f.manager.scheduleNotifications(); await flush(); assert.equal(f.notices.length, 0);
  await f.manager.store!.write(f.record, 'Verified output'); job.settling = false;
  f.manager.scheduleNotifications(); await flush();
  assert.equal(f.notices.length, 1); assert.equal(f.record.notification, 'queued');
  f.manager.scheduleNotifications(); await flush(); assert.equal(f.notices.length, 1);
});
test('automatic-routing switch is persistent, and finished/unknown tasks cannot be revised', async t => {
  const f = await fixture(t); f.manager.setAuto(false); assert.equal(f.manager.auto, false); assert.deepEqual(f.entries.at(-1), { enabled: false });
  f.record.status = 'completed'; f.manager.jobs.set(f.record.id, { record: f.record });
  await assert.rejects(f.manager.updateEta(f.record.id, 10, undefined, 'Late revision'), /finished/);
  assert.throws(() => f.manager.get('bg-000000000000'), /Unknown/);
});

test('completion persists its reservation before routing, retries only failed storage and never falls back after revoked ownership', async t => {
  const f = await fixture(t); f.record.status = 'completed'; f.record.notification = 'pending';
  let calls = 0; let storedBeforeRoute = false;
  f.manager.jobs.set(f.record.id, { record: f.record, noticeRouter: () => {
    calls++; storedBeforeRoute = f.record.notification === 'queued'; return false;
  } });
  const write = f.manager.store!.write.bind(f.manager.store);
  f.manager.store!.write = async () => { throw new Error('Synthetic storage unavailable'); };
  f.manager.scheduleNotifications(); await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 0); assert.equal(f.record.notification, 'pending');
  f.manager.store!.write = write;
  f.manager.scheduleNotifications(); await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 1); assert.equal(storedBeforeRoute, true); assert.equal(f.record.notification, 'queued');
  assert.equal(f.notices.length, 0, 'revoked transport ownership cannot fall back to ambient main chat');
  f.manager.scheduleNotifications(); await new Promise(r => setTimeout(r, 20)); assert.equal(calls, 1);
});

test('unowned TUI/RPC notices wait for idle and pending messages before starting a separate report turn', async t => {
  const f = await fixture(t); f.record.status = 'completed'; f.record.notification = 'pending';
  f.manager.jobs.set(f.record.id, { record: f.record });
  let idle = false, pending = false;
  f.ctx.isIdle = () => idle; f.ctx.hasPendingMessages = () => pending;
  f.manager.scheduleNotifications(); await new Promise(r => setTimeout(r, 20)); assert.equal(f.notices.length, 0);
  idle = true; pending = true;
  f.manager.scheduleNotifications(); await new Promise(r => setTimeout(r, 20)); assert.equal(f.notices.length, 0);
  pending = false;
  f.manager.scheduleNotifications(); await new Promise(r => setTimeout(r, 20)); assert.equal(f.notices.length, 1);
});

test('foreground live reads hold shared resources through tool completion; unrelated safe web never waits on publication', async t => {
  const f = await fixture(t); const source = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  f.manager.pi.getAllTools = (() => ['read', 'write', 'background_web_search'].map(name => ({ name, exposure: 'direct', sourceInfo: { path: name === 'background_web_search' ? source : `builtin:${name}` } }))) as ExtensionAPI['getAllTools'];
  const path = join(f.root, 'file.txt'); await fs.writeFile(path, 'base'); const stage = new Stage('bg-aaaaaaaaaaaa', f.root, join(f.root, 'stage'), { inputs: [], outputs: ['file.txt'] }); await stage.snapshot(); t.after(() => stage.close()); await stage.file('write', 'file.txt', 'published'); const manifest = await stage.seal();
  const event = { type: 'tool_call', toolCallId: 'foreground-read', toolName: 'read', input: { path } } as ToolCallEvent;
  assert.equal(await f.manager.guardAndAcquire(event, f.ctx), undefined);
  await assert.rejects(stage.publish(f.manager.locks!, manifest.hash), /resources are busy/); assert.equal(await fs.readFile(path, 'utf8'), 'base');
  await f.manager.toolEnded(event.toolCallId);
  const held = await f.manager.locks!.acquire([{ path, mode: 'write' }], true); assert.ok(held);
  assert.equal((await f.manager.guardAndAcquire({ ...event, toolCallId: 'blocked-read' }, f.ctx))?.block, true);
  const start = performance.now(); assert.equal(await f.manager.guardAndAcquire({ type: 'tool_call', toolCallId: 'web', toolName: 'background_web_search', input: { query: 'synthetic fixture' } } as ToolCallEvent, f.ctx), undefined); assert.ok(performance.now() - start < 100);
  await held(); await stage.publish(f.manager.locks!, manifest.hash); assert.equal(await fs.readFile(path, 'utf8'), 'published');
});

test('an aged conflicting task prevents younger compatible stages from perpetually refilling capacity, without preempting live work', async t => {
  const f = await fixture(t); const privateRoot = join(f.root, 'live-stage'); const held = await f.manager.locks!.acquire([{ path: privateRoot, mode: 'write' }]); assert.ok(held);
  const live = { ...f.record, id: 'bg-aaaaaaaaaaaa', execution: 'staged' as const }; f.manager.jobs.set(live.id, { record: live, release: held });
  const started: string[] = []; const ctx = { ...f.ctx, modelRegistry: { find: () => ({}) }, executeTool: async (_name: string, args: { id: string }) => { started.push(args.id); return { isError: false, result: { content: [{ type: 'text', text: 'Synthetic approval' }], details: undefined } }; } };
  const profile = { model: {}, thinking: 'off' } as Profile;
  const dispatch = { task: 'Synthetic scheduler fixture', title: 'Fixture', eta_seconds: 300, eta_max_seconds: 300, estimate_reason: 'Fixture', mode: 'manual', access: 'write', context_mode: 'brief', execution: 'direct' } as NormalizedDispatch;
  const old = { ...f.record, id: 'bg-bbbbbbbbbbbb', status: 'queued' as const, execution: 'direct' as const, queuedAt: Date.now() - 40000 };
  const young = { ...f.record, id: 'bg-cccccccccccc', status: 'queued' as const, execution: 'staged' as const, queuedAt: Date.now() };
  f.manager.jobs.set(old.id, { record: old, ctx: ctx as never, controller: new AbortController(), pending: { dispatch, profile } });
  f.manager.jobs.set(young.id, { record: young, ctx: ctx as never, controller: new AbortController(), pending: { dispatch: { ...dispatch, execution: 'staged', stage: { inputs: [], outputs: ['file.txt'] } }, profile } });
  await (f.manager as unknown as { pumpQueue(): Promise<void> }).pumpQueue();
  assert.equal(old.status, 'queued'); assert.equal(young.status, 'queued'); assert.equal(young.waitingReason, 'resources'); assert.deepEqual(started, [old.id]); assert.equal(live.status, 'running');
  await f.manager.cancel(old.id); await f.manager.cancel(young.id); await held(); f.manager.jobs.delete(live.id);
});
