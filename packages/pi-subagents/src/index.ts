import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SubagentsManager } from './manager.ts';
import { discover } from './registry.ts';
import { renderSubagentsSection } from './context.ts';
import { registerSubagentsBackgroundWork } from './background.ts';

function renderList(runs: Awaited<ReturnType<SubagentsManager['list']>>): string {
  if (!runs.runs.length) return 'No subagent runs in this session.';
  const lines = runs.runs.map(run => {
    const when = run.finishedAt ? `${run.createdAt} → ${run.finishedAt}` : run.createdAt;
    const reason = run.reason ? ` · ${run.reason}` : '';
    return `${run.id} · ${run.agent} · ${run.status}${reason}\n  ${run.title}\n  ${when} · ${run.duration}`;
  });
  return lines.join('\n\n');
}

export default function subagents(pi: ExtensionAPI): void {
  let manager = new SubagentsManager(pi);
  let unregisterBackground: (() => void) | undefined;
  let backgroundWarningShown = false;
  let discoveryWarningShown = false;
  const registerBackground = (ctx?: ExtensionContext) => {
    unregisterBackground?.();
    unregisterBackground = undefined;
    try {
      unregisterBackground = registerSubagentsBackgroundWork(sessionId => manager.activeWork(sessionId));
    } catch {
      // Coordination is optional; a corrupt foreign registry must not break
      // dispatch. Report one bounded warning without exposing registry contents.
      if (!backgroundWarningShown) {
        backgroundWarningShown = true;
        try {
          if (ctx?.hasUI) ctx.ui.notify('Subagent background coordination is unavailable; idle compaction stays deferred while subagent tools are present.', 'warning');
        } catch { /* A UI failure must not break the session. */ }
      }
    }
  };

  pi.registerFlag('subagents-max-running', {
    type: 'string', default: '4',
    description: 'Maximum concurrent subagents per session (1-16).',
  });

  pi.registerTool({
    name: 'subagent_dispatch', label: 'Dispatch subagent',
    description: 'Delegate a self-contained job to a named subagent and keep the chat free. Returns after the supervisor reports ready, at most two seconds. Briefs are files, not history: include paths, scope, constraints, and completion criteria. No worker memory, no recursive delegation. Do not poll; a notice arrives when it settles.',
    parameters: Type.Object({
      agent: Type.String({ minLength: 1, maxLength: 64, description: 'Definition name under ~/.pi/agent/subagents/.' }),
      title: Type.String({ minLength: 1, maxLength: 160, description: 'Short single-line label for the run.' }),
      brief: Type.String({ minLength: 1, maxLength: 40000, description: 'Complete, self-contained job: objective, paths, scope, constraints, completion criteria.' }),
      cwd: Type.String({ minLength: 1, maxLength: 4096, description: 'Existing absolute working directory for the worker.' }),
    }, { additionalProperties: false }),
    execute: async (_callId, args, _signal, _update, ctx) => {
      const run = await manager.dispatch(args, ctx);
      return {
        content: [{ type: 'text', text: `Dispatched ${run.agent} as ${run.id}. A notice arrives when it settles; do not poll.` }],
        details: run,
      };
    },
  });

  pi.registerTool({
    name: 'subagent_steer', label: 'Steer subagent',
    description: 'Send an instruction into a running subagent without restarting it. Delivered between turns; completed work is preserved. Use when the user changes direction or adds a requirement. Delivery is best effort: an accepted steer can still be dropped if the run settles first. Not valid after the run settles. Waiting for the ack can take up to two seconds.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, description: 'Run id from subagent_dispatch or subagent_tasks.' }),
      message: Type.String({ minLength: 1, maxLength: 8000, description: 'Adjustment or added requirement; not a new brief.' }),
    }, { additionalProperties: false }),
    execute: async (_callId, args, _signal, _update, ctx) => {
      const result = await manager.steer(args.id, args.message, ctx);
      const text = result.disposition === 'unconfirmed'
        ? `Steering for ${result.id} was not confirmed; it may still be delivered. Do not resend blindly.`
        : result.disposition === 'settled'
          ? `Run ${result.id} settled before the steer; nothing was delivered.`
          : result.disposition === 'rejected'
            ? `Steering for ${result.id} was rejected.`
            : `Steering accepted for ${result.id} (${result.disposition}); this means forwarded, not yet read.`;
      return { content: [{ type: 'text', text }], details: result };
    },
  });

  pi.registerTool({
    name: 'subagent_tasks', label: 'Subagent tasks',
    description: 'Inspect or cancel subagent runs from this session. Use result after a notice to read a report; do not poll while a run is active.',
    parameters: Type.Object({
      action: StringEnum(['list', 'status', 'result', 'cancel'] as const),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: 'Required except for list.' })),
      page: Type.Optional(Type.Integer({ minimum: 1, description: 'list page, 1-based; 20 runs per page.' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'result character offset; 12000 characters per page.' })),
    }, { additionalProperties: false }),
    execute: async (_callId, args, _signal, _update, ctx) => {
      manager = manager.closed ? new SubagentsManager(pi) : manager;
      await manager.init(ctx);
      if (args.action === 'list') {
        const listed = await manager.list(args.page ?? 1);
        return { content: [{ type: 'text', text: renderList(listed) }], details: listed };
      }
      if (!args.id) throw new Error('Run id is required for this action.');
      if (args.action === 'status') {
        const status = await manager.status(args.id);
        const body = Object.entries(status).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n');
        return { content: [{ type: 'text', text: body }], details: status };
      }
      if (args.action === 'result') {
        const page = await manager.result(args.id, args.offset ?? 0);
        const suffix = page.nextOffset !== undefined ? `\n\n[continued at offset ${page.nextOffset} of ${page.totalChars}]` : '';
        const text = page.totalChars ? `${page.text}${suffix}` : page.text;
        return { content: [{ type: 'text', text }], details: page };
      }
      const cancelled = await manager.cancel(args.id);
      return {
        content: [{ type: 'text', text: `Cancellation requested for ${cancelled.id}. The worker is aborted; already performed work is not rolled back.` }],
        details: cancelled,
      };
    },
  });

  pi.on('before_agent_start', (event, ctx) => {
    try {
      const body = renderSubagentsSection(discover().definitions);
      if (body) event.systemPromptOptions.sections.subagents = body;
    } catch (error) {
      // A malformed agent directory disables the subagent section, not every
      // prompt assembly. Dispatch still reports the actionable error lazily.
      delete event.systemPromptOptions.sections.subagents;
      if (!discoveryWarningShown) {
        discoveryWarningShown = true;
        try {
          if (ctx?.hasUI) ctx.ui.notify(`Subagent discovery is unavailable: ${(error as Error).message}`, 'warning');
        } catch { /* A UI failure must not break prompt assembly. */ }
      }
    }
  });

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    if (manager.closed) manager = new SubagentsManager(pi);
    await manager.init(ctx);
    registerBackground(ctx);
  });
  pi.on('session_shutdown', async () => {
    unregisterBackground?.();
    unregisterBackground = undefined;
    await manager.shutdown();
  });
}
