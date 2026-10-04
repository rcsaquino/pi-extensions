import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const id = value => typeof value === 'string' && /^[\w.:/@+-]{1,160}$/.test(value) ? value : null;
const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
const defaultClock = () => ({ wall: Date.now(), mono: performance.now() });

/** Passive observer. Never retains input, output, headers, payloads, or reasoning text. */
export class Collector {
  constructor(sink, { clock = defaultClock, instanceId = randomUUID() } = {}) {
    this.sink = sink;
    this.clock = clock;
    this.instanceId = instanceId;
    this.session = {};
    this.active = null;
    this.pending = null;
    this.spans = new Map();
    this.tools = new Map();
    this.reasoning = new Map();
    this.model = null;
    this.ui = [];
    this.compaction = null;
  }

  configure(session) { this.session = session; }
  emit(record) { this.sink(record); }
  input(source) {
    const at = this.clock();
    if (this.active) {
      this.active.input_count++;
      this.active.ambiguous_inputs = true;
      this.event('input_during_activity', { source: id(source) }, at);
    } else if (this.pending) {
      this.pending.count++;
    } else {
      this.pending = { at, source: id(source) || 'unknown', count: 1 };
    }
  }

  start(origin = 'agent') {
    if (this.active) return;
    const now = this.clock();
    const first = this.pending?.at || now;
    this.active = {
      trace_id: randomUUID(), instance_id: this.instanceId,
      session_id: id(this.session.session_id), anchor_entry_id: id(this.session.anchor_entry_id),
      source: this.pending?.source || this.session.source || origin, started_wall: first.wall, started_mono: first.mono,
      agent_started_wall: null, ended_wall: null, duration_ms: null, status: 'running',
      input_count: this.pending?.count || 0, ambiguous_inputs: (this.pending?.count || 0) > 1,
      complete: true, assistant_entry_id: null,
      provider: id(this.session.provider), model: id(this.session.model),
      thinking_level: id(this.session.thinking_level), coverage: 'pi-only',
    };
    this.pending = null;
    this.emit({ op: 'trace', value: { ...this.active } });
    this.event('activity_start', { origin }, now);
  }

  event(name, meta = {}, at = this.clock()) {
    if (!this.active) return;
    this.emit({ op: 'event', value: {
      event_id: randomUUID(), trace_id: this.active.trace_id,
      name, wall_ms: at.wall, offset_ms: Math.max(0, at.mono - this.active.started_mono), meta,
    } });
  }

  open(kind, name, parent = null, meta = {}, at = this.clock()) {
    if (!this.active) return null;
    const span = {
      span_id: randomUUID(), trace_id: this.active.trace_id, parent_span_id: parent,
      kind, name, started_wall: at.wall, ended_wall: null,
      start_ms: Math.max(0, at.mono - this.active.started_mono), end_ms: null,
      duration_ms: null, status: 'running', meta,
    };
    this.spans.set(span.span_id, span);
    this.emit({ op: 'span', value: { ...span, meta: { ...meta } } });
    return span.span_id;
  }

  close(spanId, status = 'completed', meta = {}, at = this.clock()) {
    const span = this.spans.get(spanId);
    if (!span || !this.active) return;
    span.end_ms = Math.max(span.start_ms, at.mono - this.active.started_mono);
    span.ended_wall = at.wall;
    span.duration_ms = span.end_ms - span.start_ms;
    span.status = status;
    span.meta = { ...span.meta, ...meta };
    this.spans.delete(spanId);
    this.emit({ op: 'span', value: span });
  }

  beforeAgent() { this.start(); this.event('before_agent_start'); }
  agentStart() {
    this.start();
    if (this.active.agent_started_wall === null) {
      const at = this.clock();
      this.active.agent_started_wall = at.wall;
      const prep = this.open('pre_agent', 'input_to_agent_start', null, {}, {
        wall: this.active.started_wall, mono: this.active.started_mono,
      });
      this.close(prep, 'completed', {}, at);
    }
    this.event('agent_start');
  }
  agentEnd() { this.event('agent_end'); } // Not settlement: retries/continuations can follow.

  beginModel(name) {
    this.start();
    const at = this.clock();
    this.model = {
      span: this.open('model', name, null, {
        provider: id(this.session.provider), model: id(this.session.model),
        thinking_level: id(this.session.thinking_level),
      }, at),
      contextAt: at.mono, firstOutputContextMs: null, firstTextContextMs: null,
      chunks: 0, first: false, firstText: false, firstReasoning: false,
      headers: null, requestAt: null, headerAttempts: 0, httpStatuses: [], firstOutputMs: null, firstTextMs: null,
    };
    this.reasoning.clear();
  }
  context() {
    // Agent-core emits context before invoking streamFn. message_start may arrive only
    // after response headers, so it is too late to start a complete model-call span.
    if (this.model) {
      this.active.complete = false;
      this.close(this.model.span, 'incomplete');
    }
    this.beginModel('context_to_response_end');
  }
  messageStart(message) {
    if (message.role !== 'assistant') return;
    if (!this.model) this.beginModel('assistant_response_fallback');
    this.event('assistant_stream_started');
  }

  providerRequest(correlated = false) {
    if (!correlated || !this.model) { this.event('unattributed_provider_request', { attribution: 'unknown_no_request_id' }); return; }
    if (this.model.requestAt === null) this.model.requestAt = this.clock().mono;
    this.event('provider_request_prepared');
  }
  providerHeaders(correlated = false) {
    if (!correlated || !this.model) { this.event('unattributed_provider_headers', { attribution: 'unknown_no_request_id' }); return; }
    if (this.model.headers) {
      this.active.complete = false;
      this.close(this.model.headers, 'incomplete');
      this.event('ambiguous_provider_attempt');
    }
    this.model.headerAttempts++;
    this.model.headers = this.open('provider_headers', 'http_headers_wait', this.model.span, {
      attempt: this.model.headerAttempts, attribution: 'explicit_worker_request_id',
    });
  }
  providerResponse(status, correlated = false) {
    if (!correlated || !this.model?.headers) { this.event('unattributed_provider_response', { status: numeric(status), attribution: 'unknown_no_request_id' }); return; }
    if (this.model.httpStatuses.length < 10) this.model.httpStatuses.push(numeric(status));
    this.close(this.model.headers, status >= 400 ? 'error' : 'completed', { http_status: numeric(status) });
    this.model.headers = null;
  }

  stream(event) {
    const m = this.model;
    if (!m) return;
    // Inspect only event type/index. Never touch delta, partial content, or signatures.
    const type = event.type;
    if (type === 'text_delta' || type === 'thinking_delta' || type === 'toolcall_delta') {
      m.chunks++;
      if (!m.first) {
        m.first = true;
        const at = this.clock();
        m.firstOutputMs = m.requestAt === null ? null : Math.max(0, at.mono - m.requestAt);
        m.firstOutputContextMs = Math.max(0, at.mono - m.contextAt);
        this.event('first_normalized_output', { output_kind: type }, at);
      }
    }
    if (type === 'text_delta' && !m.firstText) {
      m.firstText = true;
      const at = this.clock();
      m.firstTextMs = m.requestAt === null ? null : Math.max(0, at.mono - m.requestAt);
      m.firstTextContextMs = Math.max(0, at.mono - m.contextAt);
      this.event('first_text_output', {}, at);
    }
    const index = numeric(event.contentIndex);
    if (type === 'thinking_start' && index !== null && !this.reasoning.has(index)) {
      this.reasoning.set(index, this.open('reasoning_stream', 'observed_reasoning_stream', m.span));
    }
    if (type === 'thinking_delta' && !m.firstReasoning) {
      m.firstReasoning = true;
      this.event('first_reasoning_output');
    }
    if (type === 'thinking_end' && this.reasoning.has(index)) {
      this.close(this.reasoning.get(index));
      this.reasoning.delete(index);
    }
  }

  messageEnd(message) {
    if (message.role !== 'assistant' || !this.model) return;
    const m = this.model;
    const status = message.stopReason === 'error' ? 'error' : message.stopReason === 'aborted' ? 'aborted' : 'completed';
    if (this.reasoning.size || m.headers) this.active.complete = false;
    for (const span of this.reasoning.values()) this.close(span, 'incomplete');
    this.reasoning.clear();
    if (m.headers) this.close(m.headers, 'incomplete');
    const usage = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'totalTokens']) {
      const value = numeric(message.usage?.[key]);
      if (value !== null) usage[key] = value;
    }
    this.close(m.span, status, {
      provider: id(message.provider), model: id(message.model), response_model: id(message.responseModel),
      thinking_level: id(message.providerThinkingLevel) || id(this.session.thinking_level),
      stop_reason: id(message.stopReason), usage, chunks: m.chunks,
      first_output_ms: m.firstOutputMs, first_text_ms: m.firstTextMs,
      first_output_context_ms: m.firstOutputContextMs, first_text_context_ms: m.firstTextContextMs,
      http_header_attempts: m.headerAttempts, http_statuses: m.httpStatuses,
      provider_hook_attribution: this.session.source === 'background-worker' ? 'explicit_worker_request_id' : 'unknown_no_request_id',
    });
    this.model = null;
  }

  toolStart(event) {
    this.start();
    const parent = this.tools.get(event.parentToolCallId) || null;
    const span = this.open('tool', id(event.toolName) || 'unknown', parent, {
      tool_call_id: id(event.toolCallId), parent_tool_call_id: id(event.parentToolCallId),
    });
    this.tools.set(event.toolCallId, span);
  }
  toolEnd(event) {
    this.close(this.tools.get(event.toolCallId), event.isError ? 'error' : 'completed');
    this.tools.delete(event.toolCallId);
  }
  turnEnd(event) {
    if (this.active) this.active.assistant_entry_id = id(event.messageEntryId);
    this.event('turn_end', { turn_index: numeric(event.turnIndex), assistant_entry_id: id(event.messageEntryId) });
  }
  uiStart(kind) { if (this.active) this.ui.push(this.open('ui_wait', 'user_confirmation', null, { kind: id(kind) })); }
  uiEnd() { this.close(this.ui.pop()); }
  compactStart() {
    this.standaloneMaintenance = !this.active;
    this.start('maintenance');
    this.compaction = this.open('compaction', 'session_compaction');
  }
  compactEnd(failed = false) {
    this.close(this.compaction, failed ? 'error' : 'completed');
    this.compaction = null;
    if (this.standaloneMaintenance) this.finish(failed ? 'error' : 'completed');
    this.standaloneMaintenance = false;
  }
  finish(outcome = 'completed') {
    if (!this.active) { this.pending = null; return; }
    const at = this.clock();
    for (const span of [...this.spans.keys()]) {
      this.active.complete = false;
      this.close(span, 'incomplete', {}, at);
    }
    this.event('activity_settled', { outcome }, at);
    this.active.ended_wall = at.wall;
    this.active.duration_ms = Math.max(0, at.mono - this.active.started_mono);
    this.active.status = outcome;
    this.emit({ op: 'trace', value: { ...this.active } });
    this.active = null;
    this.model = null;
    this.compaction = null;
    this.tools.clear();
    this.reasoning.clear();
    this.ui = [];
    this.pending = null;
  }
}
