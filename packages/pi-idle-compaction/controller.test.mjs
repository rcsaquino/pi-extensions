import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdleCompactor, IDLE_MS } from './controller.mjs';

function setup(backgroundIdle = async () => true, options = {}) {
  let next = 0, tokens = 120_000, idle = true, pending = false, id = 'a';
  let branch = [{ type: 'message', message: { role: 'assistant' } }];
  const timers = new Map(), calls = [];
  const ctx = {
    isIdle: () => idle, hasPendingMessages: () => pending,
    getContextUsage: () => ({ tokens }),
    sessionManager: { getLeafId: () => id, getBranch: () => branch },
    compact: options => calls.push(options),
  };
  const c = createIdleCompactor({ backgroundIdle, ...options,
    setTimer: (fn, ms) => { assert.equal(ms, IDLE_MS); timers.set(++next, fn); return next; },
    clearTimer: key => timers.delete(key),
  });
  return { c, ctx, calls, timers,
    set: values => { if ('tokens' in values) tokens = values.tokens; if ('idle' in values) idle = values.idle;
      if ('pending' in values) pending = values.pending; if ('id' in values) id = values.id;
      if ('branch' in values) branch = values.branch; },
    fire: async () => { const [key, fn] = timers.entries().next().value; timers.delete(key); await fn(); },
  };
}

test('60-minute timer invokes native compaction without overriding history or prompt', async () => {
  const s = setup(); s.c.settled(s.ctx); assert.equal(s.calls.length, 0);
  await s.fire(); assert.equal(s.calls.length, 1);
  assert.deepEqual(Object.keys(s.calls[0]).sort(), ['onComplete', 'onError']);
});
for (const values of [{ tokens: 99_999 }, { tokens: null }, { tokens: undefined }, { tokens: NaN }, { tokens: Infinity }, { idle: false }, { pending: true },
  { branch: [{ type: 'compaction' }] }]) {
  test(`skip ${JSON.stringify(values)}`, async () => {
    const s = setup(); s.set(values); s.c.settled(s.ctx); await s.fire(); assert.equal(s.calls.length, 0);
  });
}
test('input cancels timer; settled turn starts a fresh timer', () => {
  const s = setup(); s.c.settled(s.ctx); s.c.activity(); assert.equal(s.timers.size, 0);
  s.c.settled(s.ctx); assert.equal(s.timers.size, 1);
});
test('blocked or unknown background status defers a full idle period', async () => {
  for (const check of [async () => false, async () => { throw Error('unavailable'); }]) {
    const s = setup(check); s.c.settled(s.ctx); await s.fire();
    assert.equal(s.calls.length, 0); assert.equal(s.timers.size, 1);
  }
});
test('input during background check invalidates the pending request', async () => {
  let resolve; const s = setup(() => new Promise(r => { resolve = r; }));
  s.c.settled(s.ctx); const fired = s.fire(); s.c.activity(); resolve(true); await fired;
  assert.equal(s.calls.length, 0);
});
test('history changes during background check invalidate request', async () => {
  let resolve; const s = setup(() => new Promise(r => { resolve = r; }));
  s.c.settled(s.ctx); const fired = s.fire(); s.set({ id: 'b' }); resolve(true); await fired;
  assert.equal(s.calls.length, 0);
});
test('no repeat on unchanged history even after failure', async () => {
  const s = setup(); s.c.settled(s.ctx); await s.fire(); s.calls[0].onError(Error());
  await new Promise(setImmediate); // Wait for admission lease cleanup to finish.
  s.c.settled(s.ctx); await s.fire(); assert.equal(s.calls.length, 1);
  s.set({ id: 'b' }); s.c.settled(s.ctx); await s.fire(); assert.equal(s.calls.length, 2);
});
test('suspension, disable, and shutdown clear timers', () => {
  const s = setup(); s.c.settled(s.ctx); s.c.suspend(); s.c.settled(s.ctx); assert.equal(s.timers.size, 0);
  s.c.resume(s.ctx); assert.equal(s.timers.size, 1);
  s.c.setEnabled(false, s.ctx); s.c.settled(s.ctx); assert.equal(s.timers.size, 0);
  s.c.setEnabled(true, s.ctx); assert.equal(s.timers.size, 1);
  s.c.shutdown(); assert.equal(s.timers.size, 0);
});
test('compaction and session reset invalidate old timers', () => {
  const s = setup(); s.c.settled(s.ctx); s.c.compacted(); assert.equal(s.timers.size, 0);
  s.c.reset(s.ctx); assert.equal(s.timers.size, 1);
});

test('100,000 token boundary compacts and status reports the threshold', async () => {
  const s = setup(); s.set({ tokens: 100_000 }); s.c.settled(s.ctx);
  assert.match(s.c.status(), /60 minutes idle, at least 100000 tokens context/);
  await s.fire(); assert.equal(s.calls.length, 1);
});

test("idle duration is sixty minutes", () => { assert.equal(IDLE_MS, 60 * 60 * 1000); });

test('dropping below token threshold during background check prevents compaction', async () => {
  let resolve; const s = setup(() => new Promise(r => { resolve = r; }));
  s.c.settled(s.ctx); const fired = s.fire(); s.set({ tokens: 99999 }); resolve(true); await fired;
  assert.equal(s.calls.length, 0);
});

for (const outcome of ['complete', 'error', 'synchronous-throw', 'shutdown']) {
  test(`background lease remains held through compaction and releases on ${outcome}`, async () => {
    let released = 0;
    const s = setup(undefined, { acquireBackgroundLease: async () => ({ release: async () => { released++; } }) });
    if (outcome === 'synchronous-throw') s.ctx.compact = () => { throw Error('failed'); };
    s.c.settled(s.ctx); await s.fire();
    if (outcome === 'synchronous-throw') { assert.equal(released, 1); return; }
    assert.equal(released, 0);
    if (outcome === 'shutdown') await s.c.shutdown();
    else {
      if (outcome === 'complete') { s.c.compacted(); s.calls[0].onComplete(); }
      else { s.c.failed(); s.calls[0].onError(Error()); }
      await new Promise(setImmediate);
    }
    assert.equal(released, 1, 'release remains idempotent across lifecycle events and callbacks');
  });
}
for (const invalidation of ['input', 'history', 'tokens', 'pending', 'disable', 'shutdown']) {
  test(`admitted lease is released after ${invalidation} invalidates the check`, async () => {
    let resolve, released = 0;
    const s = setup(undefined, { acquireBackgroundLease: () => new Promise(r => { resolve = r; }) });
    s.c.settled(s.ctx); const fired = s.fire();
    let shutdown;
    if (invalidation === 'input') s.c.activity();
    if (invalidation === 'history') s.set({ id: 'changed' });
    if (invalidation === 'tokens') s.set({ tokens: 0 });
    if (invalidation === 'pending') s.set({ pending: true });
    if (invalidation === 'disable') s.c.setEnabled(false, s.ctx);
    if (invalidation === 'shutdown') shutdown = s.c.shutdown();
    resolve({ release: async () => { released++; } });
    await fired; await shutdown;
    assert.equal(s.calls.length, 0); assert.equal(released, 1);
  });
}
test('no second compaction can start while the first admission lease is held', async () => {
  let acquired = 0;
  const s = setup(undefined, { acquireBackgroundLease: async () => { acquired++; return { release: async () => {} }; } });
  s.c.settled(s.ctx); await s.fire();
  s.set({ id: 'new-leaf' }); s.c.settled(s.ctx); await s.fire();
  assert.equal(s.calls.length, 1); assert.equal(acquired, 1);
  await s.c.shutdown();
});
test('lease release failure disables rather than admitting more compactions', async () => {
  const s = setup(undefined, { acquireBackgroundLease: async () => ({ release: async () => { throw Error('owner changed'); } }) });
  s.c.settled(s.ctx); await s.fire(); s.calls[0].onComplete();
  await new Promise(setImmediate);
  assert.match(s.c.status(), /^Disabled:.*lease release failed/);
  s.set({ id: 'next' }); s.c.settled(s.ctx); assert.equal(s.timers.size, 0);
});
