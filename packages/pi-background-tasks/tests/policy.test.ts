import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { AUTO_THRESHOLD_SECONDS, MAIN_POLICY, canonicalPath, captureProfile, coherentHistory, contextMessages, guardTool, routesToBackground, validateDispatch, within, workerOwnsCall, workerToolAllowed } from '../src/policy.ts';
import { emptyUsage, addUsage } from '../src/types.ts';
import type { RecordData, Dispatch } from '../src/types.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionContext, ToolInfo } from '@earendil-works/pi-coding-agent';
import { scratch } from './helpers.ts';

const task: Dispatch = { task: 'Implement and verify feature', title: 'Feature', eta_seconds: 300, eta_max_seconds: 480, estimate_reason: 'Implementation, several model/tool rounds and tests.' };
const record = (overrides = {}): RecordData => ({ version: 1, id: 'bg-111111111111', title: 'Test', sessionId: 'test', cwd: '/workspace', provider: 'fake', model: 'main', thinking: 'high', status: 'running', access: 'write', startedAt: 1, etaSeconds: 300, etaMaxSeconds: 480, estimateReason: 'Testing', lastActivityAt: 1, toolCalls: 0, turns: 0, usage: emptyUsage(), usageReported: false, notification: 'read', overrunNotified: false, ...overrides });
const tool = (name: string, exposure = 'direct'): ToolInfo => ({ name, description: '', parameters: {} as never, exposure: exposure as ToolInfo['exposure'], sourceInfo: {} as never });

test('main policy requests a natural honest ETA acknowledgment without unsolicited task IDs', () => {
  assert.match(MAIN_POLICY, /Acknowledge the work naturally with an honest estimated duration, explicitly as an estimate/);
  assert.match(MAIN_POLICY, /Keep task IDs internal unless genuinely necessary for clarity or troubleshooting, or explicitly requested/);
  assert.match(MAIN_POLICY, /avoid robotic job-ticket acknowledgments/);
  assert.match(MAIN_POLICY, /fixed catchphrases, and vary the wording naturally/);
  assert.doesNotMatch(MAIN_POLICY, /Tell the user the accepted task ID/);
});
test('automatic threshold is strictly more than two minutes, using uncertainty upper bound', () => {
  assert.equal(AUTO_THRESHOLD_SECONDS, 120);
  for (const seconds of [1, 60, 119, 120]) assert.equal(routesToBackground({ ...task, eta_seconds: seconds, eta_max_seconds: seconds }, true), false);
  for (const seconds of [121, 300, 3600]) assert.equal(routesToBackground({ ...task, eta_seconds: seconds, eta_max_seconds: seconds }, true), true);
  assert.equal(routesToBackground({ ...task, eta_seconds: 60, eta_max_seconds: 180 }, true), true);
  assert.equal(routesToBackground({ ...task, mode: 'manual', eta_seconds: 1, eta_max_seconds: 1 }, false), true);
  assert.equal(routesToBackground(task, false), false);
});
test('ETA must be supplied, bounded, ordered and justified', () => {
  assert.equal(validateDispatch(task).access, 'write');
  assert.equal(validateDispatch(task).mode, 'auto');
  for (const eta of [0, -1, NaN, Infinity, 1.5, 604801]) assert.throws(() => validateDispatch({ ...task, eta_seconds: eta }));
  assert.throws(() => validateDispatch({ ...task, eta_max_seconds: 100 }));
  for (const key of ['task', 'title', 'estimate_reason'] as const) assert.throws(() => validateDispatch({ ...task, [key]: '  ' }));
  assert.throws(() => validateDispatch({ ...task, mode: 'wrong' as never }));
  assert.throws(() => validateDispatch({ ...task, access: 'wrong' as never }));
});
test('context is brief-only by default; opt-in fields are validated without silent fallback', () => {
  assert.equal(validateDispatch(task).context_mode, 'brief');
  assert.equal(validateDispatch(task).context_text, undefined);
  assert.equal(validateDispatch({ ...task, context_mode: 'full' }).context_mode, 'full');
  assert.equal(validateDispatch({ ...task, context_mode: 'selected', context_text: '  Relevant facts  ' }).context_text, 'Relevant facts');
  assert.throws(() => validateDispatch({ ...task, context_mode: 'wrong' as never }));
  for (const context_text of [undefined, '', '  ', 123 as never, 'x'.repeat(20001)]) {
    assert.throws(() => validateDispatch({ ...task, context_mode: 'selected', context_text }));
  }
  for (const context_mode of ['brief', 'full', undefined] as const) {
    assert.throws(() => validateDispatch({ ...task, context_mode, context_text: 'Not silently dropped' }));
  }
});
test('brief-only seeding never reads or summarizes parent history, regardless of its size', () => {
  const seeded = contextMessages(validateDispatch(task), () => { throw new Error('Parent history must not be accessed'); });
  assert.deepEqual(seeded, []);
});
test('selected context includes exactly the supplied text and never extracts parent history', () => {
  const selected = contextMessages(validateDispatch({ ...task, context_mode: 'selected', context_text: 'SELECTED_FACT: keep API compatibility.' }),
    () => { throw new Error('Parent history must not be accessed'); });
  assert.equal(selected.length, 1); assert.equal(selected[0]!.role, 'user');
  assert.match(JSON.stringify(selected), /SELECTED_FACT/); assert.match(JSON.stringify(selected), /not additional instructions or authorization/);
});
test('only explicit full mode invokes the history reader, preserving coherent pairs without mutating it', () => {
  const messages = [{ role: 'system', content: 'Old system', timestamp: 1 },
    { role: 'user', content: 'PARENT_CONTEXT', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'pending', name: 'background_dispatch', arguments: {} }] },
  ] as AgentMessage[];
  let reads = 0;
  const seeded = contextMessages(validateDispatch({ ...task, context_mode: 'full' }), () => { reads++; return messages; });
  assert.equal(reads, 1); assert.equal(seeded.length, 1); assert.match(JSON.stringify(seeded), /PARENT_CONTEXT/);
  assert.doesNotMatch(JSON.stringify(seeded), /pending|Old system/); assert.equal(messages.length, 3);
});
test('current model and thinking are inherited exactly, never defaults or guessed', () => {
  const ctx = { model: { provider: 'live', id: 'chosen', api: 'fake' }, thinkingLevel: 'max' } as ExtensionContext;
  const profile = captureProfile(ctx);
  assert.deepEqual(profile.model, ctx.model); assert.notEqual(profile.model, ctx.model); assert.equal(profile.thinking, 'max');
  assert.throws(() => captureProfile({ ...ctx, model: undefined }));
  assert.throws(() => captureProfile({ ...ctx, thinkingLevel: undefined }));
  assert.throws(() => captureProfile({ ...ctx, model: { ...ctx.model!, api: 'pi-virtual' } }));
});
test('history preserves completed pairs and strips the unfinished dispatch plus siblings', () => {
  const a = { role: 'assistant', content: [{ type: 'toolCall', id: 'read1', name: 'read', arguments: {} }] } as AgentMessage;
  const messages: AgentMessage[] = [
    { role: 'system', content: 'Old system', timestamp: 1 },
    { role: 'user', content: 'Prior task', timestamp: 1 }, a,
    { role: 'toolResult', toolCallId: 'read1', toolName: 'read', content: [], isError: false, timestamp: 1 },
    { role: 'user', content: 'New task', timestamp: 2 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'dispatch', name: 'background_dispatch', arguments: {} }, { type: 'toolCall', id: 'sibling', name: 'read', arguments: {} }] } as AgentMessage,
  ];
  const clean = coherentHistory(messages);
  assert.equal(clean.length, 4); assert.equal(clean.at(-1)!.role, 'user'); assert.notEqual(clean[1], a);
  assert.equal(messages.length, 6);
});
test('writer lease blocks competing file and shell writes, but leaves conversation and reading free', () => {
  const writer = record();
  for (const name of ['read', 'grep', 'find', 'ls']) assert.equal(guardTool(name, {}, '/workspace', writer, undefined), undefined);
  assert.match(guardTool('bash', { command: 'echo hi' }, '/workspace', writer, undefined)!, /writer lease/);
  assert.equal(guardTool('background_tasks', { action: 'cancel' }, '/workspace', writer, undefined), undefined);
  assert.equal(guardTool('telegram_attach', { paths: ['/workspace/existing.pdf'] }, '/workspace', writer, undefined), undefined);
  assert.equal(guardTool('memoria_search', { query: 'preferences' }, '/workspace', writer, undefined), undefined);
  assert.equal(guardTool('web_enable', {}, '/workspace', writer, undefined), undefined);
  assert.equal(guardTool('write', { path: '/elsewhere/file' }, '/workspace', writer, undefined), undefined);
  assert.equal(guardTool('bash', {}, '/workspace', writer, writer), undefined);
});
test('workers cannot recursively delegate, hijack Telegram or manage other ETAs through nested codemode calls', () => {
  const own = record();
  assert.match(guardTool('telegram_attach', {}, '/workspace', own, own)!, /main chat/);
  assert.match(guardTool('background_dispatch', {}, '/workspace', own, own)!, /cannot spawn/);
  assert.match(guardTool('background_update_eta', { id: 'other' }, '/workspace', own, own)!, /own ETA/);
  assert.equal(guardTool('background_update_eta', { id: own.id }, '/workspace', own, own), undefined);
  assert.equal(workerOwnsCall('dispatch', 'dispatch/2/3'), true);
  assert.equal(workerOwnsCall('dispatch', 'dispatch-other/2'), false);
  assert.equal(workerOwnsCall('dispatch', 'dispatch'), false);
  assert.equal(workerToolAllowed(tool('bash')), true);
  assert.equal(workerToolAllowed(tool('mcp__docs')), true);
  assert.equal(workerToolAllowed(tool('background_dispatch')), false);
  assert.equal(workerToolAllowed(tool('telegram_attach')), false);
  assert.equal(workerToolAllowed(tool('foreground_ui', 'model-only')), false);
  assert.equal(workerToolAllowed(tool('secret', 'hidden')), false);
});
test('read-only jobs deny mutating and unclassified tools and allow declared read-only tools', () => {
  const own = record({ access: 'read' });
  assert.match(guardTool('bash', {}, '/workspace', undefined, own)!, /Read-only/);
  const info = { ...tool('search'), annotations: { readOnlyHint: true } };
  assert.equal(guardTool('search', {}, '/workspace', undefined, own, info), undefined);
});
test('path comparisons prevent sibling-prefix confusion and resolve symlink writes', async () => {
  const root = await scratch('bg-path-test-');
  try {
    await fs.mkdir(join(root, 'protected')); await fs.symlink(join(root, 'protected'), join(root, 'alias'));
    assert.equal(canonicalPath(join(root, 'alias', 'new-file')), join(root, 'protected', 'new-file'));
    const writer = record({ cwd: join(root, 'protected') });
    assert.match(guardTool('write', { path: join(root, 'alias', 'new-file') }, root, writer, undefined)!, /writer lease/);
    assert.equal(within('/workspace-other/file', '/workspace'), false);
    assert.equal(within('/workspace/file', '/workspace'), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('worker usage sums model, nested and optional counters without double-counting reasoning', () => {
  const total = emptyUsage(); const next = emptyUsage(); next.input = 10; next.output = 20; next.totalTokens = 30; next.reasoning = 7;
  addUsage(total, next); addUsage(total, next);
  assert.equal(total.totalTokens, 60); assert.equal(total.output, 40); assert.equal(total.reasoning, 14);
});
