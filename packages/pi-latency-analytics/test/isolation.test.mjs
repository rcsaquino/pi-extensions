import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IsolatedCollector } from '../lib/isolation.mjs';
import { AnalyticsDatabase, summarize } from '../lib/database.mjs';

const sessionId = 'isolated-fixture';
const envelope = (task, root, type, fields = {}) => ({ version: 1, taskId: `bg-${task.repeat(12)}`, rootCallId: root, sessionId, type, ...fields });
const message = { role: 'assistant', provider: 'fixture', model: 'foreground', stopReason: 'stop', usage: { input: 1, output: 2, reasoning: 1, totalTokens: 3 } };
function fixture() {
  let time = 0; const records = [];
  const c = new IsolatedCollector(r => records.push(r), { instanceId: 'isolation-instance', clock: () => ({ wall: 1000 + time, mono: time }) });
  c.configure({ session_id: sessionId, provider: 'fixture', model: 'foreground' });
  return { c, records, advance: n => { time += n; },
    traces: () => [...new Map(records.filter(r => r.op === 'trace').map(r => [r.value.trace_id, r.value])).values()],
    spans: () => [...new Map(records.filter(r => r.op === 'span').map(r => [r.value.span_id, r.value])).values()],
  };
}

test('two interleaved workers and later foreground stay separate, linked, and account terminal/aggregate usage only once', () => {
  const f = fixture(), c = f.c;
  c.input('rpc'); c.agentStart(); c.toolStart({ toolName: 'background_dispatch', toolCallId: 'root-a' });
  c.workerEvent(envelope('a','root-a','worker-start',{ provider: 'fixture', model: 'worker-a', thinking: 'high' }));
  c.toolEnd({ toolCallId: 'root-a' });
  c.toolStart({ toolName: 'background_dispatch', toolCallId: 'root-b' });
  c.workerEvent(envelope('b','root-b','worker-start',{ provider: 'fixture', model: 'worker-b' }));
  c.toolEnd({ toolCallId: 'root-b' }); f.advance(10); c.finish();
  const parent = f.traces().find(t => t.source !== 'background-worker');
  c.workerEvent(envelope('a','root-a','model-start',{ requestId: 'request-a' }));
  c.workerEvent(envelope('b','root-b','model-start',{ requestId: 'request-b' }));
  c.workerEvent(envelope('a','root-a','model-request',{ requestId: 'request-a' }));
  c.workerEvent(envelope('a','root-a','model-headers',{ requestId: 'request-a' }));
  c.workerEvent(envelope('b','root-b','model-headers',{ requestId: 'request-b' }));
  c.toolStart({ toolCallId: 'root-a/1', parentToolCallId: 'root-a', toolName: 'read' });
  c.toolStart({ toolCallId: 'root-a/1/1', parentToolCallId: 'root-a/1', toolName: 'nested_read' });
  f.advance(40); c.input('rpc'); c.agentStart(); c.context();
  c.toolStart({ toolCallId: 'main-read', toolName: 'foreground_read' });
  f.advance(5); c.toolEnd({ toolCallId: 'root-a/1/1' }); c.toolEnd({ toolCallId: 'root-a/1' });
  c.workerEvent(envelope('a','root-a','model-response',{ requestId: 'request-a', status: 200 }));
  c.workerEvent(envelope('a','root-a','model-stream',{ requestId: 'request-a', eventType: 'thinking_start', contentIndex: 0 }));
  c.workerEvent({ ...envelope('a','root-a','model-stream',{ requestId: 'request-a', eventType: 'thinking_delta', contentIndex: 0 }),
    get delta() { throw new Error('Never inspect reasoning'); } });
  c.workerEvent(envelope('a','root-a','model-stream',{ requestId: 'request-a', eventType: 'thinking_end', contentIndex: 0 }));
  c.workerEvent(envelope('a','root-a','model-end',{ requestId: 'request-a', stopReason: 'stop', model: 'worker-a', usage: { input: 5, output: 8, reasoning: 3, totalTokens: 13 } }));
  c.workerEvent(envelope('a','root-a','model-end',{ requestId: 'request-a', usage: { totalTokens: 999 } }));
  c.workerEvent(envelope('a','root-a','tool-usage',{ callId: 'worker-own-tool', usage: { input: 4, output: 6, totalTokens: 10 } }));
  c.workerEvent(envelope('a','root-a','tool-usage',{ callId: 'worker-own-tool', usage: { totalTokens: 999 } }));
  c.providerHeaders(); c.providerResponse(200); c.uiStart('confirm'); c.uiEnd();
  f.advance(5); c.toolEnd({ toolCallId: 'main-read' }); c.messageEnd(message); c.finish();
  f.advance(20); c.workerEvent(envelope('b','root-b','model-response',{ requestId: 'request-b', status: 503 }));
  c.workerEvent(envelope('b','root-b','model-end',{ requestId: 'request-b', stopReason: 'error', model: 'worker-b', usage: { totalTokens: 7 } }));
  c.workerEvent(envelope('b','root-b','worker-end',{ status: 'failed' }));
  c.workerEvent(envelope('a','root-a','worker-end',{ status: 'completed' }));
  c.workerEvent(envelope('a','root-a','worker-end',{ status: 'completed' }));
  c.toolStart({ toolCallId: 'root-a/99', parentToolCallId: 'root-a', toolName: 'late_worker_write' });
  assert.equal(c.active, null, 'late worker events must not create a foreground activity');
  assert.equal(f.traces().length, 4);
  const foreground = f.traces().filter(t => t.source !== 'background-worker').at(-1);
  assert.equal(foreground.duration_ms, 10);
  const spans = f.spans();
  const mainSpans = spans.filter(s => s.trace_id === foreground.trace_id);
  assert.deepEqual(mainSpans.filter(s => s.kind === 'tool').map(s => s.name), ['foreground_read']);
  assert.equal(mainSpans.filter(s => s.kind === 'model').length, 1);
  assert.equal(mainSpans.filter(s => ['provider_headers','reasoning_stream','ui_wait'].includes(s.kind)).length, 0);
  assert.equal(mainSpans.find(s => s.kind === 'model').meta.provider_hook_attribution, 'unknown_no_request_id');
  const workers = f.traces().filter(t => t.source === 'background-worker');
  assert.equal(workers.length, 2); assert.deepEqual(workers.map(w => w.status).sort(), ['completed','error']);
  const workerModels = spans.filter(s => workers.some(w => w.trace_id === s.trace_id) && s.kind === 'model');
  assert.equal(workerModels.length, 2); assert.equal(workerModels.reduce((sum, s) => sum + s.meta.usage.totalTokens, 0), 20);
  assert.equal(workerModels.find(s => s.meta.model === 'worker-a').meta.usage.output, 8, 'reasoning is a subset, not added to output');
  assert.equal(workerModels.find(s => s.meta.model === 'worker-a').meta.first_output_ms, 45);
  const links = f.records.filter(r => r.op === 'event' && r.value.name === 'worker_link');
  assert.equal(links.length, 2); assert.ok(links.every(r => r.value.meta.parent_trace_id === parent.trace_id && r.value.meta.parent_tool_span_id));
  assert.equal(f.records.filter(r => r.op === 'event' && r.value.name === 'nested_tool_usage').length, 1);
  const nested = spans.find(s => s.name === 'nested_read'); assert.ok(nested.parent_span_id);
  assert.equal(spans.find(s => s.span_id === nested.parent_span_id).trace_id, nested.trace_id);
  assert.equal(summarize(foreground, mainSpans).tools.some(tool => tool.name.includes('worker')), false);
});

test('worker cancellation, model errors, unclosed tools, shutdown and malformed/late events finalize conservatively without leaks', () => {
  const f = fixture(), c = f.c;
  c.agentStart();
  const secret = 'PRIVATE_TASK_PATIENT_CREDENTIAL_BODY';
  c.workerEvent(envelope('a','cancel-root','worker-start',{ provider: 'fixture', model: 'worker', task: secret, path: secret }));
  c.workerEvent(envelope('a','cancel-root','model-start',{ requestId: 'cancel-request', purpose: 'compaction', payload: secret }));
  c.toolStart({ toolCallId: 'cancel-root/1', parentToolCallId: 'cancel-root', toolName: 'read', get args() { throw new Error('No args'); } });
  f.advance(5); c.workerEvent(envelope('a','cancel-root','worker-end',{ status: 'cancelled', error: secret }));
  c.workerEvent(envelope('a','cancel-root','model-end',{ requestId: 'cancel-request', stopReason: 'stop', usage: { totalTokens: 999 }, content: secret }));
  c.workerEvent(envelope('b','shutdown-root','worker-start')); c.workerEvent(envelope('b','shutdown-root','model-start',{ requestId: 'shutdown-model' }));
  c.workerEvent(envelope('b','shutdown-root','model-start',{ requestId: 'shutdown-model' }));
  c.workerEvent(envelope('b','shutdown-root','model-stream',{ requestId: 'wrong', eventType: 'text_delta', delta: secret }));
  c.workerEvent(envelope('b','shutdown-root','bad-event',{ requestId: 'shutdown-model', content: secret }));
  c.workerEvent({ version: 1, type: 'worker-start', sessionId: 'different', taskId: 'bg-cccccccccccc', rootCallId: 'wrong-session' });
  c.workerEvent({ version: 99, type: 'worker-start', sessionId, taskId: 'bg-cccccccccccc', rootCallId: 'wrong-version' });
  f.advance(5); c.shutdown(); c.shutdown();
  const workers = f.traces().filter(t => t.source === 'background-worker');
  assert.equal(workers.length, 2); assert.equal(workers[0].status, 'aborted'); assert.equal(workers[1].status, 'interrupted');
  assert.ok(workers.every(w => w.complete === false)); assert.equal(f.spans().filter(s => s.kind === 'model').length, 2);
  assert.ok(!JSON.stringify(f.records).includes(secret));
});

test('existing schema-v1 legacy records remain readable; last excludes worker traces but recent/trace expose explicit links', t => {
  const root = resolve(process.env.PI_EXTENSIONS_TEST_ROOT || 'test/.tmp'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'isolation-db-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(), c = f.c;
  const db = new AnalyticsDatabase(join(dir, 'analytics.sqlite'), c.instanceId);
  t.after(() => db.close());
  c.agentStart(); c.context(); c.messageEnd(message); c.finish();
  const legacy = f.traces()[0]; db.batch(f.records);
  assert.equal(db.query({ action: 'last', sessionId })[0].trace_id, legacy.trace_id);
  assert.match(db.query({ action: 'last', sessionId })[0].caveats.join(' '), /predating trace isolation/);
  const count = f.records.length;
  c.agentStart(); c.workerEvent(envelope('a','db-root','worker-start')); f.advance(2); c.finish();
  f.advance(10); c.workerEvent(envelope('a','db-root','worker-end',{ status: 'completed' })); db.batch(f.records.slice(count));
  const all = db.query({ action: 'recent', sessionId }); assert.equal(all.length, 3);
  const worker = all.find(trace => trace.trace_scope === 'worker'); assert.ok(worker.worker_link.parent_trace_id);
  assert.equal(db.query({ action: 'last', sessionId })[0].trace_scope, 'foreground-or-legacy');
  assert.equal(db.query({ action: 'trace', traceId: worker.trace_id })[0].worker_link.task_id, 'bg-aaaaaaaaaaaa');
  db.db.prepare("UPDATE spans SET meta=? WHERE trace_id=? AND kind='model'").run(JSON.stringify({ provider_hook_attribution: 'main_model_window_best_effort', usage: { totalTokens: 3 } }), legacy.trace_id);
  assert.equal(db.query({ action: 'trace', traceId: legacy.trace_id })[0].model_requests[0].provider_hook_attribution, 'main_model_window_best_effort');
});

test('queued workers preserve their original parent link, separate admission wait and never contaminate a later foreground', () => {
  const f = fixture(), c = f.c;
  c.input('rpc'); c.agentStart(); c.toolStart({ toolName: 'background_dispatch', toolCallId: 'queued-root' });
  c.workerEvent(envelope('a', 'queued-root', 'worker-queued', { provider: 'fixture', model: 'captured', task: 'PRIVATE_QUEUE_BRIEF' }));
  c.toolEnd({ toolCallId: 'queued-root' }); c.finish(); const original = f.traces().find(t => t.source !== 'background-worker');
  f.advance(40); c.input('rpc'); c.agentStart(); c.context(); c.messageEnd(message); c.finish();
  c.toolStart({ toolName: 'background_start_check', toolCallId: 'queued-root/1', parentToolCallId: 'queued-root' }); f.advance(5); c.toolEnd({ toolCallId: 'queued-root/1' });
  c.workerEvent(envelope('a', 'queued-root', 'worker-start', { queueWaitMs: 45 }));
  c.workerEvent(envelope('a', 'queued-root', 'model-admitted', { requestId: 'queued-request', waitMs: 3 }));
  c.workerEvent(envelope('a', 'queued-root', 'model-start', { requestId: 'queued-request' })); f.advance(10);
  c.workerEvent(envelope('a', 'queued-root', 'model-end', { requestId: 'queued-request', stopReason: 'stop', usage: { totalTokens: 1 } }));
  c.workerEvent(envelope('a', 'queued-root', 'worker-end', { status: 'completed' })); c.workerEvent(envelope('a', 'queued-root', 'worker-end', { status: 'completed' }));
  const worker = f.traces().find(t => t.source === 'background-worker'); assert.equal(worker.agent_started_wall, 1045);
  assert.equal(f.records.find(r => r.op === 'event' && r.value.name === 'worker_link').value.meta.parent_trace_id, original.trace_id);
  const queue = f.spans().find(s => s.trace_id === worker.trace_id && s.kind === 'queue'); assert.equal(queue.duration_ms, 45); assert.equal(queue.status, 'completed');
  assert.equal(f.spans().filter(s => s.trace_id === worker.trace_id && s.kind === 'model').length, 1);
  assert.ok(f.spans().filter(s => s.kind === 'tool' && s.name === 'background_start_check').every(s => s.trace_id === worker.trace_id));
  assert.equal(f.traces().length, 3); assert.doesNotMatch(JSON.stringify(f.records), /PRIVATE_QUEUE_BRIEF/);
});

test('a foreground provider tool ID sharing a worker prefix is not sufficient nested ancestry', () => {
  const f = fixture(), c = f.c; c.agentStart(); c.workerEvent(envelope('a', 'worker-root', 'worker-start')); c.finish();
  c.input('rpc'); c.agentStart(); c.toolStart({ toolCallId: 'worker-root/foreground-provider-id', toolName: 'foreground_read' }); f.advance(5);
  c.toolEnd({ toolCallId: 'worker-root/foreground-provider-id' }); c.finish(); c.workerEvent(envelope('a', 'worker-root', 'worker-end', { status: 'completed' }));
  const foreground = f.traces().filter(t => t.source !== 'background-worker').at(-1), worker = f.traces().find(t => t.source === 'background-worker');
  assert.deepEqual(f.spans().filter(s => s.trace_id === foreground.trace_id && s.kind === 'tool').map(s => s.name), ['foreground_read']);
  assert.equal(f.spans().filter(s => s.trace_id === worker.trace_id && s.kind === 'tool').length, 0);
});
