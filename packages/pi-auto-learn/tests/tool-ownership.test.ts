import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import autoLearn from '../src/index.ts';
import { Learner } from '../src/learner.ts';
import { fixture, addSkill } from './helpers.ts';
import { join } from 'node:path';

// Real registrations and library/state, synthetic host events only. SDK coverage is
// separate; this fixture makes sparse/late/cancelled boundaries deterministic.
async function host(t: test.TestContext) {
  const f = await fixture(t, false); await addSkill(f.root, 'foreground-skill'); await addSkill(f.root, 'worker-skill');
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const pi: any = { events: createEventBus(), registerFlag() {}, getFlag: (name: string) => ({ 'auto-learn-root': f.root, 'auto-learn-state': f.state, 'auto-learn-no-advertise': true } as any)[name],
    sendMessage() {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), getSettings: () => ({}),
    on: (name: string, fn: Function) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); } };
  let sessionId = 'test-session'; let branch: any[] = [];
  const ctx: any = { cwd: f.base, mode: 'print', hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: { streamSimple() { throw Error('provider must not run'); } }, sessionManager: { getSessionId: () => sessionId, getBranch: () => branch }, ui: { setStatus() {}, notify() {} } };
  const observations: any[] = [], original = Learner.prototype.observe;
  Learner.prototype.observe = async function(s, entry, evidence, used) { observations.push({ session: s, entry, evidence, used }); };
  const emit = async (name: string, data: object = {}) => { for (const fn of handlers.get(name) ?? []) await fn(data, ctx); };
  autoLearn(pi); await emit('session_start');
  t.after(async () => { await emit('session_shutdown'); Learner.prototype.observe = original; });
  const begin = async (id: string, source = 'rpc') => {
    const text = `Please verify the repeatable synthetic workflow ${id}.`;
    branch = [{ type: 'message', id, message: { role: 'user', content: text } }, { type: 'message', id: `${id}-reply`, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } }];
    await emit('input', { text, source }); await emit('message_start', { message: branch[0].message }); await emit('agent_start');
  };
  const settle = async (outcome = 'completed') => { await emit('agent_before_settle', { outcome }); await emit('agent_settled'); await commands.get('auto-learn').handler('status', ctx); };
  const start = (id: string, name: string, parent?: string, skill?: string) => emit('tool_execution_start', { toolCallId: id, toolName: name, parentToolCallId: parent, args: skill ? { path: join(f.root, skill, 'SKILL.md') } : {} });
  const end = (id: string, name: string, error = false) => emit('tool_execution_end', { toolCallId: id, toolName: name, isError: error });
  const worker = (type: string, taskId = 'bg-123456abcdef', rootCallId = 'dispatch', status = 'completed') => pi.events.emit('background-tasks:telemetry:v1', { version: 1, type, taskId, rootCallId, sessionId, status });
  const status = async () => JSON.parse((await tools.get('auto_learn_status').execute('', { action: 'status' })).content[0].text);
  return { ...f, emit, begin, settle, start, end, worker, observations, status, switchSession: (s: string) => { sessionId = s; } };
}
test('worker skills/failures stay task-tagged while legitimate foreground nested evidence is retained', async t => {
  const f = await host(t); await f.begin('first');
  await f.start('dispatch', 'background_dispatch'); f.worker('worker-queued'); await f.end('dispatch', 'background_dispatch');
  await f.settle(); await f.begin('unrelated'); f.worker('worker-start');
  await f.start('worker-read', 'read', 'dispatch', 'worker-skill'); await f.end('worker-read', 'read');
  await f.start('worker-shell', 'edit', 'dispatch'); await f.end('worker-shell', 'edit', true);
  await f.start('orchestrator', 'ordinary_orchestrator'); await f.start('nested-read', 'read', 'orchestrator', 'foreground-skill'); await f.end('nested-read', 'read');
  await f.start('nested-shell', 'bash', 'orchestrator'); await f.end('nested-shell', 'bash', true); await f.end('orchestrator', 'ordinary_orchestrator');
  f.worker('worker-end'); await f.settle();
  assert.deepEqual(f.observations[1].used, ['foreground-skill']);
  assert.deepEqual(f.observations[1].evidence.used, ['foreground-skill']);
  assert.deepEqual(f.observations[1].evidence.failures, ['bash: failed']);
  const task = (await f.status()).taskEvidence[0];
  assert.equal(task.taskId, 'bg-123456abcdef'); assert.equal(task.status, 'completed');
  assert.deepEqual(task.used, ['worker-skill']); assert.deepEqual(task.failures, ['edit: failed']);
  assert.equal(task.automaticLearning, false);
});
test('late, sparse, cancelled, unpaired and replaced-session tools never borrow a new activity', async t => {
  const f = await host(t); await f.begin('old');
  await f.start('late-read', 'read', undefined, 'worker-skill'); await f.settle('aborted');
  await f.begin('new'); await f.end('late-read', 'read'); await f.end('unpaired-error', 'bash', true);
  await f.start('dispatch', 'background_dispatch'); f.worker('worker-queued'); await f.end('dispatch', 'background_dispatch');
  f.worker('worker-end', undefined, undefined, 'cancelled');
  await f.start('late-worker-read', 'read', 'dispatch', 'worker-skill'); await f.end('late-worker-read', 'read');
  await f.settle(); assert.deepEqual(f.observations.at(-1).used, []); assert.deepEqual(f.observations.at(-1).evidence.failures, []);
  assert.equal((await f.status()).taskEvidence[0].status, 'cancelled'); assert.deepEqual((await f.status()).taskEvidence[0].used, []);
  await f.emit('session_before_switch'); f.switchSession('replacement'); await f.begin('replacement');
  f.worker('worker-start'); await f.start('unknown-nested', 'read', 'dispatch', 'worker-skill'); await f.end('unknown-nested', 'read');
  await f.settle(); assert.deepEqual(f.observations.at(-1).used, []); assert.deepEqual((await f.status()).taskEvidence, []);
});
test('provider-issued prefixes confer no worker authority; unknown ancestry and reused IDs fail closed', async t => {
  const f = await host(t); await f.begin('prefixes');
  await f.start('dispatch', 'background_dispatch'); f.worker('worker-start'); await f.end('dispatch', 'background_dispatch');
  await f.start('dispatch/looks-like-worker', 'read', undefined, 'foreground-skill'); await f.end('dispatch/looks-like-worker', 'read');
  await f.start('forged-parent-child', 'read', 'dispatch/never-started', 'worker-skill'); await f.end('forged-parent-child', 'read');
  await f.start('reused', 'read', undefined, 'worker-skill'); await f.start('reused', 'read', undefined, 'worker-skill'); await f.end('reused', 'read');
  f.worker('worker-end'); await f.settle();
  assert.deepEqual(f.observations[0].used, ['foreground-skill']); assert.deepEqual((await f.status()).taskEvidence[0].used, []);
});
test('missing or capacity-limited worker telemetry cannot fall back to foreground ownership', async t => {
  const f = await host(t); await f.begin('bounded');
  await f.start('unannounced', 'background_dispatch');
  await f.start('unannounced-read', 'read', 'unannounced', 'worker-skill'); await f.end('unannounced-read', 'read');
  for (let i = 0; i < 129; i++) {
    const root = `dispatch-${i}`, task = `bg-${i.toString(16).padStart(12, '0')}`;
    await f.start(root, 'background_dispatch'); f.worker('worker-start', task, root); await f.end(root, 'background_dispatch');
  }
  await f.start('overflow-read', 'read', 'dispatch-128', 'worker-skill'); await f.end('overflow-read', 'read');
  await f.start('overflow-error', 'bash', 'dispatch-128'); await f.end('overflow-error', 'bash', true);
  await f.settle(); assert.deepEqual(f.observations[0].used, []); assert.deepEqual(f.observations[0].evidence.failures, []);
  const status = await f.status();
  assert.equal(status.taskEvidenceCount, 128); assert.equal(status.taskEvidence.length, 10); assert.equal(status.taskEvidenceTruncated, true);
});
test('generic extension and notification activity cannot admit worker evidence, even with foreground later admitted', async t => {
  const f = await host(t); await f.begin('guest', 'extension');
  await f.start('dispatch', 'background_dispatch'); f.worker('worker-start'); await f.end('dispatch', 'background_dispatch');
  await f.start('guest-error', 'bash', 'dispatch'); await f.end('guest-error', 'bash', true); f.worker('worker-end'); await f.settle();
  await f.begin('human'); await f.settle(); assert.deepEqual((await f.status()).taskEvidence, []);
});
