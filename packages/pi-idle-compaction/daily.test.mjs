import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailySessionReset, nextLocalMidnight, RESULT_TIMEOUT_MS, RETRY_MS } from './daily.mjs';

const MIN = 60_000;
const IDLE = 60 * MIN;

function at(hours, minutes, seconds = 0, day = 24) {
  return new Date(2026, 10, day, hours, minutes, seconds, 0).getTime();
}

function setup(options = {}) {
  let now = options.now ?? at(23, 0);
  let idle = options.idle ?? true;
  let pendingMessages = options.pendingMessages ?? false;
  let branch = options.branch ?? [{ type: 'message', message: { role: 'assistant' } }];
  const timers = new Map();
  let nextId = 0;
  const resets = [];
  const ctx = {
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    sessionManager: { getBranch: () => branch },
  };
  const daily = createDailySessionReset({
    idleMs: options.idleMs ?? IDLE,
    requestReset: () => resets.push(now),
    admit: options.admit,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++nextId;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: id => timers.delete(id),
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const nextTimer = () => {
    let best;
    for (const [id, timer] of timers) {
      if (!best || timer.at < best.timer.at) best = { id, timer };
    }
    return best;
  };
  const nextAt = () => nextTimer()?.timer.at;
  const fireNext = async () => {
    const next = nextTimer();
    if (!next) return false;
    timers.delete(next.id);
    now = Math.max(now, next.timer.at);
    next.timer.fn();
    await flush();
    return true;
  };
  const advanceTo = async target => {
    for (let i = 0; i < 200; i++) {
      const next = nextAt();
      if (next === undefined || next > target) break;
      await fireNext();
    }
    if (nextAt() !== undefined && nextAt() <= target) throw Error('timer loop');
    now = Math.max(now, target);
  };
  return {
    daily, ctx, resets, timers, nextAt, fireNext, advanceTo, flush,
    now: () => now,
    setNow: value => { now = value; },
    set: values => {
      if ('idle' in values) idle = values.idle;
      if ('pendingMessages' in values) pendingMessages = values.pendingMessages;
      if ('branch' in values) branch = values.branch;
    },
  };
}

test('no reset before the next local midnight', async () => {
  const s = setup();
  s.daily.settled(s.ctx);
  assert.equal(s.nextAt(), at(0, 0, 0, 25));
  await s.advanceTo(at(23, 59, 59));
  assert.equal(s.resets.length, 0);
});

test('resets at midnight when the session already idled long enough', async () => {
  const s = setup();
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.deepEqual(s.resets, [at(0, 0, 0, 25)]);
});

test('last settle at 23:30 defers the reset to 00:30', async () => {
  const s = setup();
  s.setNow(at(23, 30));
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0, 'must not reset at midnight');
  await s.advanceTo(at(0, 29, 59, 25));
  assert.equal(s.resets.length, 0, 'must not reset before the idle period');
  await s.advanceTo(at(0, 30, 1, 25));
  assert.equal(s.resets.length, 1);
  assert.ok(s.resets[0] >= at(0, 30, 0, 25) && s.resets[0] < at(0, 31, 0, 25));
});

test('activity just before midnight keeps the midnight check and waits for the next idle period', async () => {
  const s = setup();
  s.daily.settled(s.ctx);
  s.setNow(at(23, 59, 59));
  s.set({ idle: false });
  s.daily.activity();
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0, 'busy session must not reset');
  s.set({ idle: true });
  s.setNow(at(0, 5, 0, 25));
  s.daily.settled(s.ctx);
  await s.advanceTo(at(1, 4, 59, 25));
  assert.equal(s.resets.length, 0);
  await s.advanceTo(at(1, 5, 1, 25));
  assert.equal(s.resets.length, 1);
  assert.ok(s.resets[0] >= at(1, 5, 0, 25));
});

test('an empty session does not reset and arms the next midnight', async () => {
  const s = setup({ branch: [] });
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0);
  assert.equal(s.nextAt(), at(0, 0, 0, 26));
});

test('pending messages defer until the next settled turn', async () => {
  const s = setup({ pendingMessages: true });
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0);
  assert.equal(s.nextAt(), at(0, 0, 0, 26), 'no busy retry before the next midnight');
  s.set({ pendingMessages: false });
  s.setNow(at(0, 10, 0, 25));
  s.daily.settled(s.ctx);
  await s.advanceTo(at(1, 10, 1, 25));
  assert.equal(s.resets.length, 1);
});

test('disabled and shutdown sessions never reset', async () => {
  const s = setup();
  s.daily.settled(s.ctx);
  s.daily.setEnabled(false, s.ctx);
  assert.equal(s.nextAt(), undefined);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0);
  s.daily.setEnabled(true, s.ctx);
  assert.equal(s.nextAt(), at(0, 0, 0, 26));
  s.daily.shutdown();
  assert.equal(s.nextAt(), undefined);
});

test('a cancelled new session waits a fresh idle period instead of retrying immediately', async () => {
  const s = setup();
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 1);
  assert.equal(s.daily.isRequestPending(), true);
  s.daily.finish({ cancelled: true });
  assert.equal(s.daily.isRequestPending(), false);
  await s.advanceTo(at(0, 59, 59, 25));
  assert.equal(s.resets.length, 1, 'must not retry inside the idle period');
  await s.advanceTo(at(1, 0, 1, 25));
  assert.equal(s.resets.length, 2);
  assert.ok(s.resets[1] >= at(1, 0, 0, 25));
});

test('a successful new session plus shutdown leaves no timer', async () => {
  const s = setup();
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  s.daily.finish({});
  s.daily.shutdown();
  assert.equal(s.resets.length, 1);
  assert.equal(s.nextAt(), undefined);
});

test('a missing result falls back to the next midnight after the guard', async () => {
  const s = setup();
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 1);
  assert.equal(s.nextAt(), at(0, 0, 0, 25) + RESULT_TIMEOUT_MS);
  await s.advanceTo(at(0, 1, 0, 25));
  assert.equal(s.nextAt(), at(0, 0, 0, 26));
  assert.equal(s.resets.length, 1);
  assert.match(s.daily.status(), /next midnight/);
});

test('suspend stops the idle attempt and resume starts a fresh idle period', async () => {
  const s = setup();
  s.setNow(at(23, 30));
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0);
  s.setNow(at(0, 10, 0, 25));
  s.daily.suspend();
  await s.advanceTo(at(0, 30, 1, 25));
  assert.equal(s.resets.length, 0, 'a suspended session must not reset');
  s.setNow(at(0, 40, 0, 25));
  s.daily.resume(s.ctx);
  await s.advanceTo(at(1, 39, 59, 25));
  assert.equal(s.resets.length, 0);
  await s.advanceTo(at(1, 40, 1, 25));
  assert.equal(s.resets.length, 1);
  assert.ok(s.resets[0] >= at(1, 40, 0, 25));
});

test('a shorter idle period moves the deferred reset earlier', async () => {
  const s = setup({ idleMs: 30 * MIN });
  s.setNow(at(23, 45));
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0);
  await s.advanceTo(at(0, 15, 1, 25));
  assert.equal(s.resets.length, 1);
  assert.ok(s.resets[0] >= at(0, 15, 0, 25));
});

test('background work defers the reset by one minute, then retries', async () => {
  let allow = false;
  const s = setup({ admit: async () => allow ? { release: async () => {} } : null });
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0);
  assert.match(s.daily.status(), /background work active/);
  assert.equal(s.nextAt(), at(0, 0, 0, 25) + RETRY_MS);
  await s.advanceTo(at(0, 0, 59, 25));
  assert.equal(s.resets.length, 0);
  assert.equal(s.nextAt(), at(0, 1, 0, 25));
  allow = true;
  await s.advanceTo(at(0, 1, 0, 25));
  assert.equal(s.resets.length, 1);
});

test('a denied admission retries once per minute, not in a tight loop', async () => {
  const s = setup({ admit: async () => null });
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.nextAt(), at(0, 1, 0, 25));
  await s.advanceTo(at(0, 1, 0, 25));
  assert.equal(s.resets.length, 0);
  assert.equal(s.nextAt(), at(0, 2, 0, 25));
});

test('an admission error behaves like a denial', async () => {
  const s = setup({ admit: async () => { throw Error('status unavailable'); } });
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0);
  assert.match(s.daily.status(), /background work active/);
  assert.equal(s.nextAt(), at(0, 1, 0, 25));
});

test('activity during an in-flight admission invalidates the late grant', async () => {
  let resolveAdmit;
  let releases = 0;
  const pendingAdmission = new Promise(resolve => { resolveAdmit = resolve; });
  const s = setup({ admit: () => pendingAdmission });
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 0);
  s.daily.activity();
  resolveAdmit({ release: async () => { releases++; } });
  await s.flush();
  assert.equal(s.resets.length, 0);
  assert.equal(releases, 1, 'the stale lease must be released');
  s.setNow(at(0, 5, 0, 25));
  s.daily.settled(s.ctx);
  await s.advanceTo(at(1, 5, 1, 25));
  assert.equal(s.resets.length, 1);
});

test('the granted admission lease is released exactly once', async () => {
  let releases = 0;
  const s = setup({ admit: async () => ({ release: async () => { releases++; } }) });
  s.daily.settled(s.ctx);
  await s.advanceTo(at(0, 0, 0, 25));
  assert.equal(s.resets.length, 1);
  assert.equal(releases, 1);
});

test('nextLocalMidnight returns the next local date boundary', () => {
  assert.equal(nextLocalMidnight(at(23, 30)), at(0, 0, 0, 25));
  assert.equal(nextLocalMidnight(at(0, 0, 0, 25)), at(0, 0, 0, 26));
  assert.equal(nextLocalMidnight(at(12, 0, 0, 25)), at(0, 0, 0, 26));
});

test('invalid options fail at the boundary', () => {
  assert.throws(() => createDailySessionReset({ idleMs: 0, requestReset: () => {} }), /idleMs/);
  assert.throws(() => createDailySessionReset({ idleMs: IDLE, requestReset: null }), /requestReset/);
});
