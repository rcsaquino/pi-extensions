import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundGuard, REGISTRY_KEY } from './background.mjs';

const ctx = { sessionManager: { getSessionId: () => 'session', getSessionFile: () => '/mock/session.jsonl' } };
const validReply = method => method === 'ping' ? { session: { sessionFile: '/mock/session.jsonl' } }
  : { fleet: { version: 1, totalActive: 0, topLevelAsyncCapacity: { used: 0 } } };
function guard(options = {}) {
  return createBackgroundGuard({ getTools: () => [], scope: {}, ...options });
}

test('standalone guard needs no foreign runtime state or absent subagent RPC', async () => {
  const token = await guard()(ctx); assert.ok(token); await token.release(); await token.release();
});
for (const tool of ['subagent_dispatch', 'subagent_steer', 'subagent_tasks']) {
  test(`current ${tool} without a provider fails closed and never uses RPC`, async () => {
    const token = await guard({ getTools: () => [{ name: tool }] })(ctx);
    assert.equal(token, null);
  });
}

test('current subagent tools admit only when the neutral provider reports this session idle', async () => {
  const scope = {};
  const provider = name => ({ name, listActiveWork: () => [] });
  const tools = () => [{ name: 'subagent_dispatch' }, { name: 'subagent_tasks' }];
  assert.equal(await guard({ scope, getTools: tools })(ctx), null, 'no provider means fail closed');
  scope[Symbol.for(REGISTRY_KEY)] = { version: 1, providers: new Map([['pi-subagents', provider('pi-subagents')]]) };
  const token = await guard({ scope, getTools: tools })(ctx);
  assert.ok(token);
  await token.release();
});

test('current subagent tools fail closed while the provider reports active work', async () => {
  const scope = { [Symbol.for(REGISTRY_KEY)]: { version: 1, providers: new Map([['pi-subagents', {
    name: 'pi-subagents', listActiveWork: () => [{ id: 'run-1', sessionId: 'session' }],
  }]]) } };
  assert.equal(await guard({ scope, getTools: () => [{ name: 'subagent_steer' }] })(ctx), null);
});

test('unknown tool inventory is not silently interpreted as idle', async () => {
  await assert.rejects(guard({ getTools: () => null })(ctx));
});
