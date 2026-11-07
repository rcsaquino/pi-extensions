import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundGuard, REGISTRY_KEY } from './background.mjs';

const ctx = { sessionManager: { getSessionId: () => 'session', getSessionFile: () => '/mock/session.jsonl' } };
const guard = (scope = {}) => createBackgroundGuard({ scope });

test('standalone guard needs no provider and releases idempotently', async () => {
  const token = await guard()(ctx); assert.ok(token); await token.release(); await token.release();
});

test('a provider reporting same-session work blocks compaction', async () => {
  const scope = { [Symbol.for(REGISTRY_KEY)]: { version: 1, providers: new Map([['worker', {
    name: 'worker', listActiveWork: () => [{ id: 'run-1', sessionId: 'session' }],
  }]]) } };
  assert.equal(await guard(scope)(ctx), null);
});

test('a provider reporting only other sessions stays idle', async () => {
  const scope = { [Symbol.for(REGISTRY_KEY)]: { version: 1, providers: new Map([['worker', {
    name: 'worker', listActiveWork: () => [{ id: 'run-1', sessionId: 'other-session' }],
  }]]) } };
  const token = await guard(scope)(ctx); assert.ok(token); await token.release();
});

test('unsupported registry state fails closed', async () => {
  const scope = { [Symbol.for(REGISTRY_KEY)]: { version: 2, providers: new Map() } };
  await assert.rejects(guard(scope)(ctx), /unavailable or unsupported/);
});
