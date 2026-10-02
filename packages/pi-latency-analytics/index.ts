import { join, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Collector } from './lib/collector.mjs';
import { WriterClient } from './lib/client.mjs';
import { formatReport } from './lib/report.mjs';

const actions = ['last', 'recent', 'slow', 'trace', 'status'] as const;
type Action = typeof actions[number];

/** Standalone: public Pi APIs only. No Telegram imports, hooks, patches, or polling. */
export default function latencyAnalytics(pi: ExtensionAPI) {
  let writer: WriterClient | undefined;
  let outcome = 'completed';
  let captureErrors = 0;
  let collector = new Collector((record: unknown) => writer?.enqueue(record));

  function configure(ctx: ExtensionContext) {
    collector.configure({
      session_id: ctx.sessionManager.getSessionId(),
      anchor_entry_id: ctx.sessionManager.getLeafId(),
      provider: ctx.model?.provider, model: ctx.model?.id,
      thinking_level: ctx.thinkingLevel,
    });
  }
  function observe(fn: () => void) {
    try { fn(); } catch { captureErrors++; if (collector.active) collector.active.complete = false; }
    // Deliberately return nothing: never change a Pi event, prompt, or tool result.
  }
  async function query(action: Action, ctx: ExtensionContext, traceId?: string, limit = 10) {
    if (!writer) throw new Error('Analytics is not active in this session.');
    let result;
    try {
      result = await writer.query({
        action, traceId, limit, sessionId: ctx.sessionManager.getSessionId(),
        excludeTrace: collector.active?.trace_id || null,
      });
    } catch (error) {
      if (action !== 'status') throw error;
      return { coverage: 'pi-only', storage: 'unavailable', collector: { ...writer.health(), capture_errors: captureErrors } };
    }
    if (action === 'status') return { ...result, collector: { ...writer.health(), capture_errors: captureErrors } };
    return result;
  }

  pi.on('session_start', (_event, ctx) => {
    observe(() => {
      if (!writer) {
        collector = new Collector((record: unknown) => writer?.enqueue(record));
        const dataDir = resolve(process.env.PI_LATENCY_DIR || join(getAgentDir(), 'analytics'));
        writer = new WriterClient(join(dataDir, 'analytics.sqlite'), collector.instanceId);
      }
      configure(ctx);
    });
  });
  pi.on('input', (event, ctx) => { observe(() => { configure(ctx); collector.input(event.source); }); });
  pi.on('before_agent_start', (_event, ctx) => { observe(() => { configure(ctx); collector.beforeAgent(); outcome = 'completed'; }); });
  pi.on('agent_start', () => { observe(() => collector.agentStart()); });
  pi.on('agent_end', () => { observe(() => collector.agentEnd()); });
  pi.on('agent_before_settle', event => { observe(() => { outcome = event.outcome; }); });
  pi.on('agent_settled', () => { observe(() => collector.finish(outcome)); });
  pi.on('context', (_event, ctx) => { observe(() => { configure(ctx); collector.context(); }); });
  pi.on('message_start', event => { observe(() => collector.messageStart(event.message)); });
  pi.on('message_update', event => { observe(() => collector.stream(event.assistantMessageEvent)); });
  pi.on('message_end', event => { observe(() => collector.messageEnd(event.message)); });
  pi.on('before_provider_request', () => { observe(() => collector.providerRequest()); });
  pi.on('before_provider_headers', () => { observe(() => collector.providerHeaders()); });
  pi.on('after_provider_response', event => { observe(() => collector.providerResponse(event.status)); });
  pi.on('tool_execution_start', event => { observe(() => collector.toolStart(event)); });
  pi.on('tool_execution_end', event => { observe(() => collector.toolEnd(event)); });
  pi.on('turn_end', event => { observe(() => collector.turnEnd(event)); });
  pi.on('ui_prompt_start', event => { observe(() => collector.uiStart(event.kind)); });
  pi.on('ui_prompt_end', () => { observe(() => collector.uiEnd()); });
  pi.on('session_before_compact', () => { observe(() => collector.compactStart()); });
  pi.on('session_compact', () => { observe(() => collector.compactEnd()); });
  pi.on('session_compact_failed', () => { observe(() => collector.compactEnd(true)); });
  pi.on('session_shutdown', async () => {
    observe(() => collector.finish('interrupted'));
    const closing = writer;
    writer = undefined;
    try { await closing?.close(); } catch { /* Fail open; status/DB preserve coverage limitations. */ }
  });

  pi.registerTool(defineTool({
    name: 'latency_query', label: 'Latency query',
    description: 'Read recorded Pi latency when asked. No Telegram delivery timing or reasoning text. last excludes the current activity.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object({
      action: Type.Union(actions.map(action => Type.Literal(action))),
      trace_id: Type.Optional(Type.String({ maxLength: 160 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Analytics query cancelled.');
      if (params.action === 'trace' && !params.trace_id) throw new Error('trace_id is required for trace details.');
      const result = await query(params.action, ctx, params.trace_id, params.limit);
      if (signal?.aborted) throw new Error('Analytics query cancelled.');
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: { coverage: 'pi-only', action: params.action },
      };
    },
  }));

  pi.registerCommand('latency', {
    description: 'Local, no-LLM latency report: last | recent [N] | slow [N] | trace ID | status',
    handler: async (args, ctx) => {
      const [raw = 'last', argument] = args.trim() ? args.trim().split(/\s+/) : [];
      if (!actions.includes(raw as Action)) { ctx.ui.notify('Usage: /latency last|recent [N]|slow [N]|trace ID|status', 'info'); return; }
      if (raw === 'trace' && !argument) { ctx.ui.notify('Usage: /latency trace TRACE_ID', 'info'); return; }
      try {
        const result = await query(raw as Action, ctx, raw === 'trace' ? argument : undefined, Number(argument) || 10);
        ctx.ui.notify(formatReport(raw, result), 'info');
      } catch { ctx.ui.notify('Latency analytics unavailable. The recorder does not block normal replies.', 'warning'); }
    },
  });
}
