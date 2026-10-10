import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Store } from '../src/store.ts';
import { BackgroundManager } from '../src/manager.ts';
import { emptyUsage } from '../src/types.ts';
import type { RecordData } from '../src/types.ts';
import { scratch } from './helpers.ts';

const SECRET = 'UNTRUSTED_DIAGNOSTICS_SECRET_EXCLUDED';
const data = (): RecordData => ({ version: 1, id: 'bg-abcdef123456', title: 'Restored work', sessionId: 'parent', cwd: '/fixture',
  provider: 'inert', model: 'synthetic', thinking: 'high', status: 'running', access: 'write', startedAt: 1000,
  etaSeconds: 30, etaMaxSeconds: 60, estimateReason: 'Offline fixture', lastActivityAt: 1000, lastTool: 'write',
  toolCalls: 4, turns: 3, usage: emptyUsage(), usageReported: false, notification: 'read', overrunNotified: false });
async function fixture(t: TestContext) {
  const root = await scratch('bg-restore-report-test-');
  const store = new Store(join(root, 'state'), 'parent'); await store.init();
  t.after(() => fs.rm(root, { recursive: true, force: true })); return { root, store };
}

test('legacy interrupted task gets durable standalone fallback even if a stale partial file exists', async t => {
  const { store } = await fixture(t); await store.write(data(), 'Old partial prose, not a settled report.');
  const records = await store.restore(); const report = await store.output(records[0]!.id);
  assert.equal(records[0]!.status, 'interrupted'); assert.equal(records[0]!.contextMode, undefined);
  assert.match(report, /exact terminal reason is unavailable/); assert.match(report, /outcome: not recorded/);
  assert.match(report, /tool calls: 4; assistant turns: 3/); assert.match(report, /does NOT verify/);
  assert.doesNotMatch(report, /Old partial prose/);
  assert.equal(await store.output((await store.restore())[0]!.id), report, 'restore does not replay or rebuild a settled report');
});
for (const status of ['completed', 'failed', 'cancelled'] as const) test(`missing legacy ${status} report is recovered without inventing verified completion`, async t => {
  const { store } = await fixture(t); await store.write({ ...data(), status, finishedAt: 5000 });
  const r = (await store.restore())[0]!;
  assert.equal(r.status, status === 'completed' ? 'failed' : status);
  assert.equal(r.reportSource, 'fallback'); assert.equal(r.terminalDiagnostics!.category, 'missing_report');
  const report = await store.output(r.id); assert.match(report, /No usable final assistant report/); assert.match(report, /does NOT verify/);
});

test('restore write failure returns an interrupted in-memory fallback without claiming durability or replaying effects', async t => {
  const { store } = await fixture(t); await store.write(data());
  store.write = async () => { throw new Error(SECRET); };
  const r = (await store.restore())[0]!;
  assert.equal(r.status, 'interrupted'); const report = store.recoveryReports.get(r.id)!;
  assert.ok(report.length < 4000); assert.match(report, /Storage failure/); assert.match(report, /only in this process/);
  assert.doesNotMatch(report + JSON.stringify(r), new RegExp(SECRET));
  const original = JSON.parse(await fs.readFile(store.path(r.id, 'json'), 'utf8'));
  assert.equal(original.status, 'running', 'failed persistence is not presented as a durable interruption record');
  await assert.rejects(store.output(r.id), { code: 'ENOENT' });
});
test('restore unreadable output does not claim a durable recovery', async t => {
  const { store } = await fixture(t); await store.write(data());
  store.output = async () => { throw Object.assign(new Error(SECRET), { code: 'EACCES' }); };
  const r = (await store.restore())[0]!;
  assert.equal(r.status, 'interrupted'); assert.match(store.recoveryReports.get(r.id)!, /Storage failure/);
});
test('unsafe restored result symlink is still rejected without reading its target', async t => {
  const { root, store } = await fixture(t); await store.write(data());
  const privateFile = join(root, 'private'); await fs.writeFile(privateFile, SECRET);
  await fs.symlink(privateFile, store.path(data().id, 'md'));
  await assert.rejects(store.restore()); assert.equal(await fs.readFile(privateFile, 'utf8'), SECRET);
});
test('sanitization projects diagnostics and metadata rather than storing unknown payloads, strings or invalid counters', async t => {
  const { store } = await fixture(t);
  const bad = { ...data(), status: 'failed', error: SECRET, lastTool: SECRET, toolCalls: SECRET, turns: Infinity,
    providerPayload: { secret: SECRET }, headers: { authorization: SECRET },
    terminalDiagnostics: { stopReason: SECRET, category: SECRET, lastPhase: SECRET, failurePhase: SECRET,
      visibleTextCharacters: SECRET, hadToolCalls: SECRET, lastToolOutcome: SECRET, errorMessage: SECRET,
      diagnostics: [{ secret: SECRET }], reasoning: SECRET, arguments: { secret: SECRET }, result: SECRET },
    reportSource: SECRET,
  } as unknown as RecordData;
  await store.write(bad);
  const json = await fs.readFile(store.path(bad.id, 'json'), 'utf8'); assert.doesNotMatch(json, new RegExp(SECRET));
  const r = (await store.restore())[0]!; const report = await store.output(r.id);
  assert.equal(r.toolCalls, 0); assert.equal(r.turns, 0); assert.equal(r.lastTool, 'other');
  assert.equal(r.terminalDiagnostics!.category, 'unknown');
  assert.doesNotMatch(report + JSON.stringify(r), new RegExp(SECRET));
});
test('restored new terminal fields are optional for v1 and sanitized before result envelopes', async t => {
  const { store } = await fixture(t);
  await store.write({ ...data(), status: 'failed' }, 'Already saved final visible output.');
  const json = JSON.parse(await fs.readFile(store.path(data().id, 'json'), 'utf8'));
  json.terminalDiagnostics = { stopReason: 'error', category: SECRET, lastPhase: 'requesting', visibleTextCharacters: -1,
    hadToolCalls: false, diagnostics: [SECRET], headers: { secret: SECRET } };
  json.error = SECRET; json.secret = SECRET;
  await fs.writeFile(store.path(data().id, 'json'), JSON.stringify(json));
  const r = (await store.restore())[0]!;
  assert.equal(r.terminalDiagnostics!.category, 'unknown'); assert.equal(r.terminalDiagnostics!.visibleTextCharacters, 0);
  assert.equal(r.reportSource, undefined); assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});
test('legacy lease diagnostics survive as historical evidence without resource wait reasons or current ownership claims', async t => {
  const { store } = await fixture(t);
  const legacy = { ...data(), status: 'failed', finishedAt: 5000, waitingReason: 'resources', error: 'Writer lease cleanup failed. Inspect runtime storage before starting another writer.',
    terminalDiagnostics: { stopReason: 'stop', category: 'lease_cleanup_error', lastPhase: 'finalizing', visibleTextCharacters: 0, hadToolCalls: false, leaseCleanupFailed: true } } as unknown as RecordData;
  await store.write(legacy);
  const restored = (await store.restore())[0]!; const report = await store.output(restored.id);
  assert.equal(restored.waitingReason, undefined); assert.equal(restored.terminalDiagnostics!.leaseCleanupFailed, true);
  assert.equal(restored.terminalDiagnostics!.category, 'lease_cleanup_error'); assert.match(restored.error!, /legacy runtime/);
  assert.match(report, /does not impose a current workflow lock/); assert.doesNotMatch(report, /ownership may still be reserved|before starting another writer/);
  assert.equal('acquireWriter' in store, false);
});

test('manager retains restored storage failure for explicit retrieval and suppresses settlement reservation', async t => {
  const { root, store } = await fixture(t); await store.write(data());
  // A directory at the output path produces EISDIR without global permission manipulation.
  await fs.mkdir(store.path(data().id, 'md'));
  const notices: string[] = [], warnings: string[] = [];
  const pi = { getFlag: (name: string) => name === 'background-dir' ? store.root : undefined,
    appendEntry: () => {}, events: { emit: () => {} }, sendMessage: (m: { content: string }) => notices.push(m.content),
  } as unknown as ExtensionAPI;
  const ctx = { cwd: root, mode: 'rpc', hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'parent', getBranch: () => [] }, ui: { notify: (m: string) => warnings.push(m) },
  } as unknown as ExtensionContext;
  const manager = new BackgroundManager(pi); manager.scheduleNotifications = () => {}; await manager.init(ctx);
  t.after(() => manager.shutdown());
  const result = await manager.result(data().id); assert.ok(result.usage);
  assert.equal((result.details as { reportDurable: boolean }).reportDurable, false);
  assert.match(JSON.stringify(result.content), /Storage failure/);
  await (manager as unknown as { flushNotifications(): Promise<void> }).flushNotifications();
  assert.equal(notices.length, 0); assert.ok(warnings.some(m => m.includes('could not be saved')));
  assert.equal((await manager.result(data().id)).usage, undefined);
});
