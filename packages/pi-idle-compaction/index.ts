import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createIdleCompactor } from './controller.mjs';
import { createBackgroundGuard } from './background.mjs';

// Standalone runtime: Node built-ins + the host's public Pi API only.
export default function idleCompaction(pi: ExtensionAPI) {
  const pending = new Set<() => void>();
  let stopped = false;
  const rpc = (method: string): Promise<any> => new Promise(resolve => {
    if (stopped) { resolve(null); return; }
    const requestId = randomUUID();
    let done = false;
    let off = () => {};
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      off();
      pending.delete(cancel);
      resolve(value);
    };
    const cancel = () => finish(null);
    off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply: any) => {
      finish(reply?.version === 1 && reply.requestId === requestId && reply.success ? reply.data : null);
    });
    pending.add(cancel);
    timeout = setTimeout(cancel, 5000);
    timeout.unref?.();
    try { pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method, params: {} }); }
    catch { cancel(); }
  });
  const controller = createIdleCompactor({
    acquireBackgroundLease: createBackgroundGuard({
      getTools: () => pi.getAllTools(),
      rpc,
    }),
  });

  pi.on('session_start', (_event, ctx) => {
    stopped = false;
    // Do not run timers in noninteractive batch/child sessions.
    if (ctx.mode === 'tui' || ctx.mode === 'rpc') controller.reset(ctx);
    else controller.setEnabled(false, ctx);
  });
  pi.on('input', () => { controller.activity(); });
  pi.on('agent_start', () => { controller.activity(); });
  pi.on('tool_execution_start', () => { controller.activity(); });
  pi.on('agent_settled', (_event, ctx) => { controller.settled(ctx); });
  pi.on('ui_prompt_start', () => { controller.suspend(); });
  pi.on('ui_prompt_end', (_event, ctx) => { controller.resume(ctx); });
  pi.on('session_before_switch', () => { controller.activity(); });
  pi.on('session_before_fork', () => { controller.activity(); });
  pi.on('session_before_tree', () => { controller.activity(); });
  pi.on('session_tree', (_event, ctx) => { controller.reset(ctx); });
  pi.on('session_before_compact', () => { controller.suspend(); });
  pi.on('session_compact', (_event, ctx) => { controller.resume(ctx); controller.compacted(); });
  pi.on('session_compact_failed', () => { controller.failed(); });
  pi.on('session_shutdown', async () => {
    stopped = true;
    for (const cancel of [...pending]) cancel();
    await controller.shutdown();
  });
  pi.registerCommand('idle-compact', {
    description: 'Standalone idle compaction status or session-local on/off',
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === 'on' || action === 'off') controller.setEnabled(action === 'on', ctx);
      else if (action && action !== 'status') {
        ctx.ui.notify('Usage: /idle-compact [status|on|off]', 'warning');
        return;
      }
      ctx.ui.notify(controller.status(), 'info');
    },
  });
}
