import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import autoLearn from '../src/index.ts';
import backgroundTasks from '../../pi-background-tasks/src/index.ts';
import { Learner } from '../src/learner.ts';
import { fixture, addSkill } from './helpers.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; }
async function bounded(p: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SDK fixture boundary timeout')), 8000); })]); }
  finally { clearTimeout(timer!); }
}
test('real Pi SDK/background worker: overlapping host evidence has owning task, and ordinary nested foreground tools still learn', async t => {
  const f = await fixture(t, false); await addSkill(f.root, 'foreground-skill'); await addSkill(f.root, 'worker-skill');
  const previous = process.env.PI_CODING_AGENT_DIR, offline = process.env.PI_OFFLINE;
  const agentDir = join(f.base, 'agent'); process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
  const workerStarted = deferred(), releaseWorker = deferred(), workerTools = deferred(), workerEnded = deferred();
  const observations: any[] = [], errors: string[] = [], hostCalls: any[] = [];
  const oldObserve = Learner.prototype.observe;
  Learner.prototype.observe = async function(session, entry, evidence, used) { observations.push({ session, entry, evidence, used }); };
  const model: Model<Api> = { id: 'offline', name: 'Offline', provider: 'ownership-sdk-fixture', api: 'ownership-sdk-api', baseUrl: 'http://127.0.0.1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 };
  let workerRoot = '', workerOrchestrator = '', taskId = '', workerEnds = 0;
  const fake = (pi: ExtensionAPI) => {
    pi.events.on('background-tasks:telemetry:v1', data => {
      const e = data as any;
      if (e.type === 'worker-start') { workerRoot = e.rootCallId; taskId = e.taskId; }
      if (e.type === 'worker-end') workerEnded.resolve();
    });
    pi.on('tool_execution_start', e => { hostCalls.push({ ...e, boundary: 'start' }); if (e.parentToolCallId === workerRoot && e.toolName === 'worker_nested') workerOrchestrator = e.toolCallId; });
    pi.on('tool_execution_end', e => {
      hostCalls.push({ ...e, boundary: 'end' });
      if (e.parentToolCallId === workerOrchestrator && e.toolName === 'read' && ++workerEnds === 2) workerTools.resolve();
    });
    pi.registerTool({ name: 'worker_nested', label: 'Worker nested fixture', description: 'Sequential synthetic worker reads', parameters: Type.Object({}),
      async execute(_id, _args, signal, _update, ctx: ExtensionToolContext) {
        const read = await ctx.executeTool('read', { path: join(f.root, 'worker-skill', 'SKILL.md') }, { signal });
        assert.equal(read.isError, false);
        const missing = await ctx.executeTool('read', { path: join(f.base, 'missing-worker.txt') }, { signal });
        assert.equal(missing.isError, true);
        return { content: [{ type: 'text', text: 'Sequential worker reads finished.' }], details: undefined };
      },
    });
    pi.registerTool({ name: 'ordinary_nested', label: 'Nested fixture', description: 'Legitimate foreground nested calls', parameters: Type.Object({}),
      async execute(_id, _args, signal, _update, ctx: ExtensionToolContext) {
        await ctx.executeTool('read', { path: join(f.root, 'foreground-skill', 'SKILL.md') }, { signal });
        await ctx.executeTool('bash', { command: 'exit 7' }, { signal });
        return { content: [{ type: 'text', text: 'Nested workflow finished.' }], details: undefined };
      },
    });
    pi.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: 'inert-offline-fixture', api: model.api, models: [{ ...model }],
      streamSimple(m, context, options: SimpleStreamOptions | undefined) {
        assert.equal(options?.sessionId?.startsWith('auto-learn-'), false, 'no learning provider inference in fixture');
        const worker = options?.sessionId?.startsWith('background-') ?? false;
        const stream = createAssistantMessageEventStream();
        const last = context.messages.filter(message => message.role !== 'system').at(-1)!;
        const user = context.messages.filter(message => message.role === 'user').at(-1)!;
        const text = user.role === 'user' ? typeof user.content === 'string' ? user.content : user.content.filter(c => c.type === 'text').map(c => c.text).join('') : '';
        const call = (name: string, args: any, id: string) => ({ type: 'toolCall' as const, id, name, arguments: args });
        void (async () => {
          let content: AssistantMessage['content'];
          if (worker && last.role === 'user') {
            workerStarted.resolve(); await releaseWorker.promise;
            content = [call('worker_nested', {}, 'worker-orchestrator-call')];
          } else if (!worker && last.role === 'user' && text === 'Dispatch the synthetic background workflow.') {
            content = [call('background_dispatch', { task: 'Read synthetic fixture skill and verify a missing file, then finish.', title: 'Synthetic ownership', eta_seconds: 300, estimate_reason: 'Synthetic multi-round integration.', mode: 'manual', access: 'write', context_mode: 'brief' }, 'dispatch-real-sdk')];
          } else if (!worker && last.role === 'user' && text === 'Overlap the foreground workflow.') {
            // Both activities overlap, but serialize permission-table effects so
            // this ownership regression does not depend on mutex retry scheduling.
            content = [call('read', { path: join(f.root, 'foreground-skill', 'SKILL.md') }, 'foreground-overlap')];
          } else if (!worker && last.role === 'toolResult' && text === 'Overlap the foreground workflow.') {
            // Let the foreground read's host resource cleanup complete before
            // releasing the already-admitted worker model stream.
            await new Promise<void>(resolve => setTimeout(resolve, 50));
            releaseWorker.resolve(); await workerTools.promise;
            content = [{ type: 'text', text: 'Foreground workflow verified.' }];
          } else if (!worker && last.role === 'user' && text === 'Run legitimate nested tools.') {
            content = [call('ordinary_nested', {}, 'ordinary-nested-real-sdk')];
          } else content = [{ type: 'text', text: 'Verified synthetic workflow.' }];
          const message: AssistantMessage = { role: 'assistant', content, provider: m.provider, model: m.id, api: m.api, timestamp: Date.now(), stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
          stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end();
        })().catch(() => stream.end());
        options?.signal?.addEventListener('abort', () => stream.end(), { once: true });
        return stream;
      },
    });
  };
  // Explicit flags use real factories, without depending on a particular user's defaults.
  const configuredAuto = (pi: ExtensionAPI) => { const getFlag = pi.getFlag.bind(pi); autoLearn({ ...pi, getFlag: name => name === 'auto-learn-root' ? f.root : name === 'auto-learn-state' ? f.state : name === 'auto-learn-no-advertise' ? true : getFlag(name) }); };
  const settings = SettingsManager.inMemory({ defaultTools: ['read', 'bash'], retry: { enabled: false }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: f.base, agentDir, settingsManager: settings, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [fake, configuredAuto, backgroundTasks] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.base, agentDir, model, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(f.base) });
  t.after(async () => {
    releaseWorker.resolve(); workerTools.resolve(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); await session.abort(); session.dispose(); Learner.prototype.observe = oldObserve;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
  });
  await session.bindExtensions({ mode: 'rpc', onError: e => errors.push(e.error) });
  await session.prompt('Dispatch the synthetic background workflow.'); await bounded(workerStarted.promise);
  await bounded(session.prompt('Overlap the foreground workflow.')); await session.prompt('/auto-learn status');
  const overlap = observations.find(o => o.evidence?.user === 'Overlap the foreground workflow.') ?? observations[1];
  assert.deepEqual(overlap.used, ['foreground-skill'], JSON.stringify(hostCalls.map(e => ({ boundary: e.boundary, id: e.toolCallId, parent: e.parentToolCallId, error: e.isError, result: e.isError ? e.result : undefined })))); assert.deepEqual(overlap.evidence.failures, []);
  await bounded(workerEnded.promise); await session.waitForIdle();
  await session.prompt('Run legitimate nested tools.'); await session.prompt('/auto-learn status');
  const nested = observations.at(-1)!; assert.deepEqual(nested.used, ['foreground-skill']); assert.deepEqual(nested.evidence.failures, ['bash: failed']);
  // Query through a real callable tool context rather than bypassing the SDK host.
  const status = session.extensionRunner.getToolDefinition('auto_learn_status')!;
  const result = await status.execute('inspection', { action: 'status' }, undefined, undefined, session.extensionRunner.createContext() as any);
  const tasks = JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('')).taskEvidence;
  const task = tasks.find((row: any) => row.taskId === taskId);
  assert.ok(task); assert.equal(task.rootCallId, workerRoot); assert.deepEqual(task.used, ['worker-skill'], JSON.stringify(hostCalls.filter(e => e.parentToolCallId === workerRoot).map(e => ({ boundary: e.boundary, id: e.toolCallId, error: e.isError, result: e.isError ? e.result : undefined })))); assert.deepEqual(task.failures, ['read: failed']);
  assert.equal(task.automaticLearning, false); assert.ok(task.sourceEntryId);
  assert.ok(hostCalls.some(e => e.boundary === 'start' && e.parentToolCallId === workerRoot));
  assert.ok(hostCalls.some(e => e.boundary === 'start' && e.parentToolCallId === 'ordinary-nested-real-sdk'));
  assert.deepEqual(errors, []);
});
