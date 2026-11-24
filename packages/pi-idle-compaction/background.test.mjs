import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBackgroundGuard, createDailyResetGuard, REGISTRY_KEY, registeredGlobalWorkIdle, registeredWorkIdle,
} from './background.mjs';

const ctx = { sessionManager: { getSessionId: () => 'session', getSessionFile: () => '/mock/session.jsonl' } };
const guard = (scope = {}) => createBackgroundGuard({ scope });
const dailyGuard = (root = {}) => createDailyResetGuard({ root });
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

test('a global provider blocks the daily reset guard', async () => {
  const root = registry([['worker', provider({ scope: 'global', listActiveWork: () => [{ id: 'run-1', sessionId: 'detached' }] })]]);
  assert.equal(registeredGlobalWorkIdle(root), false);
  assert.equal(await dailyGuard(root)(ctx), null);
});

test('a session provider does not block the global check', async () => {
  const root = registry([['worker', provider({ scope: 'session', listActiveWork: () => [{ id: 'run-1', sessionId: 'session' }] })]]);
  assert.equal(registeredGlobalWorkIdle(root), true);
  assert.equal(await dailyGuard(root)(ctx), null, 'the session check still blocks');
  const other = registry([['worker', provider({ listActiveWork: () => [{ id: 'run-1', sessionId: 'other' }] })]]);
  assert.equal(registeredGlobalWorkIdle(other), true);
  const token = await dailyGuard(other)(ctx); assert.ok(token); await token.release();
});

test('a global provider does not block same-session compaction', async () => {
  const root = registry([['worker', provider({ scope: 'global', listActiveWork: () => [{ id: 'run-1', sessionId: 'session' }] })]]);
  assert.equal(registeredWorkIdle(['session'], root), true);
});

test('a global provider with no work stays idle', async () => {
  const root = registry([['worker', provider({ scope: 'global' })]]);
  assert.equal(registeredGlobalWorkIdle(root), true);
  const token = await dailyGuard(root)(ctx); assert.ok(token); await token.release();
});

test('an invalid provider scope fails validation', async () => {
  const root = registry([['worker', provider({ scope: 'room' })]]);
  await assert.rejects(guard(root)(ctx), /unavailable or unsupported/);
  assert.equal(await dailyGuard(root)(ctx), null, 'the daily guard fails closed');
});

test('malformed global work fails closed', async () => {
  const root = registry([['worker', provider({ scope: 'global', listActiveWork: () => [{ id: 'run-1' }] })]]);
  assert.throws(() => registeredGlobalWorkIdle(root), /Invalid background work item/);
  assert.equal(await dailyGuard(root)(ctx), null);
});

test('duplicate global work fails closed', async () => {
  const item = { id: 'run-1', sessionId: 'detached' };
  const root = registry([['worker', provider({ scope: 'global', listActiveWork: () => [item, { ...item }] })]]);
  assert.throws(() => registeredGlobalWorkIdle(root), /Duplicate background work item/);
});
