import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { buildSessionContext, convertToLlm, estimateTokens, generateSummaryWithUsage } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Job, NormalizedDispatch, Profile } from './types.ts';
import { addUsage } from './types.ts';
import { contextMessages, isReadOnlyTool, workerInstructions, workerToolAllowed } from './policy.ts';
import { observeFailure, safeToolName } from './report.ts';

export interface WorkerHooks { changed(): void; checkAlive(): void }
export function createWorker(pi: ExtensionAPI, job: Job, profile: Profile, dispatch: NormalizedDispatch, hooks: WorkerHooks): Agent {
  const ctx = job.ctx!;
  const progress = job.progress = { lastPhase: 'preparing', pendingTools: new Set<string>(), abortedTools: new Set<string>() } as NonNullable<Job['progress']>;
  const settings = structuredClone(pi.getSettings());
  const snapshot = contextMessages(dispatch, () => buildSessionContext(ctx.sessionManager.getBranch()).messages);
  // Execute through the ORIGINAL host tool pipeline, not directly through an unguarded execute function.
  // This also preserves extension/MCP tools and their live runtime without starting another Telegram poller.
  const tools = (): AgentTool[] => {
    const metadata = new Map(pi.getAllTools().map(t => [t.name, t]));
    return ctx.tools.filter(tool => {
      const info = metadata.get(tool.name);
      return info && workerToolAllowed(info) && (job.record.access === 'write' ||
        isReadOnlyTool(tool.name, info) || tool.name === 'background_update_eta');
    }).map(tool => ({ ...tool,
      execute: async (_callId, args, signal, onUpdate) => {
        hooks.checkAlive();
        const combined = signal ? AbortSignal.any([signal, job.controller!.signal]) : job.controller!.signal;
        try {
          const outcome = await ctx.executeTool(tool.name, args, { signal: combined, onUpdate });
          return { ...outcome.result, isError: outcome.isError };
        } catch (e) {
          if (combined.aborted) progress.abortedTools.add(_callId);
          throw e; // The SDK converts this to a tool error; it need not terminate the task.
        }
      },
    }));
  };
  const streamFn: StreamFn = async (model, context, options) => {
    const compacting = progress.lastPhase === 'compacting';
    if (!compacting) progress.lastPhase = 'requesting';
    const failed = () => observeFailure(progress, compacting ? 'compaction_error' : 'provider_or_stream_error');
    try {
      const stream = await ctx.modelRegistry.streamSimple(model, context, {
        ...options,
        thinkingBudgets: options?.thinkingBudgets ?? settings.thinkingBudgets,
        timeoutMs: settings.retry?.provider?.timeoutMs ?? (settings.httpIdleTimeoutMs === 0 ? 2147483647 : settings.httpIdleTimeoutMs ?? 300_000),
        websocketConnectTimeoutMs: settings.websocketConnectTimeoutMs ?? 15_000,
        maxRetries: settings.retry?.provider?.maxRetries ?? 0,
        maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs ?? 60_000,
      });
      // Observe only the fixed terminal reason, never errorMessage/diagnostics/payloads.
      void stream.result().then(message => { if (message.stopReason === 'error') failed(); }, failed);
      return new Proxy(stream, {
        get(target, key) {
          if (key === Symbol.asyncIterator) return async function* () {
            try { for await (const event of target) yield event; }
            catch (e) { failed(); throw e; }
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    } catch (e) { failed(); throw e; }
  };
  const system = `${ctx.getSystemPrompt()}\n\n${workerInstructions(job.record)}`;
  let lastSaved = 0;
  let agent: Agent;
  agent = new Agent({
    initialState: {
      model: profile.model, thinkingLevel: profile.thinking,
      messages: [{ role: 'system', content: system, timestamp: Date.now() }, ...snapshot],
      tools: tools(),
    },
    sessionId: `background-${job.record.id}`,
    thinkingBudgets: settings.thinkingBudgets,
    transport: settings.transport ?? 'auto',
    streamFn,
    convertToLlm: messages => {
      progress.lastPhase = 'preparing';
      try {
        const converted = convertToLlm(messages);
        if (!settings.images?.blockImages) return converted;
        return converted.map(m => (m.role === 'user' || m.role === 'toolResult') && Array.isArray(m.content)
          ? { ...m, content: m.content.map(c => c.type === 'image' ? { type: 'text' as const, text: 'Image reading is disabled.' } : c) } : m);
      } catch (e) { observeFailure(progress, 'request_preparation_error'); throw e; }
    },
    // Refresh before Pi announces declaration changes, not after that boundary in prepareRequest.
    prepareNextTurnWithContext: ({ context }) => {
      progress.lastPhase = 'preparing';
      try { return { context: { ...context, tools: tools() } }; }
      catch (e) { observeFailure(progress, 'request_preparation_error'); throw e; }
    },
    prepareRequest: async ({ context }, signal) => {
      progress.lastPhase = 'preparing';
      try {
        hooks.checkAlive();
        const override = settings.compaction?.modelOverrides?.[`${profile.model.provider}/${profile.model.id}`];
        const reserve = override?.reserveTokens ?? settings.compaction?.reserveTokens ?? 16_384;
        const keep = override?.keepRecentTokens ?? settings.compaction?.keepRecentTokens ?? 20_000;
        let messages = context.messages;
        const total = messages.reduce((n, m) => n + estimateTokens(m), 0);
        if (settings.compaction?.enabled !== false && total > profile.model.contextWindow - reserve) {
          progress.lastPhase = 'compacting';
          messages = await compactWorker(messages, profile, reserve, keep, streamFn, signal, usage => addUsage(job.record.usage, usage));
          progress.lastPhase = 'preparing';
        }
        return { context: { messages, tools: context.tools }, model: profile.model, thinkingLevel: profile.thinking };
      } catch (e) {
        observeFailure(progress, progress.lastPhase === 'compacting' ? 'compaction_error' : 'request_preparation_error');
        throw e;
      }
    },
  });
  agent.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      job.record.turns++; addUsage(job.record.usage, event.message.usage);
    }
    if (event.type === 'message_end' && event.message.role === 'toolResult') addUsage(job.record.usage, event.message.usage);
    if (event.type === 'tool_execution_start') {
      job.record.toolCalls++; job.record.lastTool = safeToolName(event.toolName);
      progress.lastPhase = 'tool'; progress.lastToolCallId = event.toolCallId; progress.lastToolOutcome = undefined;
      progress.pendingTools.add(event.toolCallId);
    }
    if (event.type === 'tool_execution_end') {
      progress.pendingTools.delete(event.toolCallId);
      if (progress.lastToolCallId === event.toolCallId) progress.lastToolOutcome = progress.abortedTools.has(event.toolCallId)
        ? 'aborted' : event.isError === true ? 'error' : event.isError === false ? 'completed' : undefined;
      progress.abortedTools.delete(event.toolCallId);
    }
    if (event.type !== 'agent_start') job.record.lastActivityAt = Date.now();
    if (Date.now() - lastSaved > 5000 || event.type === 'turn_end') { lastSaved = Date.now(); hooks.changed(); }
    if (job.record.turns >= 200) {
      job.abortCategory ??= 'turn_limit'; progress.failurePhase ??= progress.lastPhase;
      job.controller!.abort(); agent.abort();
    }
  });
  return agent;
}

export async function compactWorker(messages: AgentMessage[], profile: Profile, reserve: number, keep: number,
  streamFn: StreamFn, signal: AbortSignal | undefined,
  reportUsage: (usage: AssistantMessage['usage']) => void): Promise<AgentMessage[]> {
  // Keep a coherent recent suffix. A tool result is never the cut point.
  const nonSystem = messages.filter(m => m.role !== 'system');
  let index = nonSystem.length - 1, tokens = 0;
  for (; index > 0; index--) {
    tokens += estimateTokens(nonSystem[index]!);
    if (tokens >= keep) break;
  }
  while (index > 0 && nonSystem[index]!.role === 'toolResult') index--;
  if (index <= 0) throw new Error('Background context exceeds the model limit and cannot be compacted safely.');
  const result = await generateSummaryWithUsage(nonSystem.slice(0, index), profile.model,
    Math.min(reserve, profile.model.maxTokens), undefined, undefined, signal,
    'Preserve task requirements, authorizations, output paths, verification, blockers and unfinished work. Never invent completion.',
    undefined, profile.thinking, streamFn, undefined, undefined, undefined, 'background-compaction');
  reportUsage(result.usage);
  const head = getCurrentSystemMessage(messages);
  if (!head) throw new Error('Background context lost its system prompt.');
  const summary: AgentMessage = { role: 'compactionSummary', summary: result.text, tokensBefore: tokens, timestamp: Date.now() };
  return [head, summary, ...nonSystem.slice(index)];
}
export function finalAssistant(agent: Agent): AssistantMessage | undefined {
  return [...agent.state.messages].reverse().find((m): m is AssistantMessage => m.role === 'assistant');
}
export function assistantText(message?: AssistantMessage): string {
  return Array.isArray(message?.content) ? message.content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.type === 'text' ? c.text : '').join('\n') : '';
}
