import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { canonicalPath, captureProfile, revalidateProfile, estimate, guardTool, policyEffects, routesToBackground, statusLine, validateDispatch, workerOwnsCall } from './policy.ts';
import type { EffectRegistry } from './effects.ts';
import { telemetry } from './telemetry.ts';
import { Store } from './store.ts';
import type { Dispatch, Job, RecordData } from './types.ts';
import { emptyUsage, isActive } from './types.ts';
import { assistantText, createWorker, finalAssistant } from './worker.ts';
import { buildSettlementReport, safeDiagnostics, safeReason, terminalCategory } from './report.ts';
import type { TerminalView } from './report.ts';
import type { TerminalCategory } from './types.ts';
import { buildSessionContext } from '@earendil-works/pi-coding-agent';
import { contextMessages } from './policy.ts';
import { Stage } from './staging.ts';
import { ResourceLocks, resourcesConflict } from './resources.ts';
import type { Resource, ResourceLease } from './resources.ts';
import { Admission } from './admission.ts';

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
  readonly effects: EffectRegistry;
  locks?: ResourceLocks;
  admission?: Admission;
  private scheduling = false;
  private brokerSource?: string;
  private toolResources = new Map<string, ResourceLease>();
  private subprocesses = new Map<string, () => void>();
  private workerCalls = new Map<string, string>();
  private owner(event: ToolCallEvent): Job | undefined {
    // A provider-issued foreground ID with a worker-like prefix is not nested ancestry.
    if (!event.parentToolCallId) return;
    return [...this.jobs.values()].find(j => workerOwnsCall(j.rootCallId, event.toolCallId) && (event.parentToolCallId === j.rootCallId || workerOwnsCall(j.rootCallId, event.parentToolCallId!)));
  }
  constructor(pi: ExtensionAPI, effects = policyEffects) { this.pi = pi; this.effects = effects; }

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
    this.locks = new ResourceLocks(join(root, 'locks'));
    this.admission = new Admission(this.maxWorkers());
    this.brokerSource = this.pi.getAllTools?.().find(t => t.name === 'background_stage_file')?.sourceInfo?.path;
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
    if ([...this.jobs.values()].filter(j => j.record.status === 'queued').length >= this.maxQueue()) throw new Error('Background queue is full. No task was accepted or started.');
    const cwd = canonicalPath(ctx.cwd);
    // Reserve synchronously before the first async lease operation, including simultaneous sibling dispatch tools.
    const id = `bg-${randomBytes(6).toString('hex')}`;
    const record: RecordData = {
      version: 1, id, title: p.title, sessionId: ctx.sessionManager.getSessionId(), cwd,
      provider: profile.model.provider, model: profile.model.id, thinking: profile.thinking,
      status: 'queued', access: p.access, contextMode: p.context_mode, startedAt: Date.now(), queuedAt: Date.now(), waitingReason: 'admission', execution: p.execution ?? 'direct', etaSeconds: p.eta_seconds,
      etaMaxSeconds: p.eta_max_seconds, estimateReason: p.estimate_reason, lastActivityAt: Date.now(),
      toolCalls: 0, turns: 0, usage: emptyUsage(), usageReported: false, notification: 'read', overrunNotified: false,
    };
    const job: Job = { record, ctx, rootCallId, controller: new AbortController(), pending: { dispatch: p, profile },
      contextSnapshot: contextMessages(p, () => buildSessionContext(ctx.sessionManager.getBranch()).messages) };
    job.done = new Promise<void>(done => { job.finish = done; });
    this.jobs.set(id, job);
    try {
      this.assertOpen(); signal?.throwIfAborted();
      await this.store!.write(record);
      this.pi.events.emit('background-tasks:claim-owner:v1', {
        sessionId: record.sessionId, taskId: id, rootCallId,
        accept: (route: Job['noticeRouter']) => { job.noticeRouter = route; },
      });
      this.pi.appendEntry('background-task', { id, title: record.title, status: record.status, etaSeconds: record.etaSeconds, etaMaxSeconds: record.etaMaxSeconds });
      telemetry(this.pi, job, 'worker-queued', { provider: record.provider, model: record.model, thinking: record.thinking });
    } catch (e) {
      telemetry(this.pi, job, 'worker-end', { status: 'error' });
      this.jobs.delete(id); await job.release?.(); throw e;
    }
    this.render(); this.emitActivity(); this.scheduleQueue();
    return {
      content: [{ type: 'text', text: `Background task ${id} accepted into the bounded queue: ${record.title}. Queue wait is separate from execution ETA; no worker effects have started. Estimated execution duration: ${estimate(record)} (not a guarantee). Basis: ${record.estimateReason}\nProvider/model: ${record.provider}/${record.model}; thinking: ${record.thinking}. Context: ${record.contextMode} (${record.contextMode === 'full' ? 'explicit projected-history opt-in' : record.contextMode === 'selected' ? 'supplied reference only; no history copied' : 'task brief only; no history copied'}). Return control now; do not wait or poll. Completion will be reported in the main chat.` }],
      details: { route: 'background', task: structuredClone(record) },
    };
  }
  private maxQueue(): number {
    const value = Number(this.pi.getFlag('background-max-queued') ?? '32');
    return Number.isSafeInteger(value) && value >= 1 && value <= 128 ? value : 32;
  }
  private waiting(job: Job, reason: NonNullable<RecordData['waitingReason']>): void {
    if (job.record.waitingReason !== reason) { job.record.waitingReason = reason; void this.persist(job).catch(() => {}); }
  }
  private async admitted(job: Job): Promise<void> {
    this.assertOpen(); job.controller!.signal.throwIfAborted();
    job.record.queueWaitMs = Date.now() - (job.record.queuedAt ?? job.record.startedAt);
    job.record.startedAt = Date.now(); job.record.status = 'starting'; job.record.waitingReason = undefined;
    await this.persist(job);
    telemetry(this.pi, job, 'worker-start', { provider: job.record.provider, model: job.record.model, thinking: job.record.thinking, queueWaitMs: job.record.queueWaitMs });
  }
  scheduleQueue(): void { if (!this.closed) setImmediate(() => { void this.pumpQueue().catch(() => { this.ctx?.ui.notify('Background admission state needs review. No uncertain work was replayed.', 'error'); }); }); }
  private queueRequests(job: Job): Resource[] {
    const p = job.pending!.dispatch;
    if (p.execution !== 'staged') return [{ path: job.record.cwd, mode: p.access }];
    return [{ path: join(this.store!.recordsDir, `${job.record.id}.stage`), mode: 'write' },
      ...[...p.stage!.inputs, ...p.stage!.outputs].map(path => ({ path: join(job.record.cwd, path), mode: 'read' as const })),
      ...(p.stage!.immutable_refs ?? []).map(path => ({ path, mode: 'read' as const }))];
  }
  private async pumpQueue(): Promise<void> {
    if (this.scheduling || this.closed) return; this.scheduling = true;
    try {
      // Oldest supported eligible work first. Conflicting jobs remain observable; disjoint
      // staged jobs may pass them. No task is replayed after process/reload recovery.
      for (const job of [...this.jobs.values()].sort((a, b) => (a.record.queuedAt ?? a.record.startedAt) - (b.record.queuedAt ?? b.record.startedAt))) {
        if (this.closed || job.record.status !== 'queued' || !job.pending) continue;
        const running = [...this.jobs.values()].filter(j => j.record.status === 'starting' || j.record.status === 'running' || j.record.status === 'cancelling' || j.starting || j.release);
        if (running.length >= this.maxWorkers()) { this.waiting(job, 'capacity'); continue; }
        const p = job.pending.dispatch;
        if (p.access === 'write' && this.store!.hasWriterEvidence(job.record.cwd) && !running.some(j => j.record.access === 'write' && j.record.execution !== 'staged')) { this.waiting(job, 'resources'); continue; }
        const aged = [...this.jobs.values()].filter(old => old !== job && old.pending && old.record.status === 'queued' &&
          (old.record.queuedAt ?? old.record.startedAt) < (job.record.queuedAt ?? job.record.startedAt) && Date.now() - (old.record.queuedAt ?? old.record.startedAt) >= 30000);
        if (aged.some(old => resourcesConflict(this.queueRequests(old), this.queueRequests(job)))) { this.waiting(job, 'resources'); continue; }
        if (p.execution !== 'staged' && p.access === 'write' && running.some(j => j.record.access === 'write' && j.record.execution !== 'staged')) { this.waiting(job, 'resources'); continue; }
        job.starting = true;
        const admission = this.startQueued(job).catch(async () => {
          // Never expose credential/provider errors or the task brief in admission diagnostics.
          job.record.status = job.controller?.signal.aborted ? 'cancelled' : 'failed';
          job.record.error = safeReason('admission_error');
          captureDiagnostics(job, job.controller?.signal.aborted ? 'cancelled' : 'admission_error');
          job.record.finishedAt = Date.now(); job.record.notification = 'pending'; job.record.reportSource = 'fallback';
          try { await job.release?.(); job.release = undefined; } catch { /* uncertain ownership stays guarded */ }
          await this.store!.write(job.record, buildSettlementReport(job.record).text).catch(() => { job.storageFailed = true; job.memoryReport = buildSettlementReport(job.record, '', true).text; });
          job.pending = undefined; job.ctx = undefined; telemetry(this.pi, job, 'worker-end', { status: job.record.status }); job.finish?.();
          this.scheduleNotifications();
        }).finally(() => { job.starting = false; this.render(); this.emitActivity(); if (job.record.status !== 'queued') this.scheduleQueue(); });
        await admission;
      }
    } finally { this.scheduling = false; this.render(); }
  }
  private async startQueued(job: Job): Promise<void> {
    const { dispatch: p, profile } = job.pending!;
    job.controller!.signal.throwIfAborted(); this.assertOpen();
    // Re-enter the host validation/permission pipeline after queue wait. The check's
    // schema carries the explicit staged contract, so permission policies can deny it.
    const allowed = await job.ctx!.executeTool('background_start_check', { id: job.record.id, execution: p.execution ?? 'direct', access: p.access, provider: profile.model.provider, model: profile.model.id, thinking: profile.thinking, ...(p.stage ? { stage: structuredClone(p.stage) } : {}) }, { signal: job.controller!.signal });
    if (allowed.isError) throw new Error('Background start was not approved.');
    job.controller!.signal.throwIfAborted(); this.assertOpen(); revalidateProfile(profile, job.ctx!);
    if (p.execution === 'staged') {
      const stage = new Stage(job.record.id, job.record.cwd, join(this.store!.recordsDir, `${job.record.id}.stage`), p.stage!);
      const resources = await this.locks!.acquire([{ path: stage.root, mode: 'write' }, ...stage.snapshotResources()], false, false, true);
      if (!resources) { this.waiting(job, 'resources'); job.starting = false; return; }
      job.release = resources; job.resourceLease = resources;
      try { await this.admitted(job); await stage.snapshot(job.controller!.signal); await stage.saveProfile({ provider: profile.model.provider, model: profile.model.id, thinking: profile.thinking }); job.controller!.signal.throwIfAborted(); job.stage = stage; }
      catch (e) { await stage.close(); throw e; }
      finally { await resources.narrow([{ path: stage.root, mode: 'write' }]); }
    } else if (p.access === 'write') {
      const resourcesRelease = await this.locks!.acquire([{ path: job.record.cwd, mode: 'write' }], true, false, false);
      if (!resourcesRelease) { this.waiting(job, 'resources'); job.starting = false; return; }
      let legacyRelease: (() => Promise<void>) | undefined;
      try { legacyRelease = await this.store!.acquireWriter(job.record.cwd, true); }
      catch (e) { await resourcesRelease(); if (e instanceof Error && /live background writer/.test(e.message)) { this.waiting(job, 'resources'); job.starting = false; return; } throw e; }
      job.resourceLease = resourcesRelease;
      job.release = async () => { await legacyRelease!(); await resourcesRelease(); };
    }
    job.controller!.signal.throwIfAborted(); this.assertOpen();
    if (job.record.status === 'queued') await this.admitted(job);
    job.record.status = 'running';
    await this.persist(job);
    job.agent = createWorker(this.pi, job, profile, p, { effects: this.effects, admission: this.admission,
      changed: () => { this.persist(job); this.render(); }, checkAlive: () => { this.assertOpen(); job.controller!.signal.throwIfAborted(); } });
    job.pending = undefined;
    // Only admission/snapshot is awaited by the scheduler, not task execution.
    setImmediate(() => { void this.run(job, p.task).catch(() => { if (!this.closed) this.ctx?.ui.notify('Background worker settlement failed. Review its saved state before retrying.', 'error'); }).finally(() => { job.finish?.(); this.scheduleQueue(); }); });
  }
  webScope(callId: string, ctx: ExtensionContext): string {
    return `${ctx.sessionManager.getSessionId()}:${this.workerCalls.get(callId) ?? 'foreground'}`;
  }
  validateStart(id: string, args: Record<string, unknown>): void {
    const job = this.get(id); this.assertOpen(); job.controller!.signal.throwIfAborted();
    if (!job.starting || job.record.status !== 'queued' || !job.pending) throw new Error('Task is not awaiting start revalidation.');
    const p = job.pending.dispatch;
    if (args.execution !== (p.execution ?? 'direct') || args.access !== p.access || args.provider !== job.record.provider || args.model !== job.record.model || args.thinking !== job.record.thinking || JSON.stringify(args.stage) !== JSON.stringify(p.stage)) throw new Error('Captured start contract changed during permission validation.');
  }
  async stageFile(callId: string, args: { id: string; operation: 'read' | 'write' | 'edit'; path: string; content?: string; edits?: { oldText: string; newText: string }[]; oldText?: string; newText?: string; offset?: number; limit?: number }, signal?: AbortSignal): Promise<string> {
    const job = this.get(args.id);
    if (!job.stage || this.workerCalls.get(callId) !== job.record.id || !workerOwnsCall(job.rootCallId, callId) || job.record.status !== 'running') throw new Error('Only the owning active staged worker can use its file broker.');
    const text = await job.stage.file(args.operation, args.path, args.content, args.edits ?? (args.oldText !== undefined && args.newText !== undefined ? [{ oldText: args.oldText, newText: args.newText }] : undefined), signal);
    if (args.operation !== 'read') return text;
    const page = text.split('\n').slice((args.offset ?? 1) - 1, (args.offset ?? 1) - 1 + (args.limit ?? 2000)).join('\n');
    return page.length > 24000 ? page.slice(0, 24000) + '\n[Staged read truncated. Use offset/limit.]' : page;
  }
  async publish(id: string, expectedHash: string, signal?: AbortSignal): Promise<RecordData> {
    this.assertOpen(); const job = this.get(id);
    if (job.record.status !== 'completed' || job.settling || !job.stage) throw new Error('Only settled completed staged output can be reviewed and published. Restored jobs require explicit recovery review.');
    try { await job.stage.publish(this.locks!, expectedHash, signal); job.record.publication = 'published'; await job.stage.close(); }
    catch (e) { if (e instanceof Error && /recovery requires review/.test(e.message)) job.record.publication = 'review-required'; await this.persist(job); throw e; }
    await this.persist(job); return structuredClone(job.record);
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
      if (job.stage && job.record.status === 'completed') try { job.record.manifest = await job.stage.seal(); job.record.publication = 'ready'; }
      catch { job.record.status = 'failed'; category = 'stage_validation_error'; job.record.error = safeReason(category); }
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
      telemetry(this.pi, job, 'worker-end', { status: job.record.status });
      if (!this.closed) {
        this.pi.appendEntry('background-task', { id: job.record.id, status: job.record.status, finishedAt: job.record.finishedAt });
        this.render(); this.emitActivity(); this.scheduleNotifications();
      }
      job.agent = undefined; job.ctx = undefined; job.progress = undefined; job.contextSnapshot = undefined;
      this.scheduleQueue();
      // Keep rootCallId so an uncooperative late nested tool is still recognized and blocked.
    }
  }
  get(id: string): Job {
    const job = this.jobs.get(id); if (!job) throw new Error('Unknown task ID in this session.'); return job;
  }
  async cancel(id: string): Promise<RecordData> {
    this.assertOpen(); const job = this.get(id);
    if (!isActive(job.record.status)) return structuredClone(job.record);
    if (job.record.status === 'queued' && !job.starting) {
      job.controller?.abort(); job.record.status = 'cancelled'; job.record.finishedAt = Date.now(); job.record.notification = 'pending';
      job.record.error = safeReason('queue_cancelled'); job.pending = undefined; job.ctx = undefined; job.contextSnapshot = undefined; job.record.reportSource = 'fallback';
      captureDiagnostics(job, 'queue_cancelled');
      try { await this.store!.write(job.record, buildSettlementReport(job.record).text); }
      catch { job.storageFailed = true; job.memoryReport = buildSettlementReport(job.record, '', true).text; }
      telemetry(this.pi, job, 'worker-end', { status: 'cancelled' }); job.finish?.(); this.scheduleNotifications(); this.scheduleQueue(); this.render(); return structuredClone(job.record);
    }
    job.record.status = 'cancelling'; abortWorker(job, 'cancelled');
    await this.persist(job); this.render();
    return structuredClone(job.record);
  }
  async updateEta(id: string, remaining: number, upper: number | undefined, reason: string): Promise<RecordData> {
    this.assertOpen(); const job = this.get(id);
    if (!isActive(job.record.status)) throw new Error('Cannot revise the ETA of a finished task.');
    const max = upper ?? remaining;
    validateDispatch({ title: 'ETA revision', task: 'ETA revision', eta_seconds: remaining, eta_max_seconds: max, estimate_reason: reason });
    const elapsed = job.record.status === 'queued' ? 0 : Math.ceil((Date.now() - job.record.startedAt) / 1000);
    job.record.etaSeconds = elapsed + remaining; job.record.etaMaxSeconds = elapsed + max;
    job.record.estimateReason = reason.trim(); job.record.overrunNotified = false;
    await this.persist(job); this.render();
    this.enqueueNotice(job, `Background task ${id} revised estimate: ${remaining}s${max !== remaining ? ` to ${max}s` : ''} remaining. Basis: ${reason.trim()}. Report this as an estimate, not a guaranteed finish time.`);
    return structuredClone(job.record);
  }
  guard(event: ToolCallEvent, ctx: ExtensionContext): { block: true; reason: string } | undefined {
    const own = this.owner(event);
    if (own && (!isActive(own.record.status) || own.controller?.signal.aborted || this.closed)) return { block: true, reason: 'Background task is stopping or no longer active.' };
    if (own) this.workerCalls.set(event.toolCallId, own.record.id);
    // An uncertain/stuck tool can outlive status interruption. Retain the guard as
    // long as this process still holds its lease, including after bounded shutdown.
    const writer = [...this.jobs.values()].find(j => j.record.access === 'write' && j.record.execution !== 'staged' && (j.record.status === 'running' || j.record.status === 'cancelling' || !!j.release));
    const legacyEvidence = !writer && this.store?.hasWriterEvidence(canonicalPath(ctx.cwd)) ? { id: 'legacy-writer-evidence', cwd: canonicalPath(ctx.cwd) } as RecordData : undefined;
    const info = this.pi.getAllTools().find(t => t.name === event.toolName);
    const args = event.input as Record<string, unknown>;
    if (['background_start_check', 'background_stage_file'].includes(event.toolName)) {
      if (!own || args.id !== own.record.id || !this.brokerSource || info?.sourceInfo?.path !== this.brokerSource) return { block: true, reason: 'Background broker ownership/source mismatch.' };
      if (event.toolName === 'background_start_check') return own.starting && own.record.status === 'queued' ? undefined : { block: true, reason: 'Start validation is admission-only.' };
      return own.stage && own.record.status === 'running' ? undefined : { block: true, reason: 'Stage broker is owner-only.' };
    }
    if (own?.stage && event.toolName !== 'background_update_eta') {
      const effect = this.effects.classify(event.toolName, args, ctx.cwd, info);
      if (!['background_web_search', 'background_web_result'].includes(event.toolName) || effect.kind !== 'network-read' || effect.privateCache) return { block: true, reason: 'Staged workers use only their validated file broker and reviewed memory-only web tools. Unknown/live-parent effects are blocked.' };
    }
    if ((!own || !own.stage) && !['background_dispatch', 'background_tasks', 'background_update_eta', 'background_publish'].includes(event.toolName)) {
      const effect = this.effects.classify(event.toolName, args, ctx.cwd, info);
      const parents = [...this.toolResources].filter(([id]) => event.toolCallId.startsWith(`${id}/`)).map(([, lease]) => lease);
      if (own?.resourceLease) parents.push(own.resourceLease);
      if (['unknown', 'external-mutation'].includes(effect.kind) && ([...this.jobs.values()].some(j => j.stage && (j.record.status === 'running' || !!j.release)) || this.locks?.conflicts([{ path: '/', mode: 'write' }], true, parents))) return { block: true, reason: 'Unclassified effects could escape into private staged resources. Use reviewed/disjoint tools or wait for staged work to settle.' };
      const resources = [...(effect.reads ?? []).map(path => ({ path, mode: 'read' as const })), ...(effect.writes ?? []).map(path => ({ path, mode: 'write' as const }))];
      if (resources.length && this.locks?.conflicts(resources, !!own?.release || effect.kind === 'filesystem-read', parents)) return { block: true, reason: 'Resource is being snapshotted or published. This call was not queued or executed; unrelated tools remain available.' };
    }
    const reason = guardTool(event.toolName, args, ctx.cwd, writer?.record ?? legacyEvidence, own?.record, info, this.effects);
    return reason ? { block: true, reason } : undefined;
  }
  async guardAndAcquire(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
    const denied = this.guard(event, ctx); if (denied) return denied;
    const own = this.owner(event);
    const source = this.pi.getAllTools().find(t => t.name === event.toolName)?.sourceInfo?.path;
    if (own && ['builtin:bash', 'builtin:powershell'].includes(source ?? '')) {
      // Actual host pipeline admission covers nested shell calls too. Release only
      // on tool_execution_end, never when a waiting caller is cancelled.
      const release = await this.admission!.acquire('subprocess', own.controller?.signal);
      this.subprocesses.set(event.toolCallId, release);
    }
    if (own?.stage || ['background_dispatch', 'background_tasks', 'background_update_eta', 'background_start_check', 'background_publish'].includes(event.toolName)) return;
    const info = this.pi.getAllTools().find(t => t.name === event.toolName);
    const effect = this.effects.classify(event.toolName, event.input, ctx.cwd, info);
    const uncertain = ['unknown', 'external-mutation'].includes(effect.kind);
    const resources = uncertain ? [{ path: '/', mode: 'write' as const }] : [...(effect.reads ?? []).map(path => ({ path, mode: 'read' as const })), ...(effect.writes ?? []).map(path => ({ path, mode: 'write' as const }))];
    if (!resources.length || !this.locks) return;
    const parents = [...this.toolResources].filter(([id]) => event.toolCallId.startsWith(`${id}/`)).map(([, lease]) => lease);
    if (own?.resourceLease) parents.push(own.resourceLease);
    if (parents.some(lease => lease.covers(resources))) return;
    // Only brief bounded lock-table contention is retried, not live resource ownership.
    // Compatibility readers can observe a legacy direct writer's partial state;
    // publication readers hold a real shared lease until host tool completion.
    let release: ResourceLease | undefined;
    for (let i = 0; i < 3 && !release; i++) {
      release = await this.locks.acquire(resources, uncertain, effect.kind === 'filesystem-read', uncertain && !own, parents);
      if (!release && this.locks.conflicts(resources, effect.kind === 'filesystem-read')) break;
      if (!release) await new Promise(r => setTimeout(r, 5));
    }
    if (!release) return { block: true, reason: 'Resource admission is busy. No tool effects started; unrelated safe tools remain available.' };
    if (this.toolResources.has(event.toolCallId)) { await release(); return { block: true, reason: 'Duplicate live tool resource identity.' }; }
    this.toolResources.set(event.toolCallId, release);
  }
  async toolEnded(callId: string): Promise<void> {
    this.workerCalls.delete(callId);
    const release = this.toolResources.get(callId);
    if (release) try { await release(); this.toolResources.delete(callId); this.scheduleQueue(); }
    catch { this.ctx?.ui.notify('Tool resource cleanup is uncertain; ownership retained for review.', 'error'); }
    // Admit the next subprocess only after this tool's resource cleanup settles.
    const process = this.subprocesses.get(callId); if (process) { process(); this.subprocesses.delete(callId); }
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
    this.scheduleQueue();
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
    this.notices = []; this.admission?.close();
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
      // Keep uncertain ownership: a dead parent PID does not prove child writers stopped.
      captureDiagnostics(job, 'shutdown');
      telemetry(this.pi, job, 'worker-end', { status: 'interrupted' });
      if (job.pending && !job.starting) { job.pending = undefined; job.ctx = undefined; job.contextSnapshot = undefined; job.finish?.(); }
      const report = buildSettlementReport(job.record); job.record.reportSource = 'fallback';
      await this.writes.catch(() => {});
      try { await this.store!.write(structuredClone(job.record), report.text); }
      catch { job.storageFailed = true; job.memoryReport = buildSettlementReport(job.record, '', true).text; }
    }
    await this.writes.catch(() => {});
    for (const job of this.jobs.values()) if (job.stage && !job.release && !isActive(job.record.status)) await job.stage.close().catch(() => {});
  }
}
