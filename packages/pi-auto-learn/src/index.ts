import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Skill } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { dirname, join, resolve, matchesGlob } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Evidence, Host, ModelReply } from './types.ts';
import { Store } from './state.ts';
import { Writer } from './safe-writer.ts';
import { Learner } from './learner.ts';
import { BusyError } from './lock.ts';
import { capture } from './observations.ts';
import { InputAdmission, messageText } from './input-admission.ts';
import { ToolEvidence } from './tool-evidence.ts';
import { resolveProfile, selectionKey } from './model-profile.ts';
import { displaySafe } from './privacy.ts';
import { readFileSafe, targetPath, within } from './filesystem.ts';

async function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function noSkillDiscovery(): boolean { return process.argv.includes('--no-skills') || process.argv.includes('-ns'); }
function excluded(pi: ExtensionAPI, ctx: ExtensionContext, path: string): boolean {
  let result = false;
  for (const raw of pi.getSettings().skills ?? []) {
    if (!/^[!+-]/.test(raw)) continue;
    const paths = [getAgentDir(), join(ctx.cwd, '.pi')].map(base => resolve(base, raw.slice(1).replace(/^~(?=\/)/, process.env.HOME ?? '')));
    const matches = paths.some(p => raw[0] === '!' ? matchesGlob(path, p) || matchesGlob(dirname(path), p) : within(p, path));
    if (matches) result = raw[0] !== '+';
  }
  return result;
}

export default function autoLearn(pi: ExtensionAPI): void {
  pi.registerFlag('auto-learn-root', { type: 'string', description: 'Override managed skill container (testing/custom agent directories)' });
  pi.registerFlag('auto-learn-state', { type: 'string', description: 'Override private auto-learn runtime directory' });
  pi.registerFlag('auto-learn-disabled', { type: 'boolean', default: false, description: 'Disable automatic learning and core repair' });
  pi.registerFlag('auto-learn-no-advertise', { type: 'boolean', default: false, description: 'Do not add managed skills to foreground discovery' });
  let store: Store | undefined;
  let writer: Writer | undefined;
  let learner: Learner | undefined;
  let context: ExtensionContext | undefined;
  let stopped = false;
  let active = false;
  let admitted = false;
  const admission = new InputAdmission(pi);
  let boundaryCompleted = false;
  let activityEpoch = 0;
  const toolEvidence = new ToolEvidence();
  pi.events.on('background-tasks:telemetry:v1', data => {
    if (context && !stopped) toolEvidence.workerEvent(data, context.sessionManager.getSessionId());
  });
  let dispatched: { selectedKey: string; message: AssistantMessage } | undefined;
  let external: Skill[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let integrity: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  let backgroundTask: Promise<unknown> | undefined;
  let retryCount = 0;
  let advertised = new Map<string, string>();
  let initializing: Promise<void> | undefined;
  const disabled = () => pi.getFlag('auto-learn-disabled') === true;
  const session = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const report = (error: unknown) => {
    if (context?.hasUI && !stopped) context.ui.notify(`auto-learn: ${displaySafe((error as Error).message, 250)}`, 'warning');
  };
  const enqueue = (work: () => Promise<unknown>) => {
    pending = pending.then(() => stopped ? undefined : work()).catch(report);
    return pending;
  };
  const stopWork = () => { if (timer) clearTimeout(timer); timer = undefined; learner?.cancel(); };
  const host = (ctx: ExtensionContext): Host => ({
    sessionId: session(ctx), branchIds: new Set(ctx.sessionManager.getBranch().map(e => e.id)), mode: ctx.mode,
    isIdle: () => !stopped && !active && ctx.isIdle(), hasPending: () => ctx.hasPendingMessages(),
    profile: () => resolveProfile(ctx, pi, dispatched),
    external: external.map(s => ({ name: s.name, description: s.description })),
    complete: async (system, input, profile, signal, maxTokens): Promise<ModelReply> => {
      const stream = ctx.modelRegistry.streamSimple(profile.model, {
        messages: [
          { role: 'system', content: system, timestamp: Date.now() },
          { role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }], timestamp: Date.now() },
        ], tools: [],
      }, {
        ...profile.options, reasoning: profile.level === 'off' ? undefined : profile.level,
        signal, maxTokens, sessionId: `auto-learn-${randomUUID()}`, cacheRetention: 'none',
        timeoutMs: (await store!.config()).timeoutMs, maxRetries: 0,
      });
      const result = await cancellable(stream.result(), signal);
      if (result.stopReason !== 'stop' || result.content.some(c => c.type === 'toolCall')) throw new Error(`Learning provider did not return complete text (${result.stopReason})`);
      return { text: result.content.filter(c => c.type === 'text').map(c => c.text).join(''), tokens: result.usage.totalTokens, cost: result.usage.cost.total };
    },
  });
  const initialize = async (ctx: ExtensionContext) => {
    context = ctx;
    if (learner) return;
    initializing ??= (async () => {
      if (typeof ctx.modelRegistry?.streamSimple !== 'function' || typeof ctx.sessionManager?.getBranch !== 'function') throw new Error('Required provider-neutral streaming or session APIs are unavailable');
      const agent = getAgentDir();
      const root = resolve(String(pi.getFlag('auto-learn-root') || join(agent, 'skills', 'auto-learn')));
      const state = resolve(String(pi.getFlag('auto-learn-state') || join(agent, 'auto-learn')));
      store = new Store(state); writer = new Writer(root, store);
      await store.init(root);
      learner = new Learner(store, writer);
      const config = await store.config();
      const data = await store.read();
      if (!disabled() && config.enabled && !data.paused) {
        try { await writer.recover(); await writer.ensureCore(session(ctx)); }
        catch (e) { if (!(e instanceof BusyError) && !/Foreground activity|paused|excluded/.test((e as Error).message)) throw e; }
      }
      await learner.sync();
    })();
    await initializing;
  };
  const background = async () => {
    if (!context || stopped || disabled() || active || !context.isIdle() || context.hasPendingMessages()) return;
    if (backgroundTask) return;
    backgroundTask = (async () => {
      const result = await learner!.run(host(context!));
      if (context?.mode === 'tui' && !stopped) context.ui.setStatus('auto-learn', `learn: ${result.slice(0, 60)}`);
      const cfg = await store!.config();
      if (!stopped && !active && retryCount < cfg.maxRetries && /timeout|overloaded|ECONNRESET|network|503|429/i.test(result)) {
        retryCount++;
        timer = setTimeout(() => { timer = undefined; void background().catch(report); }, Math.max(cfg.intervalMs, 30_000) * 2 ** retryCount);
        timer.unref();
      }
    })().finally(() => { backgroundTask = undefined; });
    await backgroundTask;
  };
  const schedule = async () => {
    if (!context || disabled() || stopped || !admitted || context.mode === 'print' || context.mode === 'json') return;
    const config = await store!.config();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void background().catch(report); }, config.debounceMs);
    timer.unref();
  };

  pi.on('session_start', async (_event, ctx) => {
    stopped = false; active = false; toolEvidence.clear();
    try {
      await initialize(ctx);
      integrity = setInterval(() => {
        if (!context || active || stopped || disabled() || !context.isIdle()) return;
        void enqueue(async () => {
          const s = await store!.read(); const cfg = await store!.config();
          if (!s.paused && cfg.enabled) {
            await writer!.recover(); await writer!.ensureCore(session(context!)); await learner!.sync();
            if (admitted && (context!.mode === 'tui' || context!.mode === 'rpc')) void background().catch(report);
          }
        });
      }, 60_000); integrity.unref();
      heartbeat = setInterval(() => { if (active && context) void store!.activity(session(context), true).catch(report); }, 30_000); heartbeat.unref();
    } catch (e) { report(e); }
  });
  pi.on('resources_discover', async (_event, ctx) => {
    try {
      await initialize(ctx);
      if (disabled() || pi.getFlag('auto-learn-no-advertise') || noSkillDiscovery() || !(await store!.config()).advertise || excluded(pi, ctx, writer!.root)) return;
      return { skillPaths: learner!.records.filter(r => r.valid && !excluded(pi, ctx, join(writer!.root, r.id, 'SKILL.md'))).map(r => join(writer!.root, r.id, 'SKILL.md')) };
    } catch (e) { report(e); }
  });
  pi.on('input', (event, ctx) => {
    context = ctx; stopWork(); active = true; retryCount = 0;
    activityEpoch++; admitted = false; boundaryCompleted = false;
    admission.input(event, session(ctx));
    toolEvidence.begin(session(ctx));
    void enqueue(async () => { if (store) await store.activity(session(ctx), true); });
  });
  pi.on('message_start', (event, ctx) => {
    admission.consume(event.message.role, 'content' in event.message ? event.message.content : undefined, session(ctx));
    if (event.message.role === 'custom') { activityEpoch++; admitted = false; toolEvidence.invalidate(); stopWork(); }
  });
  pi.on('agent_start', (_event, ctx) => { activityEpoch++; context = ctx; active = true; boundaryCompleted = false; toolEvidence.ensure(session(ctx)); stopWork(); void enqueue(async () => store?.activity(session(ctx), true)); });
  pi.on('before_agent_start', async (event, ctx) => {
    context = ctx; stopWork();
    if (!writer || !learner) return;
    enqueue(() => store!.activity(session(ctx), true)); await pending;
    external = event.systemPromptOptions.skills.filter(s => !within(writer!.root, s.filePath));
    if (disabled() || event.systemPromptOptions.forceSystemPrompt) return;
    if (pi.getFlag('auto-learn-no-advertise') || noSkillDiscovery() || !(await store!.config()).advertise || excluded(pi, ctx, writer.root)) {
      event.systemPromptOptions.skills = external; return;
    }
    const names = new Set(external.map(s => s.name));
    const managed: Skill[] = [];
    for (const r of learner.records) {
      if (!r.valid || names.has(r.name) || excluded(pi, ctx, join(writer.root, r.id, 'SKILL.md'))) continue;
      names.add(r.name);
      const base = join(writer.root, r.id);
      managed.push({ name: r.name, description: r.description, filePath: join(base, 'SKILL.md'), baseDir: base, disableModelInvocation: r.disableModelInvocation, sourceInfo: { path: join(base, 'SKILL.md'), source: 'local', scope: 'user', origin: 'top-level', baseDir: base } });
    }
    const next = new Map(learner.records.filter(r => managed.some(s => s.filePath === join(writer!.root, r.id, 'SKILL.md'))).map(r => [r.id, r.hash]));
    const changed = [...next].filter(([id, h]) => advertised.has(id) && advertised.get(id) !== h).map(([id]) => id);
    const removed = [...advertised.keys()].filter(id => !next.has(id));
    if (changed.length || removed.length) event.systemPromptOptions.sections.auto_learn_revisions = `Managed skill revisions changed: ${changed.join(', ') || 'none'}. Removed from active discovery: ${removed.join(', ') || 'none'}. Reread a changed skill's current SKILL.md before relying on cached instructions; do not continue using removed skills.`;
    else delete event.systemPromptOptions.sections.auto_learn_revisions;
    advertised = next;
    event.systemPromptOptions.skills = [...external, ...managed];
  });
  pi.on('message_end', (event, ctx) => {
    context = ctx;
    if (event.message.role === 'assistant' && !['pending', 'aborted', 'error', 'deferred'].includes(event.message.stopReason)) dispatched = { selectedKey: selectionKey(ctx, pi), message: event.message };
  });
  pi.on('tool_execution_start', (event, ctx) => {
    const p = event.toolName === 'read' && typeof event.args?.path === 'string' ? resolve(ctx.cwd, event.args.path) : undefined;
    const record = p && writer ? learner?.records.find(r => p === join(writer!.root, r.id, 'SKILL.md')) : undefined;
    toolEvidence.start(event, session(ctx), record?.id, ctx.signal);
  });
  pi.on('tool_execution_end', (event, ctx) => { toolEvidence.end(event, session(ctx)); });
  pi.on('agent_before_settle', event => { boundaryCompleted = event.outcome === 'completed'; });
  pi.on('agent_settled', (_event, ctx) => {
    context = ctx; active = false;
    const owner = toolEvidence.finish();
    const usedIds = [...owner?.used ?? []]; const failureIds = [...owner?.failures ?? []];
    const branch = ctx.sessionManager.getBranch();
    const latestUser = [...branch].reverse().find(e => e.type === 'message' && e.message.role === 'user');
    const eligible = admission.snapshot(session(ctx), latestUser?.type === 'message' ? messageText('content' in latestUser.message ? latestUser.message.content : undefined) : '');
    const evidence: Evidence | undefined = boundaryCompleted ? capture(branch, session(ctx), usedIds, failureIds) : undefined;
    const completed = boundaryCompleted;
    const epoch = activityEpoch;
    boundaryCompleted = false;
    void enqueue(async () => {
      if (!store || !learner) return;
      if (epoch === activityEpoch) await store.activity(session(ctx), false);
      const latestAssistant = [...branch].reverse().find(e => e.type === 'message' && e.message.role === 'assistant');
      const config = await store.config();
      const allowed = completed && eligible(config.admitGuests);
      // Preserve worker diagnostics under their ORIGINAL admitted human activity,
      // not the unrelated chat that happens to settle while their tools run.
      const state = await store.read();
      toolEvidence.admit(owner, completed && eligible(false) && config.enabled && !disabled() && !state.paused && !state.excluded.includes(session(ctx)), latestUser?.id);
      if (epoch === activityEpoch) admitted = allowed && !active;
      if (allowed && !disabled() && latestUser && latestAssistant?.type === 'message' && latestAssistant.message.role === 'assistant' && latestAssistant.message.stopReason === 'stop' && config.enabled) await learner.observe(session(ctx), latestUser.id, evidence, usedIds);
      if (epoch === activityEpoch) await schedule();
    });
  });
  const invalidate = () => { activityEpoch++; stopWork(); dispatched = undefined; admitted = false; admission.clear(); toolEvidence.invalidate(); };
  const navigate = () => { invalidate(); toolEvidence.clear(); };
  pi.on('model_select', invalidate);
  pi.on('thinking_level_select', invalidate);
  pi.on('session_before_switch', navigate);
  pi.on('session_before_fork', navigate);
  pi.on('session_before_tree', navigate);
  pi.on('session_shutdown', async (_event, ctx) => {
    stopped = true; active = false; stopWork(); admission.clear(); admitted = false; toolEvidence.clear();
    if (integrity) clearInterval(integrity); if (heartbeat) clearInterval(heartbeat);
    await pending;
    await backgroundTask?.catch(() => undefined);
    if (store) await store.activity(session(ctx), false).catch(() => undefined);
    ctx.ui.setStatus('auto-learn', undefined);
  });

  const status = async (action: string, skill?: string): Promise<unknown> => {
    if (!store || !learner || !writer) return { status: 'Not initialized or unavailable' };
    const s = await store.read();
    const budget = s.budget.filter(b => Date.now() - b.timestamp < 3_600_000);
    const currentProfile = context ? resolveProfile(context, pi, dispatched) : undefined;
    const tasks = context ? toolEvidence.diagnostics(session(context)) : [];
    if (action === 'list') return learner.records.map(r => ({ id: r.id, name: r.name, valid: r.valid, issue: r.issue, hash: r.hash, pinned: s.pins.includes(r.id), stats: s.skills[r.id] }));
    if (action === 'history') return s.history.filter(r => !skill || r.skillId === skill).slice(-20);
    if (action === 'retired') return s.history.filter(r => r.operation === 'delete' && r.status === 'committed').slice(-30);
    return { status: disabled() ? 'Disabled by flag' : s.paused ? 'Paused' : 'Enabled', root: writer.root, stateDirectory: store.root, managedSkills: learner.records.length, pendingEvidence: s.evidence.length, taskEvidence: tasks.slice(-10), taskEvidenceCount: tasks.length, taskEvidenceTruncated: tasks.length > 10, running: learner.running, selectedProfile: currentProfile ? { selected: currentProfile.selected, selectedLevel: currentProfile.selectedLevel, dispatched: `${currentProfile.model.provider}/${currentProfile.model.id}`, thinking: currentProfile.level } : undefined, lastResult: learner.lastResult, lastError: s.lastError, hourlyTokens: budget.reduce((n, b) => n + b.tokens, 0), uncertainReservedTokens: budget.reduce((n, b) => n + b.reserved, 0), estimatedCost: budget.reduce((n, b) => n + b.cost, 0) };
  };
  pi.registerTool({
    name: 'auto_learn_status', label: 'Auto-learn status', description: 'Read-only inspection of auto-learn state, managed skills, history, or retirement archives. Does not trigger learning or mutate skills.',
    parameters: Type.Object({ action: Type.Optional(Type.Union([Type.Literal('status'), Type.Literal('list'), Type.Literal('history'), Type.Literal('retired')])), skill: Type.Optional(Type.String()) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, args) => ({ content: [{ type: 'text', text: displaySafe(JSON.stringify(await status(args.action ?? 'status', args.skill), null, 2)) }], details: undefined }),
  });
  pi.registerCommand('auto-learn', {
    description: 'Inspect/control background skill learning; status, list, history, cleanup, pause, resume, pin, restore, rollback',
    handler: async (args, ctx: ExtensionCommandContext) => {
      await initialize(ctx);
      await pending; // Flush settled observations before an immediate user command.
      const [action = 'status', target, revision] = args.trim().split(/\s+/).filter(Boolean);
      let result: unknown;
      if (['status', 'list', 'history', 'retired'].includes(action)) result = await status(action, target);
      else if (action === 'pause') { stopWork(); await store!.change(s => { s.paused = true; }); result = 'Paused'; }
      else if (action === 'resume') { await store!.change(s => { s.paused = false; }); await writer!.ensureCore(session(ctx)); await learner!.sync(); await schedule(); result = 'Resumed'; }
      else if (action === 'run' || action === 'cleanup') { await ctx.waitForIdle(); active = false; await store!.activity(session(ctx), false); result = await learner!.run(host(ctx), true, action === 'cleanup'); }
      else if (action === 'pin' || action === 'unpin') {
        if (!target || !learner!.records.some(r => r.id === target)) throw new Error('Name a managed directory ID');
        stopWork(); await store!.change(s => { s.pins = action === 'pin' ? [...new Set([...s.pins, target])] : s.pins.filter(x => x !== target); }); result = `${action}: ${target}`;
      } else if (action === 'suppress') {
        if (!target) throw new Error('Name the unwanted workflow');
        await store!.change(s => { s.suppressed = [...new Set([...s.suppressed, args.slice(args.indexOf(' ') + 1).trim()])]; }); result = 'Workflow suppressed';
      } else if (action === 'exclude-session') {
        stopWork(); toolEvidence.clear(); await store!.change(s => { s.excluded = [...new Set([...s.excluded, session(ctx)])]; s.evidence = s.evidence.filter(e => e.sessionId !== session(ctx)); }); result = 'Session excluded; queued evidence removed';
      } else if (action === 'clear-evidence') { stopWork(); toolEvidence.clear(); await store!.change(s => { s.evidence = []; }); result = 'Evidence cleared'; }
      else if (action === 'restore') { stopWork(); if (!target) throw new Error('Name a retirement ID'); result = await writer!.restore(target, session(ctx)); await learner!.sync(); }
      else if (action === 'rollback') { stopWork(); if (!target) throw new Error('Name a skill directory'); result = await writer!.rollback(target, revision, session(ctx)); await learner!.sync(); }
      else if (action === 'purge') {
        stopWork(); if (!target || !ctx.hasUI) throw new Error('Purge needs an archive ID and an interactive confirmation-capable client');
        if (await ctx.ui.confirm('Permanently purge archive?', `Remove recovery archive ${target}. This cannot be undone. Active skills are not removed.`)) { await writer!.purge(target); result = 'Archive permanently purged'; } else result = 'Cancelled';
      } else if (action === 'diff') {
        const s = await store!.read(); const r = s.history.filter(r => r.skillId === target && (!revision || r.id === revision)).at(-1);
        if (!r) throw new Error('No matching revision');
        result = { revision: r, previous: r.archive ? displaySafe((await readFileSafe(join(targetPath(store!.root, r.archive), 'SKILL.md'), 131_072)).toString()) : null, current: learner!.records.find(x => x.id === target)?.markdown ? displaySafe(learner!.records.find(x => x.id === target)!.markdown) : null, proposed: r.proposal ? JSON.parse(displaySafe((await readFileSafe(targetPath(store!.root, r.proposal), 512_000)).toString())) : null };
      } else throw new Error('Unknown auto-learn command');
      const message = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      if (ctx.hasUI) ctx.ui.notify(displaySafe(message), 'info');
      else pi.sendMessage({ customType: 'auto-learn.command', content: displaySafe(message), display: true }, { triggerTurn: false });
    },
  });
}
