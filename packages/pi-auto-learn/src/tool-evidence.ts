interface EvidenceOwner { sessionId: string; used: Set<string>; failures: Set<string> }
export interface ActivityEvidence extends EvidenceOwner { admission: 'pending' | 'admitted' | 'rejected'; entryId?: string }
interface TaskEvidence extends EvidenceOwner { taskId: string; rootCallId: string; source: ActivityEvidence; status: string; finished: boolean }
interface Call { owner: ActivityEvidence | TaskEvidence; name: string; skill?: string; signal?: AbortSignal; ended: boolean }
interface ToolEvent { toolCallId: string; parentToolCallId?: string; toolName: string; isError?: boolean }
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[\w.:/@+-]{1,160}$/.test(v);
const taskId = (v: unknown): v is string => typeof v === 'string' && /^bg-[a-f0-9]{12}$/.test(v);
const isTask = (owner: ActivityEvidence | TaskEvidence): owner is TaskEvidence => 'taskId' in owner;
const failures = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'background_stage_file', 'background_fs_inspect', 'background_web_search', 'background_web_result']);

/** Cooperative, trusted v1 worker telemetry plus actual host start/parent pairs.
 * Tool-ID prefixes alone are never ownership. Unpaired or ambiguous nested calls
 * fail closed. Worker diagnostics are bounded, payload-free, task-tagged and NOT
 * automatic proposal evidence; only their originating admitted human can enroll
 * them for inspection. No transcript/history is copied from a worker.
 */
export class ToolEvidence {
  private current?: ActivityEvidence;
  private calls = new Map<string, Call>();
  private tasks = new Map<string, TaskEvidence>();
  private roots = new Map<string, TaskEvidence>();
  private ambiguous = new Set<string>();
  private saturated = false;
  begin(sessionId: string): void {
    if (this.current?.admission === 'pending') this.current.admission = 'rejected';
    this.current = { sessionId, used: new Set(), failures: new Set(), admission: 'pending' };
  }
  ensure(sessionId: string): void { if (!this.current || this.current.sessionId !== sessionId) this.begin(sessionId); }
  invalidate(): void { if (this.current) this.current.admission = 'rejected'; this.current = undefined; }
  clear(): void { this.invalidate(); this.calls.clear(); this.tasks.clear(); this.roots.clear(); this.ambiguous.clear(); this.saturated = false; }
  finish(): ActivityEvidence | undefined { const current = this.current; this.current = undefined; return current; }
  admit(owner: ActivityEvidence | undefined, allowed: boolean, entryId?: string): void {
    if (!owner || owner.admission !== 'pending') return;
    owner.admission = allowed ? 'admitted' : 'rejected'; owner.entryId = entryId;
  }
  start(event: ToolEvent, sessionId: string, skill?: string, signal?: AbortSignal): void {
    if (this.saturated || !identifier(event.toolCallId) || this.ambiguous.has(event.toolCallId)) return;
    if (this.calls.has(event.toolCallId)) {
      // Reused provider IDs cannot correlate a sparse late end to a newer call.
      this.calls.delete(event.toolCallId); this.ambiguous.add(event.toolCallId); return;
    }
    if (this.calls.size + this.ambiguous.size >= 8192) { this.saturated = true; return; }
    const parent = event.parentToolCallId;
    const parentCall = parent ? this.calls.get(parent) : undefined;
    // Missing/invalid/overflowed worker telemetry must not reinterpret dispatch
    // descendants as foreground evidence. Other paired orchestrators still inherit.
    const owner = parent ? this.roots.get(parent) ?? (parentCall?.name === 'background_dispatch' ? undefined : parentCall?.owner) : this.current;
    if (!owner || owner.sessionId !== sessionId || (isTask(owner) && owner.finished)) return;
    this.calls.set(event.toolCallId, { owner, name: event.toolName, skill, signal, ended: false });
  }
  end(event: ToolEvent, sessionId: string): void {
    const call = this.calls.get(event.toolCallId);
    if (!call || call.ended || call.name !== event.toolName || call.owner.sessionId !== sessionId) return;
    call.ended = true;
    const owner = call.owner;
    // Host ctx.signal belongs to the foreground operation, not an independent
    // worker's abort controller. Worker lifetime comes from its owning protocol.
    if (isTask(owner) ? owner.finished : call.signal?.aborted || owner !== this.current) return;
    if (event.isError && owner.failures.size < 32) owner.failures.add(`${failures.has(call.name) ? call.name : 'other'}: failed`);
    if (!event.isError && call.skill && owner.used.size < 128) owner.used.add(call.skill);
  }
  workerEvent(data: unknown, sessionId: string): void {
    if (!data || typeof data !== 'object') return;
    // Inspect only protocol fields, never arbitrary nested payloads.
    const e = data as Record<string, unknown>;
    if (e.version !== 1 || !taskId(e.taskId) || !identifier(e.rootCallId) || e.sessionId !== sessionId) return;
    const task = this.tasks.get(e.taskId);
    if (e.type === 'worker-start' || e.type === 'worker-queued') {
      if (task) { if (task.rootCallId === e.rootCallId && !task.finished && e.type === 'worker-start') task.status = 'running'; return; }
      const root = this.calls.get(e.rootCallId);
      if (!root || root.name !== 'background_dispatch' || isTask(root.owner) || root.owner.sessionId !== sessionId || this.roots.has(e.rootCallId) || this.tasks.size >= 128) return;
      const next: TaskEvidence = { taskId: e.taskId, rootCallId: e.rootCallId, sessionId, source: root.owner, used: new Set(), failures: new Set(), finished: false, status: e.type === 'worker-start' ? 'running' : 'queued' };
      this.tasks.set(e.taskId, next); this.roots.set(e.rootCallId, next); return;
    }
    if (e.type === 'worker-end' && task && task.rootCallId === e.rootCallId && !task.finished && typeof e.status === 'string' && ['completed', 'failed', 'cancelled', 'interrupted', 'error'].includes(e.status)) {
      task.finished = true; task.status = e.status;
    }
  }
  diagnostics(sessionId: string) {
    return [...this.tasks.values()].filter(t => t.sessionId === sessionId && t.source.admission === 'admitted').map(t => ({
      taskId: t.taskId, rootCallId: t.rootCallId, sessionId: t.sessionId, sourceEntryId: t.source.entryId,
      status: t.status, used: [...t.used], failures: [...t.failures], automaticLearning: false,
    }));
  }
}
