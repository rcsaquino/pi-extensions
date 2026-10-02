import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireAutoLearnLease, createBackgroundGuard, LEGACY_REGISTRY_KEY } from './background.mjs';

const root = dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const sandbox = await mkdtemp(join(root, '.guard-test-'));
  const state = join(sandbox, 'auto-learn');
  await mkdir(join(state, 'locks'), { recursive: true, mode: 0o700 });
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return { sandbox, state };
}
const ctx = { sessionManager: { getSessionId: () => 'session', getSessionFile: () => '/mock/session.jsonl' } };
const validReply = method => method === 'ping' ? { session: { sessionFile: '/mock/session.jsonl' } }
  : { fleet: { version: 1, totalActive: 0, topLevelAsyncCapacity: { used: 0 } } };
function guard(options = {}) {
  return createBackgroundGuard({ getTools: () => [], rpc: async () => { throw Error('RPC must not run'); },
    autoLearnRoot: () => '/unused', scope: {}, acquireLease: async () => ({ release: async () => {} }), ...options });
}

test('standalone guard never asks an absent subagent extension for RPC', async () => {
  const lease = await guard()(ctx); assert.ok(lease); await lease.release();
});
for (const tool of ['subagent', 'subagents_enable', 'subagent_supervisor', 'bg_wait']) {
  test(`present ${tool} requires healthy optional RPC`, async () => {
    const requests = [];
    const lease = await guard({ getTools: () => [{ name: tool }], rpc: async method => { requests.push(method); return validReply(method); } })(ctx);
    assert.ok(lease); assert.deepEqual(requests, ['ping', 'status']); await lease.release();
  });
}
for (const [name, rpc] of [
  ['missing responder', async () => null],
  ['wrong session', async () => ({ session: { sessionId: 'other' } })],
  ['active children', async method => method === 'ping' ? validReply(method) : { fleet: { version: 1, totalActive: 1, topLevelAsyncCapacity: { used: 0 } } }],
  ['used capacity', async method => method === 'ping' ? validReply(method) : { fleet: { version: 1, totalActive: 0, topLevelAsyncCapacity: { used: 1 } } }],
  ['missing fleet', async method => method === 'ping' ? validReply(method) : {}],
  ['status failure', async method => method === 'ping' ? validReply(method) : { ...validReply(method), isError: true }],
]) {
  test(`present runner fails closed: ${name}`, async () => {
    assert.equal(await guard({ getTools: () => [{ name: 'subagents_enable' }], rpc })(ctx), null);
  });
}

test('auto-learn tool requires coordination state without editing its configuration', async () => {
  let required;
  const lease = await guard({ getTools: () => [{ name: 'auto_learn_status' }], acquireLease: async (_root, value) => {
    required = value; return { release: async () => {} };
  } })(ctx);
  assert.equal(required, true); await lease.release();
});
test('unknown tool inventory is not silently interpreted as idle', async () => {
  await assert.rejects(guard({ getTools: () => null })(ctx));
});
test('provider appearing during admission releases the acquired lease', async () => {
  const scope = {}; let released = 0;
  const result = await guard({ scope, acquireLease: async () => {
    scope[Symbol.for(LEGACY_REGISTRY_KEY)] = { version: 1, providers: new Map([['job', {
      name: 'job', listActiveWork: () => [{ id: 'a', sessionId: '/mock/session.jsonl' }],
    }]]) };
    return { release: async () => { released++; } };
  } })(ctx);
  assert.equal(result, null); assert.equal(released, 1);
});

test('both auto-learn admission leases stay held until explicit release', async t => {
  const { state } = await fixture(t);
  const lease = await acquireAutoLearnLease(state, true); assert.ok(lease);
  assert.deepEqual((await readdir(join(state, 'locks'))).sort(), ['worker', 'writer']);
  for (const name of ['worker', 'writer']) {
    const owner = JSON.parse(await readFile(join(state, 'locks', name, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid); assert.equal(typeof owner.token, 'string');
  }
  assert.equal(await acquireAutoLearnLease(state, true), null);
  await lease.release(); await lease.release();
  assert.deepEqual(await readdir(join(state, 'locks')), []);
});
test('uses the existing auto-learn lease protocol without importing it at runtime', async t => {
  const { state } = await fixture(t);
  const { acquireLock, BusyError } = await import('../pi-auto-learn/src/lock.ts');
  const lease = await acquireAutoLearnLease(state, true);
  for (const name of ['worker', 'writer']) await assert.rejects(acquireLock(state, name), BusyError);
  await lease.release();
  for (const name of ['worker', 'writer']) { const release = await acquireLock(state, name); await release(); }
});
test('existing writer lease rejects admission and releases only our worker lease', async t => {
  const { state } = await fixture(t);
  await mkdir(join(state, 'locks', 'writer'));
  await writeFile(join(state, 'locks', 'writer', 'owner.json'), '{"existing":true}');
  assert.equal(await acquireAutoLearnLease(state, true), null);
  assert.deepEqual(await readdir(join(state, 'locks')), ['writer']);
  assert.equal(await readFile(join(state, 'locks', 'writer', 'owner.json'), 'utf8'), '{"existing":true}');
});
test('existing worker lease, including uncertain stale ownership, is never stolen', async t => {
  const { state } = await fixture(t);
  await mkdir(join(state, 'locks', 'worker'));
  await writeFile(join(state, 'locks', 'worker', 'owner.json'), 'malformed');
  assert.equal(await acquireAutoLearnLease(state, true), null);
  assert.equal(await readFile(join(state, 'locks', 'worker', 'owner.json'), 'utf8'), 'malformed');
});
test('absent optional auto-learn is supported, absent required state fails closed', async t => {
  const { sandbox } = await fixture(t); const missing = join(sandbox, 'missing');
  const lease = await acquireAutoLearnLease(missing, false); await lease.release();
  await assert.rejects(acquireAutoLearnLease(missing, true));
  assert.ok(!(await readdir(sandbox)).includes('missing'), 'do not bootstrap foreign state');
});
test('unsafe symlink coordination roots are refused', async t => {
  const { sandbox, state } = await fixture(t);
  const link = join(sandbox, 'link'); await symlink(state, link);
  await assert.rejects(acquireAutoLearnLease(link, false));
  assert.deepEqual(await readdir(join(state, 'locks')), []);
});
test('changed lease ownership refuses release rather than deleting someone else\'s lease', async t => {
  const { state } = await fixture(t); const lease = await acquireAutoLearnLease(state, true);
  const path = join(state, 'locks', 'writer', 'owner.json');
  await writeFile(path, JSON.stringify({ pid: process.pid, token: 'different-owner' }));
  await assert.rejects(lease.release());
  assert.equal(JSON.parse(await readFile(path, 'utf8')).token, 'different-owner');
});
