import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY_KEY, LEGACY_REGISTRY_KEY, registeredWorkIdle, registerBackgroundWorkProvider } from './background.mjs';

const sessions = ['/mock/session.jsonl', 'session-id'];
const scopeWith = (providers, version = 1, key = LEGACY_REGISTRY_KEY) => ({
  [Symbol.for(key)]: { version, providers: new Map(providers) },
});
const provider = (name, items = []) => ({ name, listActiveWork: () => items });

test('standalone mode does not need or create a subagent registry', () => {
  const scope = {};
  assert.equal(registeredWorkIdle(sessions, scope), true);
  assert.equal(Reflect.ownKeys(scope).length, 0);
});
for (const key of [REGISTRY_KEY, LEGACY_REGISTRY_KEY]) {
  test(`${key}: current-session work blocks, unrelated-session work does not`, () => {
    assert.equal(registeredWorkIdle(sessions, scopeWith([['worker', provider('worker', [{ id: 'a', sessionId: sessions[0] }])]], 1, key)), false);
    assert.equal(registeredWorkIdle(sessions, scopeWith([['worker', provider('worker', [{ id: 'a', sessionId: sessions[1] }])]], 1, key)), false);
    assert.equal(registeredWorkIdle(sessions, scopeWith([['worker', provider('worker', [{ id: 'a', sessionId: 'other-session' }])]], 1, key)), true);
  });
}
for (const [name, scope] of [
  ['unsupported registry', scopeWith([], 2)],
  ['invalid provider map', { [Symbol.for(LEGACY_REGISTRY_KEY)]: { version: 1, providers: {} } }],
  ['provider identity mismatch', scopeWith([['bad', provider('different')]])],
  ['missing list function', scopeWith([['bad', { name: 'bad' }]])],
  ['throwing provider', scopeWith([['bad', { name: 'bad', listActiveWork: () => { throw Error('unavailable'); } }]])],
  ['throwing reconciler', scopeWith([['bad', { ...provider('bad'), reconcile: () => { throw Error('unavailable'); } }]])],
  ['non-array result', scopeWith([['bad', { name: 'bad', listActiveWork: () => ({}) }]])],
  ['malformed foreign-session item', scopeWith([['bad', provider('bad', [{ id: '', sessionId: 'foreign' }])]])],
  ['duplicate items', scopeWith([['bad', provider('bad', [{ id: 'a', sessionId: 'other' }, { id: 'a', sessionId: 'other' }])]])],
  ['unknown item fields', scopeWith([['bad', provider('bad', [{ id: 'a', sessionId: 'other', unsafe: true }])]])],
  ['asynchronous provider', scopeWith([['bad', { name: 'bad', listActiveWork: () => Promise.resolve([]) }]])],
  ['asynchronous reconciler', scopeWith([['bad', { ...provider('bad'), reconcile: () => Promise.resolve() }]])],
  ['duplicate wake channels', scopeWith([['bad', { ...provider('bad'), wakeChannels: ['a', 'a'] }]])],
  ['provider count ceiling', scopeWith(Array.from({ length: 101 }, (_, i) => [`p${i}`, provider(`p${i}`)]))],
]) {
  test(`fail closed: ${name}`, () => assert.throws(() => registeredWorkIdle(sessions, scope)));
}

test('neutral registration disposer cannot remove a replacement registration', () => {
  const key = Symbol.for(REGISTRY_KEY), previous = globalThis[key];
  delete globalThis[key];
  try {
    const first = registerBackgroundWorkProvider(provider('test'));
    const second = registerBackgroundWorkProvider(provider('test', [{ id: 'job', sessionId: sessions[0] }]));
    first();
    assert.equal(registeredWorkIdle(sessions), false);
    second();
    assert.equal(registeredWorkIdle(sessions), true);
  } finally { if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous; }
});
