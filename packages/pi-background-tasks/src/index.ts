import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BackgroundManager } from './manager.ts';
import { MAIN_POLICY, statusLine } from './policy.ts';
import type { Dispatch } from './types.ts';

const dispatchSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 40000, description: 'Self-contained delegated task, paths, requirements, permissions and expected deliverables.' }),
  title: Type.String({ minLength: 1, maxLength: 160 }),
  eta_seconds: Type.Integer({ minimum: 1, maximum: 604800, description: 'Realistic estimated TOTAL execution + verification + delivery seconds, not just model response time.' }),
  eta_max_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604800, description: 'Realistic upper end of the uncertainty range. Must be >= eta_seconds. Auto routes above 120 seconds.' })),
  estimate_reason: Type.String({ minLength: 1, maxLength: 2000, description: 'Evidence-based basis for ETA: scope, expected calls, testing, network/model latency and uncertainty.' }),
  mode: Type.Optional(StringEnum(['auto', 'manual'] as const, { description: 'auto delegates above two minutes; manual always delegates.' })),
  access: Type.Optional(StringEnum(['read', 'write'] as const, { description: 'Default write, including shell commands and unknown side effects. read denies shells and mutating tools.' })),
  context_mode: Type.Optional(StringEnum(['brief', 'selected', 'full'] as const, { description: 'Default brief: no conversation history. selected: only supplied context_text. full: projected conversation, only when the user explicitly asks to share it. Never choose full automatically.' })),
  context_text: Type.Optional(Type.String({ minLength: 1, maxLength: 20000, description: 'Only with context_mode selected: concise relevant facts/excerpts written by the main agent. No automatic message selection. Larger references should be file paths.' })),
});
export default function backgroundTasks(pi: ExtensionAPI): void {
  let manager = new BackgroundManager(pi);
  pi.registerFlag('background-dir', { type: 'string', description: 'Private runtime storage. Default: <cwd>/temp_files/pi-background-tasks.' });
  pi.registerFlag('background-max-workers', { type: 'string', default: '2', description: 'Maximum concurrent workers (1-8). Only one writer per workspace.' });
  pi.registerFlag('background-timeout-minutes', { type: 'string', default: '240', description: 'Worker safety timeout in minutes; default 240.' });

  pi.registerTool({
    name: 'background_dispatch', label: 'Background task', exposure: 'model-only', executionMode: 'sequential',
    description: 'Non-blocking delegation. For substantive tasks estimated to take more than 120 seconds, call this BEFORE long execution with a realistic ETA and reason. Manual requests always delegate. Returns an accepted task ID immediately without waiting. Worker inherits the main model/provider/thinking, instructions, skill access and callable tools; NO conversation history is copied by default. Supply a complete compact task brief, with selected reference context or user-requested full history as explicit opt-ins. Main chat remains free. Short auto tasks return inline. Do not wait, sleep or poll.',
    promptSnippet: 'Delegate work non-blockingly, with a realistic completion estimate.',
    promptGuidelines: ['Delegate tasks estimated over two minutes with background_dispatch. Include an honest ETA, reason and self-contained brief; omit history by default. Acknowledge the work naturally with an honest estimated duration, then return control. Keep task IDs internal unless genuinely necessary for clarity or troubleshooting, or explicitly requested; avoid robotic job-ticket acknowledgments and fixed catchphrases, and vary the wording naturally.'],
    parameters: dispatchSchema,
    execute: async (callId, args, signal, _update, ctx) => manager.dispatch(args as Dispatch, ctx, callId, signal),
  });
  pi.registerTool({
    name: 'background_tasks', label: 'Background tasks',
    description: 'Inspect or cancel background tasks without waiting. result fetches only final visible text (never reasoning) and reports worker usage once. Do not repeatedly poll. list and status report live progress, not invented percentages. Tasks are scoped to the current parent session.',
    parameters: Type.Object({
      action: StringEnum(['list', 'status', 'result', 'cancel'] as const),
      id: Type.Optional(Type.String({ description: 'Required except for list.' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Result character offset for pagination.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000, description: 'Result page size; default 12000 characters.' })),
    }),
    execute: async (_id, args, _signal, _update, ctx) => {
      await manager.init(ctx);
      if (args.action === 'list') {
        const records = manager.list();
        return { content: [{ type: 'text', text: records.length ? records.map(r => statusLine(r)).join('\n\n') : 'No background tasks in this session.' }], details: { tasks: records } };
      }
      if (!args.id) throw new Error('Task ID is required.');
      if (args.action === 'result') return manager.result(args.id, args.offset, args.limit);
      if (args.action === 'cancel') {
        const record = await manager.cancel(args.id);
        return { content: [{ type: 'text', text: `${statusLine(record)}\nCancellation is cooperative; already performed effects are not rolled back.` }], details: record };
      }
      const record = manager.get(args.id).record;
      return { content: [{ type: 'text', text: statusLine(record) }], details: structuredClone(record) };
    },
  });
  pi.registerTool({
    name: 'background_update_eta', label: 'Revise background ETA',
    description: 'Revise a live task ETA honestly using remaining duration and a reason. The main chat is notified. Workers can revise only their own task. This does not extend the runtime safety timeout.',
    parameters: Type.Object({
      id: Type.String(), remaining_seconds: Type.Integer({ minimum: 1, maximum: 604800 }),
      remaining_max_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604800 })),
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    execute: async (_id, args, _signal, _update, ctx) => {
      await manager.init(ctx);
      const record = await manager.updateEta(args.id, args.remaining_seconds, args.remaining_max_seconds, args.reason);
      return { content: [{ type: 'text', text: statusLine(record) }], details: record };
    },
  });

  pi.registerCommand('bg', {
    description: 'Background delegation: /bg <task>; /bg list|status|result|cancel <id>; /bg auto on|off',
    handler: async (args, ctx) => {
      try {
        await manager.init(ctx);
        const text = args.trim();
        const [action, id, extra] = text.split(/\s+/);
        if (!text || action === 'help') {
          ctx.ui.notify('Use /bg <task> (main agent estimates and dispatches), /bg list, /bg status <id>, /bg result <id>, /bg cancel <id>, /bg auto on|off. Normal chat can also request background work.', 'info'); return;
        }
        if (action === 'list') {
          ctx.ui.notify(manager.list().map(r => statusLine(r)).join('\n\n') || 'No background tasks in this session.', 'info'); return;
        }
        if (action === 'status' && id && !extra) { ctx.ui.notify(statusLine(manager.get(id).record), 'info'); return; }
        if (action === 'cancel' && id && !extra) { ctx.ui.notify(`${statusLine(await manager.cancel(id))}\nAlready performed effects are not rolled back.`, 'info'); return; }
        if (action === 'auto' && (id === 'on' || id === 'off') && !extra) { manager.setAuto(id === 'on'); ctx.ui.notify(`Automatic background routing is ${id}. Manual delegation still works.`, 'info'); return; }
        if (action === 'result' && id && !extra) {
          manager.get(id);
          pi.sendUserMessage(`Fetch and report the saved result of background task ${id} using background_tasks action result. Do not rerun the task.`, { deliverAs: 'followUp', expandPromptTemplates: false }); return;
        }
        if (['status', 'cancel', 'result', 'auto'].includes(action!)) throw new Error('Invalid /bg command. Use /bg help.');
        if (ctx.mode !== 'rpc' && ctx.mode !== 'tui') throw new Error('Background delegation requires a long-lived TUI or RPC session.');
        pi.sendUserMessage(`Manual background delegation request. Estimate total time realistically, then call background_dispatch with mode manual before doing the task. Include a justified ETA and a self-contained brief with authorization limits, necessary facts, requirements, skill/reference paths and deliverable paths. Default to context_mode brief, without conversation history. Use selected context_text only for needed reference material, or full only if the user explicitly asks to share history. Acknowledge the work naturally with an honest estimated duration, explicitly as an estimate, and return control without waiting. Keep task IDs internal unless genuinely necessary for clarity or troubleshooting, or explicitly requested; avoid robotic job-ticket acknowledgments and fixed catchphrases, and vary the wording naturally.\n\nTask:\n${action === 'run' ? text.slice(3).trim() : text}`, { deliverAs: 'followUp', expandPromptTemplates: false });
      } catch (e) { ctx.ui.notify(e instanceof Error ? e.message : 'Background command failed.', 'error'); }
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    if (manager.closed) manager = new BackgroundManager(pi);
    await manager.init(ctx);
  });
  pi.on('before_agent_start', (event, ctx) => {
    // Structured prompt update, not an opaque replacement. Never modifies the original user message.
    const text = `${MAIN_POLICY}\nAutomatic routing is currently ${manager.auto ? 'on' : 'off'}.`;
    event.systemPromptOptions.sections.background_policy = text;
    manager.ctx = ctx;
    // Opaque forced prompts bypass structured sections, so include this section explicitly.
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
      return { systemPrompt: `${event.systemPrompt}\n\n<background_policy>\n${text}\n</background_policy>` };
    }
  });
  pi.on('tool_call', (event, ctx) => manager.guard(event, ctx));
  pi.on('agent_settled', () => { manager.scheduleNotifications(); });
  pi.on('session_shutdown', () => manager.shutdown());
}
