import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { compactWorker } from '../src/worker.ts';
import { emptyUsage } from '../src/types.ts';

const model = { id: 'same', provider: 'same-provider', api: 'fake', reasoning: true, maxTokens: 4096 } as Model<any>;
const profile = { model, thinking: 'high' as const };
function summaryStream(record: (modelId: string, reasoning: string | undefined) => void): StreamFn {
  return (m, _context, options) => {
    record(m.id, options?.reasoning);
    const stream = createAssistantMessageEventStream();
    const usage = emptyUsage(); usage.totalTokens = 17;
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Summary preserves unfinished task, verification and output paths.' }], model: m.id, provider: m.provider, api: m.api, timestamp: Date.now(), stopReason: 'stop', usage };
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
    return stream;
  };
}
test('worker compaction preserves the system prompt and recent tool-call/result pairing using the same model/thinking', async () => {
  const messages = [
    { role: 'system', content: 'Inherited identity, skills and access boundaries.', timestamp: 1 },
    { role: 'user', content: 'Older context '.repeat(500), timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Prior response' }], timestamp: 1 },
    { role: 'user', content: 'Delegated task and required deliverables.', timestamp: 2 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'pair', name: 'read', arguments: {} }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'pair', toolName: 'read', content: [{ type: 'text', text: 'Recent result' }], isError: false, timestamp: 2 },
  ] as AgentMessage[];
  const calls: unknown[] = []; let usage = 0;
  const result = await compactWorker(messages, profile, 256, 1, summaryStream((id, level) => calls.push({ id, level })), undefined, u => { usage += u.totalTokens; });
  assert.deepEqual(calls, [{ id: 'same', level: 'high' }]); assert.equal(usage, 17);
  assert.match(getCurrentSystemPrompt(result), /Inherited identity/);
  assert.equal(result[1]!.role, 'compactionSummary');
  assert.equal(result.at(-2)!.role, 'assistant'); assert.equal(result.at(-1)!.role, 'toolResult');
  assert.equal(messages.length, 6);
});
test('compaction does not silently truncate an unsplittable oversized tail', async () => {
  const messages = [{ role: 'system', content: 'Rules', timestamp: 1 }, { role: 'user', content: 'Oversized indivisible task', timestamp: 2 }] as AgentMessage[];
  await assert.rejects(compactWorker(messages, profile, 256, 1000, summaryStream(() => {}), undefined, () => {}), /cannot be compacted safely/);
});
