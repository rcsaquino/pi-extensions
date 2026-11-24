import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createIdleCompactor, IDLE_MS } from './controller.mjs';
import { createBackgroundGuard, createDailyResetGuard } from './background.mjs';
import { createDailySessionReset } from './daily.mjs';

// Standalone runtime: Node built-ins + the host's public Pi API only.
export default function idleCompaction(pi: ExtensionAPI) {
  const controller = createIdleCompactor({
    acquireBackgroundLease: createBackgroundGuard(),
  });
  const daily = createDailySessionReset({
    idleMs: IDLE_MS,
    admit: createDailyResetGuard(),
    // ctx.newSession() is command-only; dispatch the internal command instead.
    requestReset: () => pi.sendUserMessage('/idle-daily-reset', { expandPromptTemplates: true }),
  });

  pi.on('session_start', (_event, ctx) => {
    // Do not run timers in noninteractive batch/child sessions.
    if (ctx.mode === 'tui' || ctx.mode === 'rpc') {
      controller.reset(ctx);
      daily.reset(ctx);
    } else {
      controller.setEnabled(false, ctx);
      daily.setEnabled(false, ctx);
    }
  });
  pi.on('input', () => { controller.activity(); daily.activity(); });
  pi.on('agent_start', () => { controller.activity(); daily.activity(); });
  pi.on('tool_execution_start', () => { controller.activity(); daily.activity(); });
  pi.on('agent_settled', (_event, ctx) => { controller.settled(ctx); daily.settled(ctx); });
  pi.on('ui_prompt_start', () => { controller.suspend(); daily.suspend(); });
  pi.on('ui_prompt_end', (_event, ctx) => { controller.resume(ctx); daily.resume(ctx); });
  pi.on('session_before_switch', (event, ctx) => {
    if (event.reason === 'new' && daily.isRequestPending() &&
        (!ctx.isIdle() || ctx.hasPendingMessages())) {
      // Our own reset arrived while the session became busy. Keep the compaction
      // timer armed; the daily scheduler will retry after the next settle.
      daily.activity();
      return { cancel: true };
    }
    controller.activity();
    daily.activity();
  });
  pi.on('session_before_fork', () => { controller.activity(); daily.activity(); });
  pi.on('session_before_tree', () => { controller.activity(); daily.activity(); });
  pi.on('session_tree', (_event, ctx) => { controller.reset(ctx); daily.reset(ctx); });
  pi.on('session_before_compact', () => { controller.suspend(); daily.suspend(); });
  pi.on('session_compact', (_event, ctx) => {
    controller.resume(ctx);
    controller.compacted();
    daily.resume(ctx);
  });
  pi.on('session_compact_failed', (_event, ctx) => { controller.failed(); daily.resume(ctx); });
  pi.on('session_shutdown', () => { controller.shutdown(); daily.shutdown(); });
  pi.registerCommand('idle-compact', {
    description: 'Standalone idle compaction status or session-local on/off',
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === 'on' || action === 'off') controller.setEnabled(action === 'on', ctx);
      else if (action && action !== 'status') {
        ctx.ui.notify('Usage: /idle-compact [status|on|off]', 'warning');
        return;
      }
      ctx.ui.notify(`${controller.status()}\n${daily.status()}`, 'info');
    },
  });
  // The host exposes ctx.newSession() only to command handlers. The daily
  // scheduler dispatches this command through sendUserMessage.
  pi.registerCommand('idle-daily-reset', {
    description: 'Internal: start a new session for the day when the idle timer allows',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        daily.finish({ cancelled: true });
        return;
      }
      try {
        daily.finish(await ctx.newSession());
      } catch (error) {
        daily.finish({ error });
      }
    },
  });
}
