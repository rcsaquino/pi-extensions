import test from 'node:test';
import assert from 'node:assert/strict';
import { Collector } from '../lib/collector.mjs';
import { summarize } from '../lib/database.mjs';

const message = (stopReason = 'stop') => ({ role: 'assistant', provider: 'fixture', model: 'fixture-model', stopReason, usage: { input: 20, output: 5, totalTokens: 25, cacheRead: 10 } });
function harness() {
  let mono = 0, wall = 100000;
  const records = [];
  const c = new Collector(r => records.push(r), { clock: () => ({ mono, wall }), instanceId: 'fixture-instance' });
  c.configure({ session_id: 'fixture-session', model: 'fixture-model', provider: 'fixture', thinking_level: 'high' });
  return { c, records, advance: ms => { mono += ms; wall += ms; }, wallBack: ms => { wall -= ms; }, summary: () => {
    const trace = records.filter(r => r.op === 'trace').at(-1).value;
    const spans = [...new Map(records.filter(r => r.op === 'span').map(r => [r.value.span_id, r.value])).values()];
    return summarize(trace, spans);
  } };
}

test('input preparation, model lifecycle, normalized first output, usage, settled boundary', () => {
  const h = harness(), c = h.c;
  c.input('interactive'); h.advance(5); c.beforeAgent(); h.advance(5); c.agentStart();
  c.messageStart(message()); c.providerRequest(); h.advance(10); c.providerHeaders();
  h.advance(15); c.providerResponse(200); h.advance(5);
  c.stream({ type: 'thinking_start', contentIndex: 0 }); c.stream({ type: 'thinking_delta', contentIndex: 0, delta: 'must-not-retain' });
  h.advance(20); c.stream({ type: 'thinking_end', contentIndex: 0 }); c.stream({ type: 'text_delta', contentIndex: 1, delta: 'must-not-retain' });
  h.advance(10); c.messageEnd(message()); c.turnEnd({ turnIndex: 0, messageEntryId: 'entry-final' }); c.agentEnd();
  assert.ok(c.active, 'agent_end must not close activity');
  h.advance(2); c.finish();
  const result = h.summary();
  assert.equal(result.duration_ms, 72); assert.equal(result.phase_totals_ms.pre_agent, 10);
  assert.equal(result.phase_totals_ms.model, 60); assert.equal(result.phase_totals_ms.unattributed, 2);
  assert.equal(result.assistant_entry_id, 'entry-final');
  assert.equal(result.model_requests[0].first_output_ms, 30);
  assert.equal(result.model_requests[0].first_text_ms, 50);
  assert.equal(result.model_requests[0].usage.cacheRead, 10);
  assert.equal(result.complete, true); assert.equal(c.active, null);
  assert.ok(!JSON.stringify(h.records).includes('must-not-retain'));
});

test('parallel and nested tools use elapsed union, not summed work', () => {
  const h = harness(), c = h.c;
  c.input('rpc'); c.beforeAgent(); c.agentStart();
  c.toolStart({ toolCallId: 'parent', toolName: 'codemode' });
  h.advance(10); c.toolStart({ toolCallId: 'parent/1', parentToolCallId: 'parent', toolName: 'read' });
  h.advance(15); c.toolStart({ toolCallId: 'parallel', toolName: 'bash' });
  h.advance(5); c.toolEnd({ toolCallId: 'parent/1' });
  h.advance(15); c.toolEnd({ toolCallId: 'parallel', isError: true });
  h.advance(5); c.toolEnd({ toolCallId: 'parent' }); c.finish();
  const result = h.summary();
  assert.equal(result.duration_ms, 50); assert.equal(result.phase_totals_ms.tool, 50);
  assert.equal(result.tools.reduce((n,t) => n+t.work_ms,0), 90);
  const spans = h.records.filter(r => r.op === 'span' && r.value.name === 'read');
  assert.ok(spans[0].value.parent_span_id);
});

test('streaming emits only sparse first/boundary events, not a row per token', () => {
  const h = harness(), c = h.c;
  c.agentStart(); c.messageStart(message()); c.providerRequest();
  const before = h.records.length;
  const delta = { type: 'text_delta', contentIndex: 0, get delta() { throw new Error('text inspected'); }, get partial() { throw new Error('partial inspected'); } };
  for (let i = 0; i < 100000; i++) c.stream(delta);
  assert.equal(h.records.length - before, 2);
  c.messageEnd(message()); c.finish();
  assert.equal(h.summary().model_requests[0].chunks, 100000);
});

test('never reads tool arguments/results or message bodies', () => {
  const h = harness(), c = h.c;
  c.agentStart();
  c.toolStart({ toolName: 'bash', toolCallId: 'private', get args() { throw new Error('args inspected'); } });
  h.advance(1); c.toolEnd({ toolCallId: 'private', get result() { throw new Error('result inspected'); } });
  const m = { ...message(), get content() { throw new Error('message inspected'); }, get errorMessage() { throw new Error('error inspected'); } };
  c.messageStart(m); c.messageEnd(m); c.finish();
  assert.equal(h.summary().complete, true);
});

test('monotonic duration survives wall clock adjustment', () => {
  const h = harness(); h.c.input('interactive'); h.c.agentStart();
  h.advance(100); h.wallBack(1000); h.c.finish();
  assert.equal(h.summary().duration_ms, 100);
  assert.ok(h.summary().ended_wall < h.summary().started_wall);
});

test('retry/compaction/continuation remains one activity until settlement', () => {
  const h = harness(), c = h.c;
  c.agentStart(); c.messageStart(message()); h.advance(10); c.messageEnd(message('error')); c.agentEnd();
  h.advance(20); c.compactStart(); h.advance(30); c.compactEnd();
  assert.ok(c.active); c.agentStart(); c.messageStart(message()); h.advance(5); c.messageEnd(message()); c.agentEnd(); c.finish();
  const result = h.summary();
  assert.equal(h.records.filter(r => r.op === 'trace' && r.value.ended_wall !== null).length, 1);
  assert.equal(result.model_requests.length, 2); assert.equal(result.phase_totals_ms.compaction, 30);
  assert.equal(result.phase_totals_ms.unattributed, 20);
});

test('multiple inputs explicitly flag ambiguous per-message attribution', () => {
  const h = harness(), c = h.c;
  c.input('interactive'); c.beforeAgent(); c.agentStart();
  h.advance(2); c.input('extension'); h.advance(3); c.finish();
  assert.equal(h.summary().input_count, 2); assert.equal(h.summary().ambiguous_inputs, true);
  assert.ok(h.summary().caveats.some(s => s.includes('Multiple inputs')));
});

test('multiple pending inputs preserve first boundary and mark ambiguity', () => {
  const h = harness(), c = h.c;
  c.input('rpc'); h.advance(4); c.input('rpc'); h.advance(6); c.agentStart(); c.finish();
  assert.equal(h.summary().duration_ms, 10); assert.equal(h.summary().input_count, 2);
  assert.equal(h.summary().ambiguous_inputs, true);
});

test('manual maintenance compaction settles without an agent run', () => {
  const h = harness(), c = h.c;
  c.compactStart(); h.advance(40); c.compactEnd();
  assert.equal(c.active, null); assert.equal(h.summary().phase_totals_ms.compaction, 40);
});

test('missing tool end remains explicitly incomplete', () => {
  const h = harness(), c = h.c;
  c.agentStart(); c.toolStart({ toolCallId: 'missing', toolName: 'read' }); h.advance(7); c.finish('aborted');
  assert.equal(h.summary().complete, false); assert.equal(h.summary().status, 'aborted');
});

test('UI wait wins over its enclosing tool, without double counting', () => {
  const h = harness(), c = h.c;
  c.agentStart(); c.toolStart({ toolCallId: 'tool', toolName: 'confirming-tool' }); h.advance(2);
  c.uiStart('confirm'); h.advance(20); c.uiEnd(); h.advance(3); c.toolEnd({ toolCallId: 'tool' }); c.finish();
  assert.equal(h.summary().phase_totals_ms.ui_wait, 20); assert.equal(h.summary().phase_totals_ms.tool, 5);
});

test('missing headers/reasoning end flags incomplete capture', () => {
  const h = harness(), c = h.c;
  c.agentStart(); c.messageStart(message()); c.providerHeaders();
  c.stream({ type: 'thinking_start', contentIndex: 0 }); h.advance(3); c.messageEnd(message('error')); c.finish('error');
  assert.equal(h.summary().complete, false);
});

test('provider hooks outside an assistant response are not falsely attributed', () => {
  const h = harness(), c = h.c;
  c.agentStart(); c.providerRequest(); c.providerHeaders(); c.providerResponse(200); c.finish();
  assert.equal(h.summary().model_requests.length, 0);
  assert.ok(h.records.some(r => r.op === 'event' && r.value.name === 'unattributed_provider_request'));
});
