/** Local admission only: reserve foreground by never gating it, defer NEW worker
 * requests while foreground is active, bound worker requests/subprocesses and age
 * waiting workers after 30s. Running streams/processes are never silently aborted.
 * This cannot reserve a provider's server capacity or guarantee network latency.
 */
export class Admission {
  foreground = false;
  private running = { model: 0, subprocess: 0 };
  private waiting: { kind: 'model' | 'subprocess'; at: number; signal?: AbortSignal; grant: (release: () => void) => void; reject: (error: Error) => void; cleanup: () => void }[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  readonly modelLimit: number;
  readonly maxWaiting: number;
  readonly agingMs: number;
  constructor(modelLimit = 2, maxWaiting = 32, agingMs = 30000) { this.modelLimit = modelLimit; this.maxWaiting = maxWaiting; this.agingMs = agingMs; }
  setForeground(active: boolean): void { this.foreground = active; this.pump(); }
  acquire(kind: 'model' | 'subprocess', signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted(); if (this.closed) return Promise.reject(new Error('Worker admission stopped.'));
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(new Error('Worker admission queue full.'));
    return new Promise((grant, reject) => {
      const abort = () => { const index = this.waiting.indexOf(item); if (index >= 0) { this.waiting.splice(index, 1); item.cleanup(); reject(new Error('Worker admission cancelled.')); this.pump(); } };
      const item = { kind, at: Date.now(), signal, grant, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true }); this.waiting.push(item); this.pump();
    });
  }
  private pump(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.closed) return;
    for (const kind of ['model', 'subprocess'] as const) {
      const limit = kind === 'model' ? this.modelLimit : 1;
      while (this.running[kind] < limit) {
        const index = this.waiting.findIndex(w => w.kind === kind);
        if (index < 0) break;
        const item = this.waiting[index]!;
        if (this.foreground && Date.now() - item.at < this.agingMs) break;
        this.waiting.splice(index, 1); item.cleanup(); this.running[kind]++;
        let released = false; item.grant(() => { if (!released) { released = true; this.running[kind]--; this.pump(); } });
      }
    }
    // A full lane wakes on release, not a 1ms loop after its oldest waiter ages.
    const deadlines = this.foreground ? this.waiting.filter(w => this.running[w.kind] < (w.kind === 'model' ? this.modelLimit : 1)).map(w => w.at + this.agingMs) : [];
    if (deadlines.length) { this.timer = setTimeout(() => this.pump(), Math.max(1, Math.min(...deadlines) - Date.now())); this.timer.unref(); }
  }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; for (const item of this.waiting.splice(0)) { item.cleanup(); item.reject(new Error('Worker admission stopped.')); } }
}
