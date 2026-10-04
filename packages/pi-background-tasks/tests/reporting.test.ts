import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { BackgroundManager } from '../src/manager.ts';
import { buildSettlementReport, safeDiagnostics, terminalCategory } from '../src/report.ts';
import { emptyUsage } from '../src/types.ts';
import type { Job, Status, TerminalCategory } from '../src/types.ts';
import { scratch } from './helpers.ts';

const SECRET = 'SYNTHETIC_SECRET_MUST_NEVER_LEAVE_DIAGNOSTICS';
const model: Model<Api> = { id: 'synthetic', name: 'Synthetic', provider: 'inert', api: 'inert', baseUrl: 'http://127.0.0.1',
  reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 32000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
interface Options {
  scenario?: string;
  reason?: AssistantMessage['stopReason'];
  content?: AssistantMessage['content'];
  block?: boolean;
  timeoutMinutes?: number;
}
async function fixture(t: TestContext, options: Options = {}) {
  const root = await scratch('bg-report-test-');
  const notices: string[] = [], warnings: string[] = [];
  let requests = 0, tools = 0, metadataReads = 0;
  let started!: () => void; const requestStarted = new Promise<void>(r => { started = r; });
  let toolStarted!: () => void; const toolRunning = new Promise<void>(r => { toolStarted = r; });
  let releaseTool!: () => void; const toolGate = new Promise<void>(r => { releaseTool = r; });
  const pi = {
    getFlag: (name: string) => name === 'background-timeout-minutes' ? options.timeoutMinutes : undefined,
    getSettings: () => options.scenario === 'compaction-stream-error' ? { compaction: { reserveTokens: 1, keepRecentTokens: 1 } } : {},
    getAllTools: () => {
      metadataReads++;
      if (options.scenario === 'preparation-error' && metadataReads > 2) throw new Error(SECRET);
      return [{ name: 'read', exposure: 'direct', annotations: { readOnlyHint: true } }];
    },
    events: { emit: () => {} }, appendEntry: () => {},
    sendMessage: (m: { content: string }) => notices.push(m.content),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, mode: 'rpc', hasUI: false, thinkingLevel: 'high',
    model: options.scenario === 'compaction-error' ? { ...model, contextWindow: 1 }
      : options.scenario === 'compaction-stream-error' ? { ...model, contextWindow: 1000 } : model,
    sessionManager: { getSessionId: () => 'report-fixture', getBranch: () => [] },
    ui: { notify: (m: string) => warnings.push(m) }, isIdle: () => true, hasPendingMessages: () => false,
    getSystemPrompt: () => 'Inert inherited instructions.',
    tools: [{ name: 'read', label: 'Fake read', description: 'Only returns synthetic content.', parameters: Type.Object({}) }],
    executeTool: async (_name: string, _args: unknown, execution: { signal?: AbortSignal }) => {
      if (_name === 'background_start_check') return { isError: false, result: { content: [{ type: 'text', text: 'Synthetic start approved.' }], details: undefined } };
      tools++; toolStarted();
      if (options.scenario === 'abortable-tool') await new Promise<void>((_resolve, reject) => {
        execution.signal?.addEventListener('abort', () => reject(new Error(SECRET)), { once: true });
      });
      if (options.scenario === 'stuck-tool') await toolGate;
      if (options.scenario === 'tool-error') throw new Error(SECRET);
      return { isError: false, result: { content: [{ type: 'text', text: SECRET }], details: { secret: SECRET },
        ...(options.scenario === 'terminating-tool' || options.scenario === 'mixed-tools' && tools === 1 ? { terminate: true } : {}) } };
    },
    modelRegistry: { find: (): Model<Api> | undefined => ctx.model, streamSimple: (_m: Model<Api>, _c: TranscriptContext, callOptions: SimpleStreamOptions) => {
      requests++; started();
      if (options.scenario === 'provider-throw') throw new Error(SECRET);
      const stream = createAssistantMessageEventStream();
      const respond = (aborted = false) => {
        let content: AssistantMessage['content'] = options.content ?? [{ type: 'thinking', thinking: SECRET, thinkingSignature: SECRET },
          { type: 'text', text: 'Synthetic final report.', textSignature: SECRET }];
        let stopReason = options.scenario === 'compaction-stream-error' ? 'error' : options.reason ?? 'stop';
        if (requests === 1 && ['tool-error', 'terminating-tool', 'mixed-tools', 'truncated-call', 'preparation-error', 'stuck-tool', 'abortable-tool'].includes(options.scenario ?? '') || options.scenario === 'turn-limit') {
          content = [{ type: 'toolCall', id: `call-${requests}`, name: 'read', arguments: { secret: SECRET }, thoughtSignature: SECRET }];
          if (options.scenario === 'mixed-tools') content.push({ type: 'toolCall', id: 'second', name: 'read', arguments: {} });
          stopReason = options.scenario === 'truncated-call' ? 'length' : 'toolUse';
        }
        if (options.scenario === 'unknown-tool' && requests === 1) {
          content = [{ type: 'toolCall', id: 'unknown', name: SECRET, arguments: {} }]; stopReason = 'toolUse';
        }
        if (aborted) { content = []; stopReason = 'aborted'; }
        const usage = emptyUsage(); usage.totalTokens = 5; usage.output = 3; usage.reasoning = 2;
        // Malformed counters cannot turn into strings containing provider secrets.
        (usage as unknown as Record<string, unknown>).cacheRead = SECRET;
        const message = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, usage,
          timestamp: Date.now(), errorMessage: SECRET, diagnostics: [{ secret: SECRET }], rawStopReason: SECRET,
        } as unknown as AssistantMessage;
        if (stopReason === 'error' || stopReason === 'aborted') stream.push({ type: 'error', reason: stopReason, error: message });
        else stream.push({ type: 'done', reason: stopReason as 'stop', message });
        stream.end();
      };
      if (options.scenario === 'stream-throw') {
        stream[Symbol.asyncIterator] = async function* () { throw new Error(SECRET); };
        return stream;
      }
      if (options.block) callOptions.signal?.addEventListener('abort', () => respond(true), { once: true });
      else queueMicrotask(() => respond(callOptions.signal?.aborted));
      return stream;
    } },
  } as unknown as ExtensionToolContext;
  const manager = new BackgroundManager(pi);
  // Deterministic test-only notification boundary; no production poller or model/transport runtime.
  manager.scheduleNotifications = () => {};
  await manager.dispatch({ title: 'Synthetic task', task: 'Only perform inert synthetic work.', eta_seconds: 30,
    estimate_reason: 'Offline regression.', mode: 'manual', access: 'write' }, ctx, 'fixture-dispatch');
  const job = [...manager.jobs.values()][0]!;
  if (options.scenario === 'compaction-stream-error') job.contextSnapshot = [...job.contextSnapshot!,
    { role: 'user', content: 'Old context '.repeat(4000), timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Old reply.' }], api: model.api, provider: model.provider,
      model: model.id, usage: emptyUsage(), timestamp: 1, stopReason: 'stop' }];
  await (manager as unknown as { pumpQueue(): Promise<void> }).pumpQueue();
  t.after(async () => { releaseTool(); await manager.shutdown(); await job.done; await fs.rm(root, { recursive: true, force: true }); });
  const flush = () => (manager as unknown as { flushNotifications(): Promise<void> }).flushNotifications();
  return { root, manager, job, notices, warnings, requestStarted, toolRunning, releaseTool, flush,
    counts: () => ({ requests, tools }) };
}

const cases: { name: string; options: Options; status: Status; category: TerminalCategory }[] = [
  { name: 'normal stop', options: {}, status: 'completed', category: 'complete' },
  { name: 'empty stop', options: { content: [] }, status: 'failed', category: 'empty_report' },
  { name: 'whitespace stop', options: { content: [{ type: 'text', text: '  \n\t' }] }, status: 'failed', category: 'empty_report' },
  { name: 'thinking-only stop', options: { content: [{ type: 'thinking', thinking: SECRET }] }, status: 'failed', category: 'empty_report' },
  { name: 'empty error', options: { reason: 'error', content: [] }, status: 'failed', category: 'provider_or_stream_error' },
  { name: 'partial error', options: { reason: 'error', content: [{ type: 'text', text: 'Partial prose.' }] }, status: 'failed', category: 'provider_or_stream_error' },
  { name: 'empty length', options: { reason: 'length', content: [] }, status: 'failed', category: 'output_limit' },
  { name: 'partial length', options: { reason: 'length', content: [{ type: 'text', text: 'Partial prose.' }] }, status: 'failed', category: 'output_limit' },
  { name: 'deferred', options: { reason: 'deferred', content: [] }, status: 'failed', category: 'deferred_response' },
  { name: 'pending terminal', options: { reason: 'pending', content: [] }, status: 'failed', category: 'unsupported_terminal' },
  { name: 'call-less toolUse', options: { reason: 'toolUse', content: [] }, status: 'failed', category: 'unfinished_tool_turn' },
  { name: 'toolUse with prose but no calls', options: { reason: 'toolUse' }, status: 'failed', category: 'unfinished_tool_turn' },
  { name: 'unknown terminal reason', options: { reason: SECRET as never }, status: 'failed', category: 'unsupported_terminal' },
  { name: 'provider setup throw', options: { scenario: 'provider-throw' }, status: 'failed', category: 'provider_or_stream_error' },
  { name: 'stream iteration failure', options: { scenario: 'stream-throw' }, status: 'failed', category: 'provider_or_stream_error' },
  { name: 'compaction failure', options: { scenario: 'compaction-error' }, status: 'failed', category: 'compaction_error' },
  { name: 'compaction provider failure', options: { scenario: 'compaction-stream-error' }, status: 'failed', category: 'compaction_error' },
  { name: 'preparation failure', options: { scenario: 'preparation-error' }, status: 'failed', category: 'request_preparation_error' },
  { name: 'tool throw then valid final', options: { scenario: 'tool-error' }, status: 'completed', category: 'complete' },
  { name: 'all-terminating tool', options: { scenario: 'terminating-tool' }, status: 'failed', category: 'unfinished_tool_turn' },
  { name: 'mixed terminating tools still follow up', options: { scenario: 'mixed-tools' }, status: 'completed', category: 'complete' },
  { name: 'truncated call never executes', options: { scenario: 'truncated-call' }, status: 'completed', category: 'complete' },
  { name: 'unknown tool identity is not stored', options: { scenario: 'unknown-tool' }, status: 'completed', category: 'complete' },
  { name: 'provider aborted', options: { reason: 'aborted', content: [] }, status: 'cancelled', category: 'cancelled' },
  { name: 'turn limit', options: { scenario: 'turn-limit' }, status: 'failed', category: 'turn_limit' },
];
for (const c of cases) test(`settlement contract: ${c.name}`, async t => {
  const f = await fixture(t, c.options); await f.job.done;
  const r = f.job.record, d = r.terminalDiagnostics!;
  assert.equal(r.status, c.status); assert.equal(d.category, c.category);
  assert.equal(r.reportSource, c.status === 'completed' ? 'worker' : 'fallback');
  assert.equal(f.job.agent, undefined);
  const output = await f.manager.store!.output(r.id);
  if (c.status === 'completed') assert.equal(output, 'Synthetic final report.');
  else {
    assert.match(output, /Background task report: Synthetic task/); assert.match(output, new RegExp(`Status: ${c.status}`));
    assert.match(output, /does NOT verify/); assert.match(output, /No automatic replay/); assert.match(output, /Next step:/);
    assert.match(output, /Last recorded tool:/); assert.match(output, /Runtime: \d+s; tool calls: \d+; assistant turns: \d+/);
  }
  if (c.name.startsWith('partial')) assert.match(output, /Partial worker prose \(unverified, not a completion report\)\nPartial prose\./);
  if (c.name === 'tool throw then valid final') assert.equal(d.lastToolOutcome, 'error');
  if (c.name === 'all-terminating tool') { assert.equal(d.lastToolOutcome, 'completed'); assert.equal(f.counts().requests, 1); }
  if (c.name === 'mixed terminating tools still follow up') assert.deepEqual(f.counts(), { requests: 2, tools: 2 });
  if (c.name === 'truncated call never executes') assert.equal(f.counts().tools, 0);
  if (c.name === 'unknown tool identity is not stored') assert.equal(r.lastTool, 'other');
  if (c.name === 'compaction failure') { assert.equal(d.failurePhase, 'compacting'); assert.equal(d.lastPhase, 'compacting'); assert.equal(f.counts().requests, 0); }
  if (c.name === 'preparation failure') { assert.equal(d.failurePhase, 'preparing'); assert.equal(f.counts().requests, 1); }
  if (c.name === 'provider setup throw' || c.name === 'stream iteration failure') assert.equal(d.failurePhase, 'requesting');
  if (c.name === 'compaction provider failure') { assert.equal(d.failurePhase, 'compacting'); assert.equal(f.counts().requests, 1); }
  await f.flush(); await f.flush(); assert.equal(f.notices.length, 1);
  const metadata = await fs.readFile(f.manager.store!.path(r.id, 'json'), 'utf8');
  const result = await f.manager.result(r.id); const second = await f.manager.result(r.id);
  assert.ok(result.usage); assert.equal(second.usage, undefined);
  assert.doesNotMatch(metadata + output + JSON.stringify(result) + f.notices.join('') + f.warnings.join(''), new RegExp(SECRET));
});

test('no new assistant cannot accept inherited history or fabricate a report', async t => {
  const f = await fixture(t);
  f.job.agent!.prompt = async () => {};
  f.job.agent!.state.messages = [...f.job.agent!.state.messages, { role: 'assistant', content: [{ type: 'text', text: 'Inherited completion, not this task.' }],
    api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), timestamp: 1, stopReason: 'stop' }];
  await f.job.done;
  assert.equal(f.job.record.status, 'failed'); assert.equal(f.job.record.terminalDiagnostics!.category, 'missing_report');
  assert.doesNotMatch(await f.manager.store!.output(f.job.record.id), /Inherited completion/);
});

test('explicit cancellation has a standalone fallback and no additional model request', async t => {
  const f = await fixture(t, { block: true }); await f.requestStarted;
  await f.manager.cancel(f.job.record.id); await f.job.done;
  assert.equal(f.job.record.status, 'cancelled'); assert.equal(f.job.record.terminalDiagnostics!.category, 'cancelled');
  assert.match(await f.manager.store!.output(f.job.record.id), /Status: cancelled/); assert.equal(f.counts().requests, 1);
});
test('runtime limit is failed, not misclassified as cancellation', async t => {
  const f = await fixture(t, { block: true, timeoutMinutes: 0.00005 }); await f.job.done;
  assert.equal(f.job.record.status, 'failed'); assert.equal(f.job.record.terminalDiagnostics!.category, 'runtime_limit');
  assert.match(await f.manager.store!.output(f.job.record.id), /runtime limit/); assert.equal(f.counts().requests, 1);
});
test('cooperative shutdown stores its actual cause and does not notify a new foreground turn', async t => {
  const f = await fixture(t, { block: true }); await f.requestStarted;
  await f.manager.shutdown(); await f.job.done;
  assert.equal(f.job.record.status, 'cancelled'); assert.equal(f.job.record.terminalDiagnostics!.category, 'shutdown');
  assert.match(await f.manager.store!.output(f.job.record.id), /Pi stopped or reloaded/); assert.equal(f.notices.length, 0);
});
test('stuck-tool shutdown retains writer lease until the cooperating tool actually settles', async t => {
  const f = await fixture(t, { scenario: 'stuck-tool' }); await f.toolRunning;
  await f.manager.shutdown();
  assert.equal(f.job.record.status, 'interrupted'); assert.ok(f.job.release);
  const before = await f.manager.store!.output(f.job.record.id);
  assert.match(before, /Status: interrupted/); assert.match(before, /outcome: not recorded/);
  assert.equal((await fs.readdir(join(f.manager.store!.root, 'locks'))).filter(name => /^[a-f0-9]{24}\.json$/.test(name)).length, 1);
  assert.equal(f.manager.locks!.conflicts([{ path: f.root, mode: 'write' }]), true);
  f.releaseTool(); await f.job.done;
  assert.equal(f.job.record.status, 'interrupted'); assert.equal((await fs.readdir(join(f.manager.store!.root, 'locks'))).filter(name => /^[a-f0-9]{24}\.json$/.test(name)).length, 0);
  assert.equal(f.manager.locks!.conflicts([{ path: f.root, mode: 'write' }]), false);
  assert.equal(f.counts().tools, 1); assert.equal(f.counts().requests, 1); assert.equal(f.notices.length, 0);
});
test('lease cleanup failure cannot remain successful and does not leak the cleanup error', async t => {
  const f = await fixture(t); const release = f.job.release!;
  f.job.release = async () => { throw new Error(SECRET); }; await f.job.done;
  assert.equal(f.job.record.status, 'failed'); assert.equal(f.job.record.terminalDiagnostics!.category, 'lease_cleanup_error');
  assert.equal(f.job.record.terminalDiagnostics!.failurePhase, 'finalizing');
  const output = await f.manager.store!.output(f.job.record.id);
  assert.match(output, /Writer lease cleanup failed/); assert.match(output, /Partial worker prose/); assert.doesNotMatch(output, new RegExp(SECRET));
  await release();
});
for (const fault of ['before-output', 'after-output'] as const) test(`storage failure ${fault} retains bounded honest retrieval without reserving completion`, async t => {
  const f = await fixture(t); const store = f.manager.store!; const write = store.write.bind(store);
  store.write = async (record, output) => {
    if (output !== undefined) {
      if (fault === 'after-output') await fs.writeFile(store.path(record.id, 'md'), output);
      throw new Error(SECRET);
    }
    await write(record);
  };
  await f.job.done; assert.equal(f.job.record.status, 'failed'); assert.equal(f.job.storageFailed, true);
  assert.equal(f.job.record.reportSource, 'fallback'); assert.ok(f.job.memoryReport!.length < 4000);
  await f.flush(); await f.flush(); assert.equal(f.notices.length, 0); assert.equal(f.job.record.notification, 'pending');
  store.write = async () => { throw new Error(SECRET); };
  const first = await f.manager.result(f.job.record.id, 0, 100); const second = await f.manager.result(f.job.record.id, 100, 100);
  assert.ok(first.usage); assert.equal(second.usage, undefined);
  const details = first.details as { reportDurable: boolean; outputPath: string | null; nextOffset: number };
  assert.equal(details.reportDurable, false); assert.equal(details.outputPath, null); assert.equal(details.nextOffset, 100);
  assert.doesNotMatch(JSON.stringify(first.content), /local file/);
  assert.match(f.job.memoryReport!, /Storage failure/); assert.doesNotMatch(JSON.stringify(first) + f.job.memoryReport! + f.warnings.join(''), new RegExp(SECRET));
});
test('output and metadata are durable before notification reservation', async t => {
  const f = await fixture(t); await f.job.done;
  const write = f.manager.store!.write.bind(f.manager.store); let reserved = false;
  f.manager.store!.write = async (r, output) => {
    if (r.notification === 'queued') {
      assert.match(await f.manager.store!.output(r.id), /Synthetic final report/);
      const saved = JSON.parse(await fs.readFile(f.manager.store!.path(r.id, 'json'), 'utf8'));
      assert.equal(saved.reportSource, 'worker'); assert.equal(saved.status, 'completed'); reserved = true;
    }
    await write(r, output);
  };
  await f.flush(); await f.flush(); assert.equal(reserved, true); assert.equal(f.notices.length, 1);
});
test('pure terminal validation rejects malformed text and never infers a provider origin from an error string', () => {
  assert.equal(terminalCategory({ stopReason: 'stop', text: 'Visible', hadToolCalls: false, malformed: true }), 'unsupported_terminal');
  assert.equal(terminalCategory({ stopReason: 'error', text: SECRET, hadToolCalls: false }), 'unknown');
  assert.equal(terminalCategory({ stopReason: 'stop', text: 'Visible', hadToolCalls: true }), 'unfinished_tool_turn');
  const d = safeDiagnostics({ stopReason: SECRET, category: SECRET, lastPhase: SECRET, failurePhase: SECRET,
    visibleTextCharacters: SECRET, hadToolCalls: SECRET, lastToolOutcome: SECRET, errorMessage: SECRET,
    headers: { authorization: SECRET }, reasoning: SECRET, diagnostics: [{ secret: SECRET }] });
  assert.deepEqual(d, { stopReason: 'unknown', category: 'unknown', lastPhase: 'unknown', failurePhase: 'unknown', visibleTextCharacters: 0, hadToolCalls: false });
  assert.doesNotMatch(JSON.stringify(d), new RegExp(SECRET));
});
test('pure fallback is deterministic, sanitizes counters, and does not upgrade failed partial prose', async t => {
  const f = await fixture(t, { reason: 'error', content: [{ type: 'text', text: 'Partial prose.' }] }); await f.job.done;
  const record = { ...f.job.record, turns: SECRET as never, toolCalls: NaN, lastTool: SECRET };
  const a = buildSettlementReport(record, 'Partial prose.'), b = buildSettlementReport(record, 'Partial prose.');
  assert.deepEqual(a, b); assert.equal(a.source, 'fallback'); assert.match(a.text, /tool calls: 0; assistant turns: 0/);
  assert.match(a.text, /Last recorded tool: other/); assert.doesNotMatch(a.text, new RegExp(SECRET));
});
test('malformed success metadata and mismatched visible-text counts cannot accept worker prose', async t => {
  const f = await fixture(t); await f.job.done;
  for (const change of [{ hadToolCalls: SECRET }, { stopReason: SECRET }, { visibleTextCharacters: SECRET },
    { lastPhase: SECRET }, { leaseCleanupFailed: true }, { visibleTextCharacters: 999 }]) {
    const record = { ...f.job.record, terminalDiagnostics: { ...f.job.record.terminalDiagnostics, ...change } } as unknown as Job['record'];
    const report = buildSettlementReport(record, 'Synthetic final report.');
    assert.equal(report.source, 'fallback'); assert.match(report.text, /does NOT verify/); assert.doesNotMatch(report.text, new RegExp(SECRET));
  }
});

test('tool cancellation records observed aborted outcome and originating tool phase, not later preparation', async t => {
  const f = await fixture(t, { scenario: 'abortable-tool' }); await f.toolRunning;
  await f.manager.cancel(f.job.record.id); await f.job.done;
  assert.equal(f.job.record.status, 'cancelled');
  assert.equal(f.job.record.terminalDiagnostics!.failurePhase, 'tool');
  assert.equal(f.job.record.terminalDiagnostics!.lastToolOutcome, 'aborted');
  assert.match(await f.manager.store!.output(f.job.record.id), /outcome: aborted/);
  assert.deepEqual(f.counts(), { tools: 1, requests: 1 });
});
for (const fault of ['missing', 'blank', 'unreadable'] as const) test(`explicit retrieval ${fault} output returns an honest non-durable fallback`, async t => {
  const f = await fixture(t); await f.job.done;
  if (fault === 'missing') await fs.unlink(f.manager.store!.path(f.job.record.id, 'md'));
  if (fault === 'blank') await fs.writeFile(f.manager.store!.path(f.job.record.id, 'md'), ' \n');
  if (fault === 'unreadable') f.manager.store!.output = async () => { throw Object.assign(new Error(SECRET), { code: 'EACCES' }); };
  const result = await f.manager.result(f.job.record.id);
  assert.equal(f.job.record.status, 'failed'); assert.equal(f.job.record.reportSource, 'fallback');
  assert.equal((result.details as { reportDurable: boolean }).reportDurable, false);
  assert.match(JSON.stringify(result.content), /Storage failure/); assert.match(JSON.stringify(result.content), /does NOT verify/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET)); assert.equal((await f.manager.result(f.job.record.id)).usage, undefined);
});
