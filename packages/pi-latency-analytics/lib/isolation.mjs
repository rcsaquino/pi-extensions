import { Collector } from './collector.mjs';

const identifier = value => typeof value === 'string' && /^[\w.:/@+-]{1,160}$/.test(value) ? value : null;
const taskId = value => typeof value === 'string' && /^bg-[a-f0-9]{12}$/.test(value) ? value : null;
const usage = value => Object.fromEntries(['input','output','cacheRead','cacheWrite','cacheWrite1h','reasoning','totalTokens']
  .filter(k => Number.isSafeInteger(value?.[k]) && value[k] >= 0).map(k => [k,value[k]]));
const streamTypes = new Set(['text_delta','thinking_start','thinking_delta','thinking_end','toolcall_delta']);

/** One foreground collector, independent worker collectors sharing only the writer/instance.
 * The event bus is trusted extension code, not a security boundary. Closed allowlisted v1
 * events are still validated; no task/message/payload object is retained or traversed.
 */
export class IsolatedCollector extends Collector {
  constructor(sink, options = {}) { super(sink, options); this.workers = new Map(); this.roots = new Map(); this.unknownWorkerAncestry = false; this.ambiguousUi = 0; }
  owner(event) {
    const call = identifier(event.toolCallId), parent = identifier(event.parentToolCallId);
    for (const [root, worker] of this.roots) if ((parent && call?.startsWith(`${root}/`) && (parent === root || parent.startsWith(`${root}/`))) || worker.collector.tools.has(call)) return worker;
    return null;
  }
  toolStart(event) {
    const worker = this.owner(event);
    if (worker) { if (!worker.finished) worker.collector.toolStart(event); return; }
    if (this.unknownWorkerAncestry && event.parentToolCallId) { if (this.active) this.active.complete = false; return; }
    super.toolStart(event);
  }
  toolEnd(event) {
    const worker = this.owner(event);
    if (worker) { if (!worker.finished) worker.collector.toolEnd(event); return; }
    super.toolEnd(event);
  }
  workerEvent(event) {
    if (!event || event.version !== 1 || !taskId(event.taskId) || !identifier(event.sessionId)) return;
    if (event.sessionId !== this.session.session_id) return;
    if (!identifier(event.rootCallId)) { if (event.type === 'worker-start') this.unknownWorkerAncestry = true; return; }
    const task = event.taskId;
    if (event.type === 'worker-start' && this.workers.has(task)) {
      const waiting = this.workers.get(task);
      if (waiting.root !== event.rootCallId || waiting.finished || !waiting.queued) return;
      waiting.queued = false; waiting.collector.close(waiting.queueSpan, 'completed'); waiting.collector.agentStart();
      waiting.collector.event('worker_admitted', { queue_wait_ms: Number.isSafeInteger(event.queueWaitMs) && event.queueWaitMs >= 0 ? event.queueWaitMs : null }); return;
    }
    if (event.type === 'worker-start' || event.type === 'worker-queued') {
      if (this.workers.has(task) || this.roots.has(event.rootCallId)) return;
      if (this.workers.size >= 1024) { this.unknownWorkerAncestry = true; return; }
      const collector = new Collector(this.sink, { clock: this.clock, instanceId: this.instanceId });
      collector.configure({ session_id: this.session.session_id, source: 'background-worker',
        provider: identifier(event.provider), model: identifier(event.model), thinking_level: identifier(event.thinking) });
      collector.start('worker');
      const queued = event.type === 'worker-queued';
      const queueSpan = queued ? collector.open('queue', 'waiting_admission') : null;
      if (!queued) collector.agentStart();
      collector.event('worker_link', { task_id: task, root_tool_call_id: event.rootCallId,
        parent_trace_id: this.active?.trace_id ?? null, parent_tool_span_id: this.tools.get(event.rootCallId) ?? null });
      const worker = { collector, queued, queueSpan, root: event.rootCallId, finished: false, request: null, seenRequests: new Set(), seenUsage: new Set() };
      this.workers.set(task, worker); this.roots.set(event.rootCallId, worker); return;
    }
    const worker = this.workers.get(task);
    if (!worker || worker.root !== event.rootCallId || worker.finished) return;
    const c = worker.collector;
    if (event.type === 'worker-end') {
      if (!['completed','failed','cancelled','interrupted','error'].includes(event.status)) return;
      worker.finished = true;
      c.finish(({ failed: 'error', cancelled: 'aborted' })[event.status] || event.status); return;
    }
    if (event.type === 'tool-usage') {
      const call = identifier(event.callId);
      if (!call || worker.seenUsage.has(call)) return;
      if (worker.seenUsage.size >= 10000) {
        c.active.complete = false;
        if (!worker.usageLimited) { worker.usageLimited = true; c.event('nested_usage_coverage_limit'); }
        return;
      }
      worker.seenUsage.add(call);
      c.event('nested_tool_usage', { tool_call_id: call, usage: usage(event.usage), attribution: 'aggregate_nested_tool_result' }); return;
    }
    const request = identifier(event.requestId);
    if (!request) return;
    if (event.type === 'model-admitted') { c.event('worker_model_admission', { request_id: request, wait_ms: Number.isSafeInteger(event.waitMs) && event.waitMs >= 0 ? event.waitMs : null }); return; }
    if (event.type === 'model-start') {
      if (worker.seenRequests.has(request)) return;
      if (worker.seenRequests.size >= 1000) { c.active.complete = false; return; }
      worker.seenRequests.add(request);
      if (worker.request) { c.active.complete = false; c.messageEnd({ role: 'assistant', stopReason: 'error' }); }
      worker.request = request; c.context();
      c.event('worker_model_request', { request_id: request, purpose: event.purpose === 'compaction' ? 'compaction' : 'agent' });
      return;
    }
    if (request !== worker.request) return;
    if (event.type === 'model-request') c.providerRequest(true);
    if (event.type === 'model-headers') c.providerHeaders(true);
    if (event.type === 'model-response') c.providerResponse(Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 ? event.status : null, true);
    if (event.type === 'model-stream' && streamTypes.has(event.eventType)) c.stream({ type: event.eventType,
      contentIndex: Number.isInteger(event.contentIndex) && event.contentIndex >= 0 && event.contentIndex < 10000 ? event.contentIndex : undefined });
    if (event.type === 'model-end') {
      const stop = ['stop','toolUse','length','error','aborted','deferred'].includes(event.stopReason) ? event.stopReason : 'error';
      c.messageEnd({ role: 'assistant', stopReason: stop, provider: identifier(event.provider), model: identifier(event.model), usage: usage(event.usage) });
      worker.request = null;
    }
  }
  uiStart(kind) {
    if ([...this.workers.values()].some(w => !w.finished)) {
      this.ambiguousUi++; this.event('unattributed_ui_wait', { attribution: 'unknown_no_call_ancestry' }); return;
    }
    super.uiStart(kind);
  }
  uiEnd() { if (this.ambiguousUi) { this.ambiguousUi--; return; } super.uiEnd(); }
  shutdown() {
    super.finish('interrupted');
    for (const worker of this.workers.values()) if (!worker.finished) { worker.finished = true; worker.collector.finish('interrupted'); }
    // Keep bounded ancestry tombstones until the instance is replaced. Late host events
    // cannot reopen a foreground trace or duplicate finalized usage.
  }
}
