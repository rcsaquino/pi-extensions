// Once-per-day session reset, gated by the same idle period as idle compaction.
// The host exposes ctx.newSession() only to command handlers, so the adapter
// dispatches the internal `idle-daily-reset` command through sendUserMessage.

export const RESULT_TIMEOUT_MS = 60_000;
export const RETRY_MS = 60_000;

export function nextLocalMidnight(nowMs) {
  const date = new Date(nowMs);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

export function createDailySessionReset({
  idleMs,
  requestReset,
  admit = async _ctx => ({ release: async () => {} }),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw Error('idleMs must be a positive number');
  if (typeof requestReset !== 'function') throw Error('requestReset must be a function');
  if (typeof admit !== 'function') throw Error('admit must be a function');

  let context, idleSince, pending = false, closed = false, enabled = true, suspended = false;
  let midnightTimer, idleTimer, guard, requesting = false, checking = false;
  let midnightVersion = 0, idleVersion = 0, guardVersion = 0, admissionVersion = 0;
  let state = 'waiting for a settled turn';

  const stopMidnight = () => {
    midnightVersion++;
    if (midnightTimer !== undefined) clearTimer(midnightTimer);
    midnightTimer = undefined;
  };
  const stopIdle = () => {
    idleVersion++;
    if (idleTimer !== undefined) clearTimer(idleTimer);
    idleTimer = undefined;
  };
  const clearGuard = () => {
    guardVersion++;
    if (guard !== undefined) clearTimer(guard);
    guard = undefined;
  };
  const invalidateAdmission = () => { admissionVersion++; };
  const hasConversation = ctx => ctx.sessionManager.getBranch().some(entry =>
    entry.type === 'message' && entry.message &&
    (entry.message.role === 'user' || entry.message.role === 'assistant'));
  const safely = (fn, failure) => {
    try { fn(); } catch { state = failure; }
  };
  const releaseLease = async lease => {
    if (!lease || typeof lease.release !== 'function') return;
    try { await lease.release(); } catch { /* Observation leases must not block a reset. */ }
  };

  const scheduleMidnight = () => {
    stopMidnight();
    if (closed || !enabled) return;
    const version = midnightVersion;
    const at = nextLocalMidnight(now());
    midnightTimer = setTimer(() => {
      midnightTimer = undefined;
      if (version !== midnightVersion) return;
      safely(midnightReached, 'skipped: midnight check failed');
    }, Math.max(1, at - now()));
    midnightTimer?.unref?.();
  };

  const scheduleIdle = at => {
    stopIdle();
    if (closed || !enabled || suspended) return;
    const version = idleVersion;
    idleTimer = setTimer(() => {
      idleTimer = undefined;
      if (version !== idleVersion) return;
      safely(runAttempt, 'skipped: idle check failed');
    }, Math.max(1, at - now()));
    idleTimer?.unref?.();
  };

  const armIdle = (notBefore = 0) => {
    stopIdle();
    if (closed || !enabled || suspended || !context || !pending) return;
    if (idleSince === undefined) {
      state = 'pending: waiting for the session to settle';
      return;
    }
    scheduleIdle(Math.max(idleSince + idleMs + 1, notBefore));
    state = 'pending: reset when the idle timer elapses';
  };

  const runAttempt = () => {
    void attempt().catch(() => { state = 'skipped: idle check failed'; });
  };

  const attempt = async () => {
    stopIdle();
    if (checking) return;
    if (closed || !enabled || suspended || !context || !pending) return;
    if (!context.isIdle() || context.hasPendingMessages()) {
      // Wait for the next settled turn rather than retrying against a busy session.
      idleSince = undefined;
      armIdle();
      state = 'deferred: session is busy';
      return;
    }
    if (!hasConversation(context)) {
      pending = false;
      state = 'skipped: no conversation to reset';
      return;
    }
    if (idleSince === undefined || now() - idleSince < idleMs) {
      armIdle();
      state = 'deferred: idle timer has not elapsed';
      return;
    }
    const version = ++admissionVersion;
    checking = true;
    let lease;
    try {
      lease = await admit(context);
    } catch {
      lease = null;
    } finally {
      checking = false;
    }
    if (version !== admissionVersion || closed || !enabled || suspended || !pending || !context) {
      await releaseLease(lease);
      // Re-arm against the new state; the invalidation may have arrived while
      // this check was in flight and stopped its timer.
      if (!closed) armIdle();
      return;
    }
    if (!lease || typeof lease.release !== 'function') {
      armIdle(now() + RETRY_MS);
      state = 'deferred: background work active or status unavailable';
      return;
    }
    if (!context.isIdle() || context.hasPendingMessages() || idleSince === undefined || now() - idleSince < idleMs) {
      await releaseLease(lease);
      if (!context.isIdle() || context.hasPendingMessages()) {
        idleSince = undefined;
        armIdle();
        state = 'deferred: session is busy';
      } else {
        armIdle();
        state = 'deferred: idle timer has not elapsed';
      }
      return;
    }
    await releaseLease(lease);
    pending = false;
    requesting = true;
    state = 'requested: starting a new session';
    try {
      requestReset();
    } catch (error) {
      requesting = false;
      state = `failed: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    if (!requesting || closed) return;
    const versionGuard = guardVersion;
    guard = setTimer(() => {
      guard = undefined;
      if (versionGuard !== guardVersion || closed) return;
      requesting = false;
      pending = false;
      state = 'no result from the new-session request; next midnight';
    }, RESULT_TIMEOUT_MS);
    guard?.unref?.();
  };

  const midnightReached = () => {
    pending = true;
    state = 'pending: local midnight reached';
    scheduleMidnight();
    runAttempt();
  };

  scheduleMidnight();

  return {
    reset(ctx) {
      context = ctx;
      closed = false;
      suspended = false;
      idleSince = now();
      pending = false;
      requesting = false;
      invalidateAdmission();
      clearGuard();
      stopIdle();
      scheduleMidnight();
      state = 'armed for the next local midnight';
    },
    settled(ctx) {
      context = ctx;
      idleSince = now();
      invalidateAdmission();
      if (!pending) state = 'idle; waiting for the next local midnight';
      armIdle();
    },
    activity() {
      idleSince = undefined;
      invalidateAdmission();
      stopIdle();
      state = pending ? 'pending: waiting for the session to settle' : 'active';
    },
    suspend() {
      suspended = true;
      invalidateAdmission();
      stopIdle();
      state = 'suspended';
    },
    resume(ctx) {
      context = ctx;
      suspended = false;
      idleSince = now();
      invalidateAdmission();
      armIdle();
    },
    shutdown() {
      closed = true;
      requesting = false;
      invalidateAdmission();
      clearGuard();
      stopIdle();
      stopMidnight();
      state = 'shutdown';
    },
    setEnabled(value, ctx) {
      enabled = value;
      if (ctx) context = ctx;
      invalidateAdmission();
      clearGuard();
      stopIdle();
      stopMidnight();
      requesting = false;
      state = value ? 'enabled' : 'disabled';
      if (value) {
        scheduleMidnight();
        armIdle();
      }
    },
    finish(result) {
      clearGuard();
      if (closed) return;
      requesting = false;
      invalidateAdmission();
      if (result && result.error) {
        pending = false;
        state = 'failed; retry at the next midnight';
      } else if (result && result.cancelled) {
        pending = true;
        idleSince = now();
        state = 'cancelled; waiting for a fresh idle period';
      } else {
        pending = false;
        state = 'new session started';
      }
      armIdle();
    },
    status() {
      return `Daily reset: ${state}.`;
    },
    isRequestPending() {
      return requesting;
    },
  };
}
