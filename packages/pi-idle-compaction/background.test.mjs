import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBackgroundGuard, REGISTRY_KEY, registeredWorkIdle,
} from './background.mjs';

const ctx = { sessionManager: { getSessionId: () => 'session', getSessionFile: () => '/mock/session.jsonl' } };
const guard = (scope = {}) => createBackgroundGuard({ scope });
const registry = providers => ({ [Symbol.for(REGISTRY_KEY)]: { version: 1, providers: new Map(providers) } });
const provider = overrides => ({ name: 'worker', listActiveWork: () => [], ...overrides });

test('standalone guard needs no provider and releases idempotently', async () => {
  const token = await guard()(ctx); assert.ok(token); await token.release(); await token.release();
});

test('a provider reporting same-session work blocks compaction', async () => {
  const scope = registry([['worker', provider({ listActiveWork: () => [{ id: 'run-1', sessionId: 'session' }] })]]);
  assert.equal(await guard(scope)(ctx), null);
});

test('a provider reporting only other sessions stays idle', async () => {
  const scope = registry([['worker', provider({ listActiveWork: () => [{ id: 'run-1', sessionId: 'other-session' }] })]]);
  const token = await guard(scope)(ctx); assert.ok(token); await token.release();
});

test('unsupported registry state fails closed', async () => {
  const scope = { [Symbol.for(REGISTRY_KEY)]: { version: 2, providers: new Map() } };
  await assert.rejects(guard(scope)(ctx), /unavailable or unsupported/);
});

test('a global provider with active work blocks compaction', async () => {
  const root = registry([['worker', provider({ scope: 'global', listActiveWork: () => [{ id: 'run-1', sessionId: 'detached' }] })]]);
  assert.equal(registeredWorkIdle(['session'], root), false);
  assert.equal(await guard(root)(ctx), null);
});

test('a global provider with no active work stays idle', async () => {
  const root = registry([['worker', provider({ scope: 'global' })]]);
  assert.equal(registeredWorkIdle(['session'], root), true);
  const token = await guard(root)(ctx); assert.ok(token); await token.release();
});

test('a global provider is not filtered by session identity', async () => {
  const root = registry([['worker', provider({ scope: 'global', listActiveWork: () => [{ id: 'run-1', sessionId: 'session' }] })]]);
  assert.equal(registeredWorkIdle(['different-session'], root), false);
});

test('malformed global work fails closed', async () => {
  const root = registry([['worker', provider({ scope: 'global', listActiveWork: () => [{ id: 'run-1' }] })]]);
  assert.throws(() => registeredWorkIdle(['session'], root), /Invalid background work item/);
  await assert.rejects(guard(root)(ctx), /Invalid background work item/);
});

test('duplicate global work fails closed', async () => {
  const item = { id: 'run-1', sessionId: 'detached' };
  const root = registry([['worker', provider({ scope: 'global', listActiveWork: () => [item, { ...item }] })]]);
  assert.throws(() => registeredWorkIdle(['session'], root), /Duplicate background work item/);
});

test('an invalid provider scope fails validation', async () => {
  const root = registry([['worker', provider({ scope: 'room' })]]);
  await assert.rejects(guard(root)(ctx), /unavailable or unsupported/);
});
