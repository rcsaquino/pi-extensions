import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { canonicalPath, captureProfile, estimate, guardTool, routesToBackground, statusLine, validateDispatch, workerOwnsCall } from './policy.ts';
import { Store } from './store.ts';
import type { Dispatch, Job, RecordData } from './types.ts';
import { emptyUsage, isActive } from './types.ts';
import { assistantText, createWorker, finalAssistant } from './worker.ts';
import { buildSettlementReport, safeDiagnostics, safeReason, terminalCategory } from './report.ts';
import type { TerminalView } from './report.ts';
import type { TerminalCategory } from './types.ts';

function abortWorker(job: Job, category: NonNullable<Job['abortCategory']>): void {
  job.abortCategory ??= category;
  if (job.progress) job.progress.failurePhase ??= job.progress.lastPhase;
  job.controller?.abort(); job.agent?.abort();
}
function terminalView(job: Job): TerminalView | undefined {
  // Full-mode inherited assistant history is not a final response from this worker.
  if (!job.agent || !job.record.turns) return undefined;
  const final = finalAssistant(job.agent);
  if (!final) return undefined;
  const content = final.content;
  return { stopReason: final.stopReason, text: assistantText(final),
    hadToolCalls: (Array.isArray(content) && content.some(c => c?.type === 'toolCall')) || !!job.progress?.pendingTools.size,
    malformed: !Array.isArray(content) || content.some(c => !c || !['text', 'thinking', 'toolCall'].includes(c.type) || (c.type === 'text' && typeof c.text !== 'string')) };
}
function captureDiagnostics(job: Job, category: TerminalCategory, view = terminalView(job)): void {
  const p = job.progress;
  job.record.terminalDiagnostics = safeDiagnostics({
    stopReason: view?.stopReason ?? 'missing', category, lastPhase: p?.lastPhase ?? 'unknown',
    ...(category !== 'complete' ? { failurePhase: p?.failurePhase ?? p?.lastPhase ?? 'unknown' } : {}),
    visibleTextCharacters: view?.text.length ?? 0, hadToolCalls: view?.hadToolCalls ?? !!p?.pendingTools.size,
    lastToolOutcome: p?.lastToolOutcome,
  });
}

export class BackgroundManager {
  readonly jobs = new Map<string, Job>();
  store?: Store;
  ctx?: ExtensionContext;
  auto = true;
  closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private writes: Promise<void> = Promise.resolve();
  private notificationScheduled = false;
  private flushingNotifications = false;
  private notices: { id: string; content: string }[] = [];
  private initializations?: Promise<void>;
  readonly pi: ExtensionAPI;
  constructor(pi: ExtensionAPI) { this.pi = pi; }

  async init(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    if (this.initializations) return this.initializations;
    this.initializations = this.initialize(ctx);
    try { await this.initializations; } catch (e) { this.initializations = undefined; throw e; }
  }
  private async initialize(ctx: ExtensionContext): Promise<void> {
    const configured = this.pi.getFlag('background-dir');
    const root = typeof configured === 'string' && configured.trim() ? resolve(ctx.cwd, configured) : join(ctx.cwd, 'temp_files', 'pi-background-tasks');
    this.store = new Store(root, ctx.sessionManager.getSessionId());
    await this.store.init();
    for (const record of await this.store.restore()) {
      const memoryReport = this.store.recoveryReports.get(record.id);
      this.jobs.set(record.id, { record, ...(memoryReport ? { memoryReport, storageFailed: true } : {}) });
    }
    if (this.store.recoveryReports.size) ctx.ui.notify('Some restored background reports could not be saved. Retrieve their in-memory fallback explicitly; check runtime storage.', 'error');
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'background-auto' && typeof (entry.data as { enabled?: unknown })?.enabled === 'boolean') {
        this.auto = (entry.data as { enabled: boolean }).enabled;
      }
    }
    if (ctx.mode === 'rpc' || ctx.mode === 'tui') {
      this.timer = setInterval(() => { void this.monitor(); }, 5000); this.timer.unref();
      this.scheduleNotifications();
    }
    this.render();
  }
  async dispatch(input: Dispatch, ctx: ExtensionToolContext, rootCallId: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    await this.init(ctx); this.assertOpen(); signal?.throwIfAborted();
    const p = validateDispatch(input);
    if (!routesToBackground(p, this.auto)) return {
      content: [{ type: 'text', text: `Run inline. Estimated ${p.eta_seconds}s${p.eta_max_seconds !== p.eta_seconds ? ` to ${p.eta_max_seconds}s` : ''}. ${this.auto ? 'The upper estimate is not more than two minutes.' : 'Automatic delegation is off.'} Basis: ${p.estimate_reason}` }],
      details: { route: 'inline', estimateSeconds: p.eta_seconds, estimateMaxSeconds: p.eta_max_seconds },
    };
    if (ctx.mode !== 'rpc' && ctx.mode !== 'tui') throw new Error('Background tasks require a long-lived TUI or RPC session. Print/JSON processes exit after the foreground run.');
    const profile = captureProfile(ctx);
    const active = [...this.jobs.values()].filter(j => isActive(j.record.status));
    if (active.length >= this.maxWorkers()) throw new Error(`Background capacity reached (${this.maxWorkers()}). No task was queued or started. Finish/cancel a task, then retry.`);
    const cwd = canonicalPath(ctx.cwd);
    if (p.access === 'write' && active.some(j => j.record.access === 'write')) throw new Error('A background writer already owns this workspace. No task was queued or started.');
    // Reserve synchronously before the first async lease operation, including simultaneous sibling dispatch tools.
    const id = `bg-${randomBytes(6).toString('hex')}`;
    const record: RecordData = {
      version: 1, id, title: p.title, sessionId: ctx.sessionManager.getSessionId(), cwd,
      provider: profile.model.provider, model: profile.model.id, thinking: profile.thinking,
      status: 'running', access: p.access, contextMode: p.context_mode, startedAt: Date.now(), etaSeconds: p.eta_seconds,
      etaMaxSeconds: p.eta_max_seconds, estimateReason: p.estimate_reason, lastActivityAt: Date.now(),
      toolCalls: 0, turns: 0, usage: emptyUsage(), usageReported: false, notification: 'read', overrunNotified: false,
    };
    const job: Job = { record, ctx, rootCallId, controller: new AbortController() };
    this.jobs.set(id, job);
    try {
      if (p.access === 'write') job.release = await this.store!.acquireWriter(cwd);
      this.assertOpen(); signal?.throwIfAborted();
      await this.store!.write(record);
      this.pi.events.emit('background-tasks:claim-owner:v1', {
        sessionId: record.sessionId, taskId: id, rootCallId,
        accept: (route: Job['noticeRouter']) => { job.noticeRouter = route; },
      });
      this.pi.appendEntry('background-task', { id, title: record.title, status: record.status, etaSeconds: record.etaSeconds, etaMaxSeconds: record.etaMaxSeconds });
      job.agent = createWorker(this.pi, job, profile, p, {
        changed: () => { this.persist(job); this.render(); },
        checkAlive: () => { this.assertOpen(); job.controller!.signal.throwIfAborted(); },
      });
      // Detach task execution from the tool promise AND the foreground abort signal.
      job.done = new Promise<void>(resolveDone => {
        setImmediate(() => { void this.run(job, p.task).catch(() => {
          if (!this.closed) this.ctx?.ui.notify('Background worker settlement failed. Review its saved state before retrying.', 'error');
        }).finally(resolveDone); });
      });
    } catch (e) {
      this.jobs.delete(id); await job.release?.(); throw e;
    }
    this.render(); this.emitActivity();
    return {
      content: [{ type: 'text', text: `Background task ${id} accepted: ${record.title}. Estimated duration: ${estimate(record)} (not a guarantee). Basis: ${record.estimateReason}\nProvider/model: ${record.provider}/${record.model}; thinking: ${record.thinking}. Context: ${record.contextMode} (${record.contextMode === 'full' ? 'explicit projected-history opt-in' : record.contextMode === 'selected' ? 'supplied reference only; no history copied' : 'task brief only; no history copied'}). Return control now; do not wait or poll. Completion will be reported in the main chat.` }],
      details: { route: 'background', task: structuredClone(record) },
    };
  }
  private async run(job: Job, task: string): Promise<void> {
    let output = '';
    let category: TerminalCategory = 'unknown';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (job.controller!.signal.aborted || this.closed) throw new Error('Cancelled before worker started.');
      const minutes = Number(this.pi.getFlag('background-timeout-minutes') ?? '240');
      timeout = setTimeout(() => {
        abortWorker(job, 'runtime_limit');
      }, (Number.isFinite(minutes) && minutes > 0 ? minutes : 240) * 60_000); timeout.unref();
      await job.agent!.prompt(`Delegated task ${job.record.id}:\n\n${task}`);
      const view = terminalView(job); output = view?.text ?? '';
      category = job.abortCategory ?? (job.record.turns >= 200 ? 'turn_limit'
        : job.controller!.signal.aborted ? 'cancelled' : terminalCategory(view));
      if (category === 'unknown' || category === 'missing_report') category = job.progress?.failureCategory ?? category;
      if (job.record.status !== 'interrupted') job.record.status = category === 'complete' ? 'completed'
        : category === 'cancelled' || category === 'shutdown' ? 'cancelled' : 'failed';
      else category = job.abortCategory ?? 'interrupted';
      if (category !== 'complete') job.record.error = safeReason(category);
    } catch {
      category = job.abortCategory ?? (this.closed ? 'shutdown' : job.controller!.signal.aborted ? 'cancelled' : job.progress?.failureCategory ?? 'unknown');
      if (job.record.status !== 'interrupted') job.record.status = category === 'cancelled' || category === 'shutdown' ? 'cancelled' : 'failed';
      job.record.error = safeReason(category);
    } finally {
      job.settling = true;
      if (timeout) clearTimeout(timeout);
      job.record.finishedAt = Date.now(); job.record.notification = 'pending';
      captureDiagnostics(job, category);
      if (job.progress) job.progress.lastPhase = 'finalizing';
      // Do not release ownership until all cooperating tool calls have settled.
      try { await job.release?.(); job.release = undefined; } catch {
        if (job.record.status === 'completed') {
          job.record.status = 'failed'; category = 'lease_cleanup_error'; captureDiagnostics(job, category);
        }
        job.record.terminalDiagnostics!.leaseCleanupFailed = true;
        job.record.error = safeReason('lease_cleanup_error');
      }
      const report = buildSettlementReport(job.record, output);
      job.record.reportSource = report.source;
      await this.writes.catch(() => {});
      try { await this.store!.write(structuredClone(job.record), report.text); }
      catch {
        if (job.record.status === 'completed') job.record.status = 'failed';
        job.record.error = 'Task result could not be saved. Review workspace effects before retrying.';
        job.record.reportSource = 'fallback'; job.storageFailed = true;
        // No transcripts or unbounded prose retained for storage-failure recovery.
        job.memoryReport = buildSettlementReport(job.record, '', true).text;
        if (!this.closed) this.ctx?.ui.notify('Background task result could not be saved. Retrieve its in-memory fallback explicitly; check runtime storage.', 'error');
      }
      job.settling = false;
      if (!this.closed) {
        this.pi.appendEntry('background-task', { id: job.record.id, status: job.record.status, finishedAt: job.record.finishedAt });
        this.render(); this.emitActivity(); this.scheduleNotifications();
      }
      job.agent = undefined; job.ctx = undefined; job.progress = undefined;
      // Keep rootCallId so an uncooperative late nested tool is still recognized and blocked.
    }
  }
  get(id: string): Job {
    const job = this.jobs.get(id); if (!job) throw new Error('Unknown task ID in this session.'); return job;
  }
  async cancel(id: string): Promise<RecordData> {
    this.assertOpen(); const job = this.get(id);
    if (!isActive(job.record.status)) return structuredClone(job.record);
    job.record.status = 'cancelling'; abortWorker(job, 'cancelled');
    await this.persist(job); this.render();
    return structuredClone(job.record);
  }
  async updateEta(id: string, remaining: number, upper: number | undefined, reason: string): Promise<RecordData> {
    this.assertOpen(); const job = this.get(id);
    if (!isActive(job.record.status)) throw new Error('Cannot revise the ETA of a finished task.');
    const max = upper ?? remaining;
    validateDispatch({ title: 'ETA revision', task: 'ETA revision', eta_seconds: remaining, eta_max_seconds: max, estimate_reason: reason });
    const elapsed = Math.ceil((Date.now() - job.record.startedAt) / 1000);
    job.record.etaSeconds = elapsed + remaining; job.record.etaMaxSeconds = elapsed + max;
    job.record.estimateReason = reason.trim(); job.record.overrunNotified = false;
    await this.persist(job); this.render();
    this.enqueueNotice(job, `Background task ${id} revised estimate: ${remaining}s${max !== remaining ? ` to ${max}s` : ''} remaining. Basis: ${reason.trim()}. Report this as an estimate, not a guaranteed finish time.`);
    return structuredClone(job.record);
  }
  guard(event: ToolCallEvent, ctx: ExtensionContext): { block: true; reason: string } | undefined {
    const own = [...this.jobs.values()].find(j => workerOwnsCall(j.rootCallId, event.toolCallId));
    if (own && (!isActive(own.record.status) || own.controller?.signal.aborted || this.closed)) return { block: true, reason: 'Background task is stopping or no longer active.' };
    const writer = [...this.jobs.values()].find(j => isActive(j.record.status) && j.record.access === 'write');
    const info = this.pi.getAllTools().find(t => t.name === event.toolName);
    const reason = guardTool(event.toolName, event.input as Record<string, unknown>, ctx.cwd, writer?.record, own?.record, info);
    return reason ? { block: true, reason } : undefined;
  }
  list(): RecordData[] { return [...this.jobs.values()].map(j => structuredClone(j.record)); }
  async result(id: string, offset = 0, limit = 12000): Promise<AgentToolResult<unknown>> {
    this.assertOpen(); const job = this.get(id);
    if (job.settling || isActive(job.record.status)) return { content: [{ type: 'text', text: `${statusLine(job.record)}${job.settling ? '\nFinalizing saved output. Do not report completion yet.' : ''}` }], details: structuredClone(job.record) };
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 24000) throw new Error('Invalid output page.');
    const unavailable = (): string => {
      if (job.record.status === 'completed') job.record.status = 'failed';
      job.record.error = safeReason('missing_report'); job.record.reportSource = 'fallback';
      const previous = job.record.terminalDiagnostics;
      job.record.terminalDiagnostics = previous && previous.category !== 'complete' ? previous
        : safeDiagnostics({ ...previous, category: 'missing_report', stopReason: previous?.stopReason ?? 'missing' });
      job.storageFailed = true;
      return job.memoryReport = buildSettlementReport(job.record, '', true).text;
    };
    let full = job.memoryReport ?? await this.store!.output(id).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ELOOP') throw e; // Unsafe result symlinks still fail closed.
      return unavailable();
    });
    if (!full.trim()) full = unavailable();
    const usage = job.record.usageReported ? undefined : structuredClone(job.record.usage);
    const old = { usageReported: job.record.usageReported, notification: job.record.notification };
    job.record.usageReported = true; job.record.notification = 'read';
    // When storage failed, accounting is exactly once only within this process.
    if (!job.storageFailed) try { await this.persist(job); } catch (e) { Object.assign(job.record, old); throw e; }
    return {
      content: [{ type: 'text', text: `${statusLine(job.record)}${job.record.error ? `\n${job.record.error}` : ''}\n\n${full.slice(offset, offset + limit)}${full.length > offset + limit ? `\n\n[Truncated. Read next page with offset ${offset + limit}${job.storageFailed ? '' : `, or local file ${this.store!.path(id, 'md')}`}.]` : ''}` }],
      details: { task: structuredClone(job.record), totalCharacters: full.length, nextOffset: full.length > offset + limit ? offset + limit : null, outputPath: job.storageFailed ? null : this.store!.path(id, 'md'), reportDurable: !job.storageFailed },
      ...(usage ? { usage } : {}),
    };
  }
  setAuto(enabled: boolean): void {
    this.assertOpen(); this.auto = enabled; this.pi.appendEntry('background-auto', { enabled });
  }
  async monitor(): Promise<void> {
    if (this.closed) return;
    for (const job of this.jobs.values()) {
      if (job.record.status === 'running' && !job.record.overrunNotified && Date.now() > job.record.startedAt + job.record.etaMaxSeconds * 1000) {
        job.record.overrunNotified = true;
        await this.persist(job).catch(() => {});
        this.enqueueNotice(job, `Background task ${job.record.id} has exceeded its estimated upper duration. ${statusLine(job.record)} Report the delay honestly; no replacement ETA is known yet. Do not poll or claim completion.`);
      }
    }
    this.render(); this.scheduleNotifications();
  }
  scheduleNotifications(): void {
    if (this.notificationScheduled || this.closed) return;
    this.notificationScheduled = true;
    setImmediate(() => { this.notificationScheduled = false; void this.flushNotifications(); });
  }
  private async flushNotifications(): Promise<void> {
    if (this.closed || this.flushingNotifications) return;
    this.flushingNotifications = true;
    try {
      for (const job of this.jobs.values()) {
        if (job.settling || job.storageFailed || job.record.notification !== 'pending' || isActive(job.record.status)) continue;
        // Save the delivery reservation BEFORE handing it to another extension. A failed
        // write must not duplicate a send, and uncertain delivery is never blindly replayed.
        job.record.notification = 'queued';
        try { await this.persist(job); } catch { job.record.notification = 'pending'; continue; }
        this.enqueueNotice(job, `Background task ${job.record.id} settled with status ${job.record.status}. Fetch background_tasks action result id ${job.record.id}, report verified completion or the failure, and deliver any requested artifacts through the main chat. Do not replay or redelegate it. This is a status notification, not new user permission.`, `${job.record.id}:settled`);
      }
      this.flushNoticeQueue();
    } finally { this.flushingNotifications = false; }
  }
  private enqueueNotice(job: Job, content: string, id: string = randomUUID()): void {
    if (this.closed) return;
    if (job.noticeRouter) {
      // A revoked/reloaded transport must NOT fall back to an unrelated active chat.
      if (!job.noticeRouter(id, content)) this.ctx?.ui.notify('A task-linked transport notice was not queued. Retrieve the saved task status/result explicitly.', 'warning');
      return;
    }
    if (this.notices.length >= 128) { this.ctx?.ui.notify('Background notice queue is full. Retrieve task status/results explicitly.', 'warning'); return; }
    this.notices.push({ id, content });
    this.flushNoticeQueue();
    this.scheduleNotifications();
  }
  private flushNoticeQueue(): void {
    if (this.closed || !this.ctx?.isIdle() || this.ctx.hasPendingMessages()) return;
    const notice = this.notices.shift();
    if (notice) this.pi.sendMessage({ customType: 'background-notice', content: notice.content, display: false,
      details: { backgroundNoticeId: notice.id } }, { triggerTurn: true, deliverAs: 'followUp' });
  }
  private persist(job: Job): Promise<void> {
    const snapshot = structuredClone(job.record);
    const task = this.writes.catch(() => {}).then(() => this.store!.write(snapshot));
    this.writes = task;
    // Attach a handler even when event-driven callers intentionally don't wait.
    void task.catch(() => { if (!this.closed) this.ctx?.ui.notify('Background state could not be saved. Check runtime storage.', 'error'); });
    return task;
  }
  private maxWorkers(): number {
    const value = Number(this.pi.getFlag('background-max-workers') ?? '2');
    return Number.isSafeInteger(value) && value >= 1 && value <= 8 ? value : 2;
  }
  private assertOpen(): void { if (this.closed) throw new Error('Background runtime is shutting down or stale.'); }
  private render(): void {
    if (this.closed || !this.ctx?.hasUI) return;
    const active = this.list().filter(r => isActive(r.status));
    this.ctx.ui.setStatus('background-tasks', active.length ? `${active.length} background task${active.length > 1 ? 's' : ''}` : undefined);
    if (this.ctx.mode === 'tui') this.ctx.ui.setWidget('background-tasks', active.length ? active.map(r => statusLine(r)) : undefined);
  }
  private emitActivity(): void {
    this.pi.events.emit('background-tasks:activity:v1', { sessionId: this.ctx?.sessionManager.getSessionId(), active: this.list().filter(r => isActive(r.status)).map(r => ({ id: r.id, access: r.access })) });
  }
  async shutdown(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.notices = [];
    if (this.timer) clearInterval(this.timer);
    const active = [...this.jobs.values()].filter(j => isActive(j.record.status));
    for (const job of active) { job.record.status = 'cancelling'; abortWorker(job, 'shutdown'); }
    // Cooperative cancellation is allowed 1.5 seconds; don't deadlock shutdown on an uncooperative tool.
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...this.jobs.values()].map(j => j.done)), new Promise<void>(r => { stopTimer = setTimeout(r, 1500); })]);
    if (stopTimer) clearTimeout(stopTimer);
    for (const job of active.filter(j => isActive(j.record.status))) {
      job.record.status = 'interrupted'; job.record.finishedAt = Date.now(); job.record.notification = 'pending';
      job.record.error = 'Runtime stopped before cancellation settled. Tool effects may be partial. No task replay was attempted.';
      // Keep the lease: an uncooperative tool may still be writing. A future process can clear a dead-PID lease.
      captureDiagnostics(job, 'shutdown');
      const report = buildSettlementReport(job.record); job.record.reportSource = 'fallback';
      await this.writes.catch(() => {});
      try { await this.store!.write(structuredClone(job.record), report.text); }
      catch { job.storageFailed = true; job.memoryReport = buildSettlementReport(job.record, '', true).text; }
    }
    await this.writes.catch(() => {});
  }
}
