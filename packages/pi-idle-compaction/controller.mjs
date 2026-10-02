export const IDLE_MS = 60 * 60 * 1000;
export const MIN_TOKENS = 100_000;

// Pure timer controller; Pi owns summarization, retained history, and prompts.
// A background admission lease is held through compaction, not merely sampled.
export function createIdleCompactor({ backgroundIdle = async () => false,
  acquireBackgroundLease = undefined, delay = IDLE_MS,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, generation = 0, context, enabled = true, suspended = false;
  let attemptedLeaf, activeLease, state = 'waiting for a settled turn';
  const checks = new Set(), releases = new Set();
  const stop = () => {
    generation++;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const leaf = ctx => ctx.sessionManager.getLeafId();
  const hasNewMessages = ctx => {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === 'compaction') return false;
      if (branch[i].type === 'message' &&
          ['user', 'assistant'].includes(branch[i].message.role)) return true;
    }
    return false;
  };
  const eligible = ctx => enabled && !suspended && !activeLease && ctx.isIdle() &&
    !ctx.hasPendingMessages() && hasNewMessages(ctx) &&
    leaf(ctx) !== attemptedLeaf &&
    Number.isFinite(ctx.getContextUsage()?.tokens) &&
    ctx.getContextUsage().tokens >= MIN_TOKENS;

  const manageLease = lease => {
    let promise;
    const managed = { release: () => {
      if (promise) return promise;
      promise = Promise.resolve().then(() => lease.release()).then(() => true, () => {
        enabled = false; stop(); state = 'disabled: background lease release failed';
        return false;
      }).finally(() => {
        releases.delete(promise);
        if (activeLease === managed) activeLease = undefined;
      });
      releases.add(promise);
      return promise;
    } };
    return managed;
  };
  const releaseActive = () => activeLease?.release();

  const attempt = async (ctx, version) => {
    if (version !== generation) return;
    if (!eligible(ctx)) { state = `skipped: busy, unchanged, or below ${MIN_TOKENS} tokens`; return; }
    const originalLeaf = leaf(ctx);
    let admitted;
    try {
      if (acquireBackgroundLease) admitted = await acquireBackgroundLease(ctx);
      else if (await backgroundIdle(ctx)) admitted = { release: async () => {} };
    } catch { /* Unknown background state fails closed. */ }
    const lease = admitted && typeof admitted.release === 'function' ? manageLease(admitted) : undefined;
    if (version !== generation) { await lease?.release(); return; }
    if (!lease) {
      arm(ctx); // Wait another full idle period; never compact on unknown status.
      state = 'deferred: background work active or status unavailable';
      return;
    }
    if (!eligible(ctx) || leaf(ctx) !== originalLeaf) { await lease.release(); return; }
    activeLease = lease;
    attemptedLeaf = originalLeaf;
    state = 'compaction requested';
    let finished = false;
    const finish = async outcome => {
      if (finished) return;
      finished = true;
      const released = await lease.release();
      if (context === ctx && released) { stop(); state = outcome; }
    };
    try {
      ctx.compact({
        onComplete: () => { void finish('compacted'); },
        onError: () => { void finish('failed; retry only after new conversation'); },
      });
    } catch { await finish('failed; retry only after new conversation'); }
  };
  const arm = ctx => {
    stop();
    context = ctx;
    if (!enabled || suspended) return;
    const version = generation;
    state = 'idle timer armed';
    timer = setTimer(async () => {
      timer = undefined;
      const task = attempt(ctx, version);
      checks.add(task);
      try { await task; } finally { checks.delete(task); }
    }, delay);
    timer?.unref?.();
  };
  return {
    settled(ctx) { arm(ctx); },
    activity() { stop(); state = 'active'; },
    suspend() { suspended = true; stop(); },
    resume(ctx) { suspended = false; arm(ctx); },
    reset(ctx) { stop(); attemptedLeaf = undefined; suspended = false; context = ctx; arm(ctx); },
    compacted() { stop(); suspended = false; state = 'compacted'; void releaseActive(); },
    failed() { stop(); suspended = false; state = 'failed; retry only after new conversation'; void releaseActive(); },
    async shutdown() {
      stop(); context = undefined;
      // Invalidate/cancel RPC in the adapter first. Admission finishing after
      // shutdown observes the changed generation and releases its own lease.
      await Promise.allSettled([...checks]);
      await releaseActive();
      await Promise.allSettled([...releases]);
    },
    setEnabled(value, ctx) { enabled = value; stop(); state = value ? 'enabled' : 'disabled'; if (value) arm(ctx); },
    status() { return `${enabled ? 'Enabled' : 'Disabled'}: ${IDLE_MS / 60000} minutes idle, at least ${MIN_TOKENS} tokens context. ${state}.`; },
  };
}
