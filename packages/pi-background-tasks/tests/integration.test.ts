import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { offlineWeb } from './web-fixture.ts';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, JsonObject, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import extension from '../src/index.ts';
import { MAIN_POLICY } from '../src/policy.ts';
import { Store } from '../src/store.ts';
import type { Dispatch, RecordData } from '../src/types.ts';
import { scratch } from './helpers.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function eventually<T>(fn: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn(); if (predicate(value)) return value; if (Date.now() > end) throw new Error('Timed out waiting for test condition.'); await new Promise(r => setTimeout(r, 10)); }
}
interface Call { worker: boolean; model: string; reasoning?: string; budgets: unknown; system: string; tools: string[]; text: string; lastRole: string; transcript: string }
interface Metadata { type?: string; taskId?: string; requestId?: string; rootCallId?: string; usage?: { totalTokens?: number; output?: number } }
async function fixture(t: TestContext, mode: ExtensionContext['mode'] = 'rpc', forcedPrompt?: string, sourceLoader = false) {
  const root = await scratch('bg-sdk-test-');
  const agentDir = join(root, 'agent'); await fs.mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR, offline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
  const provider = 'background-offline-fixture';
  const model: Model<Api> = { id: 'main', name: 'Main offline fixture', provider, api: 'background-fake-api', baseUrl: 'http://127.0.0.1', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32000 };
  const calls: Call[] = [], errors: string[] = [], hooks: string[] = []; const settledTasks = new Set<string>(); const metadata: Metadata[] = [];
  const file = join(root, 'source.txt'); await fs.writeFile(file, 'Known inherited-tool result');
  await fs.mkdir(join(agentDir, 'skills', 'inherited-skill'), { recursive: true });
  await fs.writeFile(join(agentDir, 'skills', 'inherited-skill', 'SKILL.md'), '---\nname: inherited-skill\ndescription: Special inherited fixture skill.\n---\nUse this skill for the fixture.\n');
  let gate = deferred(), blocked = true;
  let behavior: 'plain' | 'read' | 'slow' | 'nested' | 'dynamic' | 'error' | 'length' | 'staged' | 'shell_pair' | 'stage_escape' | 'direct_write' = 'plain';
  let nestedEffects = 0, denyStart = false, mutateStart = false;
  let slowStarted = false, slowAborted = false;
  let p: Dispatch = { task: 'Do the delegated fixture work and verify it.', title: 'Fixture', eta_seconds: 300, eta_max_seconds: 480, estimate_reason: 'Several tool/model rounds, implementation and verification.', mode: 'manual', access: 'write' };
  let sessionId = '';
  const store = () => new Store(join(root, 'temp_files', 'pi-background-tasks'), sessionId);
  const toolCall = (name: string, args: JsonObject, id = `${name}-${calls.length}`) => ({ type: 'toolCall' as const, id, name, arguments: args });
  const response = (m: Model<Api>, content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop'): AssistantMessage => ({
    role: 'assistant', content, provider: m.provider, model: m.id, api: m.api, timestamp: Date.now(), stopReason,
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const textOf = (context: TranscriptContext) => {
    const last = context.messages.filter(m => m.role === 'user').at(-1);
    return last?.role === 'user' ? typeof last.content === 'string' ? last.content : last.content.filter(c => c.type === 'text').map(c => c.text).join('') : '';
  };
  const fake = (pi: ExtensionAPI) => {
    const stop = pi.events.on('background-tasks:telemetry:v1', data => { const event = data as Metadata; metadata.push(event); if (event.type === 'worker-end' && event.taskId) settledTasks.add(event.taskId); });
    pi.on('session_shutdown', () => stop());
    pi.registerProvider(provider, {
      baseUrl: model.baseUrl, apiKey: 'inert-offline-fixture-key', api: model.api, models: [{ ...model }, { ...model, id: 'second', name: 'Second fixture' }],
      streamSimple(m, context, options: SimpleStreamOptions | undefined) {
        const stream = createAssistantMessageEventStream();
        const worker = options?.sessionId?.startsWith('background-') ?? false;
        const last = context.messages.filter(message => message.role !== 'system').at(-1)!;
        const text = textOf(context);
        calls.push({ worker, model: m.id, reasoning: options?.reasoning, budgets: options?.thinkingBudgets, system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(t => t.name), text, lastRole: last.role, transcript: JSON.stringify(context.messages) });
        const produce = async () => {
          await options?.onPayload?.({ private: 'SDK_TELEMETRY_PRIVATE_PAYLOAD' }, m);
          await options?.onResponse?.({ status: 200, headers: { private: 'SDK_TELEMETRY_PRIVATE_HEADERS' } }, m);
          let content: AssistantMessage['content']; let stop: AssistantMessage['stopReason'] | undefined;
          if (worker) {
            if (blocked && (behavior === 'plain' || behavior === 'error' || behavior === 'length' || ((behavior === 'read' || behavior === 'direct_write') && last.role === 'toolResult') || (behavior === 'staged' && last.role === 'toolResult' && last.toolName === 'write'))) await gate.promise;
            if (last.role === 'user' && behavior === 'direct_write') content = [toolCall('write', { path: join(root, 'competing.txt'), content: `worker edit ${options?.sessionId}` })];
            else if (last.role === 'user' && behavior === 'shell_pair') content = ['one', 'two'].map(id => toolCall('bash', { command: `node ${JSON.stringify(join(root, 'shell-test.mjs'))} ${JSON.stringify(join(root, 'shell-events.jsonl'))} ${id}`, timeout: 5 }, `shell-${id}`));
            else if (last.role === 'user' && behavior === 'stage_escape') content = [toolCall('write', { path: '../staged-escape.txt', content: 'must be blocked' })];
            else if (last.role === 'user' && behavior === 'staged') content = [toolCall('read', { path: 'source.txt' })];
            else if (last.role === 'toolResult' && last.toolName === 'read' && behavior === 'staged') {
              const declared = JSON.parse(getCurrentSystemPrompt(context.messages).match(/Outputs: (\[[^\n]*?\])\./)![1]!) as string[];
              content = [toolCall('write', { path: declared[0]!, content: `Staged result for ${declared[0]}` })];
            }
            else if (last.role === 'user' && behavior === 'read') content = [toolCall('read', { path: file })];
            else if (last.role === 'user' && behavior === 'slow') content = [toolCall('slow_fixture', {})];
            else if (last.role === 'user' && behavior === 'nested') content = [toolCall('nested_fixture', {})];
            else if (last.role === 'user' && behavior === 'dynamic') content = [toolCall('enable_fixture', {})];
            else if (last.role === 'toolResult' && last.toolName === 'enable_fixture') content = [toolCall('new_fixture_tool', {})];
            else {
              content = [{ type: 'thinking', thinking: 'FIXTURE_PRIVATE_REASONING_NEVER_EXPORT' }, { type: 'text', text: behavior === 'error' ? 'Partial result' : 'Verified delegated result.' }];
              stop = behavior === 'error' ? 'error' : behavior === 'length' ? 'length' : 'stop';
            }
          } else if (last.role === 'toolResult') content = [{ type: 'text', text: 'Foreground acknowledgment.' }];
          else if (text.startsWith('SAFE-WEB')) content = [toolCall('background_web_search', { query: text.slice(9).trim() || 'offline SDK fixture' })];
          else if (text.startsWith('SAFE-RESULT ')) content = [toolCall('background_web_result', { responseId: text.slice(12).trim() })];
          else if (text.startsWith('PUBLISH ')) { const [id, hash] = text.slice(8).trim().split(' '); content = [toolCall('background_publish', { id: id!, expected_manifest_hash: hash! })]; }
          else if (text.startsWith('INSPECT')) content = [toolCall('background_fs_inspect', { action: 'grep', path: root, text: 'Known inherited-tool result' })];
          else if (text.startsWith('FOREGROUND-READ')) content = [toolCall('read', { path: file })];
          else if (text.startsWith('DELEGATE') || text.startsWith('Manual background delegation')) content = [toolCall('background_dispatch', { ...p })];
          else if (text.startsWith('AUTO-LONG')) content = [toolCall('background_dispatch', { ...p, mode: 'auto' })];
          else if (text.startsWith('DOUBLE')) content = [toolCall('background_dispatch', { ...p, title: 'One' }, 'first-dispatch'), toolCall('background_dispatch', { ...p, title: 'Two' }, 'second-dispatch')];
          else if (text.startsWith('TRY-WRITE')) content = [toolCall('write', { path: join(root, 'competing.txt'), content: 'foreground edit' })];
          else if (text.startsWith('LOCAL-LOOKUP')) content = [toolCall('bash', { command: `python -c 'from pathlib import Path; print(Path(${JSON.stringify(file)}).read_text())'`, timeout: 5 })];
          else if (text.startsWith('MEMORY-LOOKUP')) content = [toolCall('memoria_search', { query: 'synthetic fixture' })];
          else if (text.startsWith('DENIED-READ')) content = [toolCall('read', { path: '/denied' })];
          else if (text.startsWith('RESULT ') || text.includes('settled with status')) {
            const id = text.match(/bg-[a-f0-9]{12}/)![0]; content = [toolCall('background_tasks', { action: 'result', id })];
          } else content = [{ type: 'text', text: 'Foreground is responsive.' }];
          const message = response(m, content, stop);
          if (stop === 'error') message.errorMessage = 'Provider failure containing SECRET_NOT_FOR_LOGS';
          stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
          if (message.stopReason === 'error' || message.stopReason === 'aborted') stream.push({ type: 'error', reason: message.stopReason, error: message });
          else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : message.stopReason === 'length' ? 'length' : 'stop', message });
          stream.end();
        };
        void produce().catch(e => {
          const message = response(m, [], 'error'); message.errorMessage = String(e);
          stream.push({ type: 'error', reason: 'error', error: message }); stream.end();
        });
        // The mock provider must honor abort as a real provider does, even while our gate is unresolved.
        options?.signal?.addEventListener('abort', () => { const message = response(m, [], 'aborted'); stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(); }, { once: true });
        return stream;
      },
    });
    pi.registerTool({ name: 'slow_fixture', label: 'Slow fixture', description: 'An abortable inherited tool.', parameters: Type.Object({}),
      async execute(_id, _args, signal) {
        slowStarted = true;
        await new Promise<void>((resolve, reject) => {
          void gate.promise.then(resolve);
          signal?.addEventListener('abort', () => { slowAborted = true; reject(new Error('Stopped')); }, { once: true });
        });
        return { content: [{ type: 'text', text: 'Tool settled' }], details: undefined };
      },
    });
    pi.registerTool({ name: 'memoria_search', label: 'Synthetic memory', description: 'Inert memory query without trusted effect annotations.', parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ content: [{ type: 'text', text: 'Synthetic memory result' }], details: undefined }),
    });
    pi.registerTool({ name: 'telegram_attach', label: 'Fake delivery', description: 'Must not run inside worker.', parameters: Type.Object({}),
      execute: async () => { nestedEffects++; return { content: [], details: undefined }; },
    });
    pi.registerTool({ name: 'nested_fixture', label: 'Nested fixture', description: 'Exercises nested host tools.', parameters: Type.Object({}),
      async execute(_id, _args, _signal, _update, ctx: ExtensionToolContext) {
        const delivery = await ctx.executeTool('telegram_attach', {});
        assert.equal(delivery.isError, true);
        const recursion = await ctx.executeTool('background_dispatch', { ...p });
        assert.equal(recursion.isError, true);
        const otherEta = await ctx.executeTool('background_update_eta', { id: 'bg-999999999999', remaining_seconds: 100, reason: 'Attempting another task' });
        assert.equal(otherEta.isError, true);
        return { content: [{ type: 'text', text: 'All nested prohibitions held.' }], details: undefined,
          usage: { input: 4, output: 7, reasoning: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
      },
    });
    pi.registerTool({ name: 'enable_fixture', label: 'Dynamic fixture', description: 'Adds a tool at runtime.', parameters: Type.Object({}),
      async execute() {
        pi.registerTool({ name: 'new_fixture_tool', label: 'New fixture', description: 'Newly enabled inherited tool.', parameters: Type.Object({}), annotations: { readOnlyHint: true },
          execute: async () => ({ content: [{ type: 'text', text: 'Dynamic tool worked' }], details: undefined }),
        });
        return { content: [{ type: 'text', text: 'Enabled' }], details: undefined };
      },
    });
    pi.on('before_agent_start', event => {
      event.systemPromptOptions.sections.fixture_context = 'Unrelated section fixture.';
      event.systemPromptOptions.sections.pi_memoria = '<instructions>\nMemory guidance fixture.\n</instructions>\n<hot_memory>\nStanding instruction fixture.\n</hot_memory>';
      if (forcedPrompt !== undefined) event.systemPromptOptions.forceSystemPrompt = forcedPrompt;
    });
    pi.on('tool_call', event => { hooks.push(event.toolName); if (event.toolName === 'background_start_check' && mutateStart) (event.input.stage as { outputs: string[] }).outputs.push('injected.txt'); if (event.toolName === 'background_start_check' && denyStart) return { block: true, reason: 'Synthetic permission revalidation denied.' }; if (event.toolName === 'read' && event.input.path === '/denied') return { block: true, reason: 'Inherited permission guard.' }; });
  };
  const settings = SettingsManager.inMemory({ defaultTools: ['read', 'bash', 'edit', 'write'], defaultProvider: provider, defaultModel: model.id, defaultThinkingLevel: 'high', thinkingBudgets: { medium: 1000, high: 9000 }, retry: { enabled: false }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noContextFiles: true, noPromptTemplates: true, noThemes: true, appendSystemPrompt: ['Inherited identity and workspace rules.'],
    extensionFactories: sourceLoader ? [fake] : [fake, extension],
    ...(sourceLoader ? { additionalExtensionPaths: [fileURLToPath(new URL('../index.ts', import.meta.url))] } : {}),
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, model, thinkingLevel: 'high', settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) });
  sessionId = session.sessionManager.getSessionId();
  await session.bindExtensions({ mode, onError: e => errors.push(e.error) });
  t.after(async () => {
    gate.resolve(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); await session.abort(); await session.waitForIdle(); session.dispose();
    await fs.rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
  });
  const records = async () => {
    const directory = store().recordsDir;
    const all: RecordData[] = [];
    for (const name of await fs.readdir(directory)) if (name.endsWith('.json')) all.push(JSON.parse(await fs.readFile(join(directory, name), 'utf8')) as RecordData);
    return all;
  };
  return { root, agentDir, session, model, calls, errors, hooks, records, store, metadata,
    setCapacity: (workers: number) => session.extensionRunner.setFlagValue('background-max-workers', String(workers)),
    setParams: (next: Partial<Dispatch>) => { p = { ...p, ...next }; },
    denyStart: () => { denyStart = true; },
    mutateStart: () => { mutateStart = true; },
    setBehavior: (value: typeof behavior, wait = false) => { behavior = value; blocked = wait; },
    release: () => gate.resolve(),
    waitSettled: (id: string) => eventually(() => settledTasks.has(id), done => done),
    slowState: () => ({ slowStarted, slowAborted }), nestedEffects: () => nestedEffects,
  };
}

function promptBlock(prompt: string, name: string): string {
  assert.equal(prompt.split(`<${name}>`).length - 1, 1, `${name} opening wrapper must appear once`);
  assert.equal(prompt.split(`</${name}>`).length - 1, 1, `${name} closing wrapper must appear once`);
  const match = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(prompt);
  assert.ok(match, `${name} section must be independently wrapped`);
  return match[1]!;
}

test('real Pi SDK: background policy has a dedicated section and routing updates preserve addendum and unrelated sections', async t => {
  const f = await fixture(t);
  await f.session.prompt('Initial prompt');
  const initial = f.calls.at(-1)!.system;
  assert.equal(promptBlock(initial, 'background_policy'), `${MAIN_POLICY}\nAutomatic routing is currently on.`);
  assert.equal(promptBlock(initial, 'addendum'), 'Inherited identity and workspace rules.');
  assert.equal(promptBlock(initial, 'fixture_context'), 'Unrelated section fixture.');
  const memory = promptBlock(initial, 'pi_memoria');
  assert.match(memory, /<instructions>[\s\S]*<hot_memory>/);
  const original = f.session.messages.find(m => m.role === 'system')!;
  assert.ok(original.role === 'system' && original.sections?.background_policy);
  assert.equal(original.role === 'system' && original.sections?.addendum, '<addendum>\nInherited identity and workspace rules.\n</addendum>');

  for (const routing of ['off', 'on'] as const) {
    await f.session.prompt(`/bg auto ${routing}`);
    await f.session.prompt(`Routing ${routing} prompt`);
    const current = f.calls.at(-1)!.system;
    assert.equal(promptBlock(current, 'background_policy'), `${MAIN_POLICY}\nAutomatic routing is currently ${routing}.`);
    assert.equal(promptBlock(current, 'addendum'), promptBlock(initial, 'addendum'));
    assert.equal(promptBlock(current, 'pi_memoria'), memory);
    assert.equal(promptBlock(current, 'fixture_context'), 'Unrelated section fixture.');
    const update = f.session.messages.filter(m => m.role === 'system').at(-1)!;
    assert.ok(update.role === 'system');
    assert.deepEqual(Object.keys(update.sections ?? {}), ['background_policy']);
  }
  assert.deepEqual(f.errors, []);
});

test('real Pi SDK: forced prompts receive one background wrapper and the current routing state without replacing the opaque addendum', async t => {
  const base = 'Opaque prompt.\n<addendum>\nInherited identity and workspace rules.\n</addendum>\n<other>\nOpaque unrelated section.\n</other>';
  const f = await fixture(t, 'rpc', base);
  await f.session.prompt('Initial forced prompt');
  for (const routing of ['on', 'off', 'on'] as const) {
    await f.session.prompt(`/bg auto ${routing}`);
    await f.session.prompt(`Forced routing ${routing} prompt`);
    const current = f.calls.at(-1)!.system;
    assert.ok(current.startsWith(`${base}\n\n<background_policy>`));
    assert.equal(promptBlock(current, 'background_policy'), `${MAIN_POLICY}\nAutomatic routing is currently ${routing}.`);
    assert.equal(promptBlock(current, 'addendum'), 'Inherited identity and workspace rules.');
    assert.equal(promptBlock(current, 'other'), 'Opaque unrelated section.');
  }
  assert.deepEqual(f.errors, []);
});

test('real Pi SDK: default worker stays responsive and inherits capabilities, but not conversation or previously loaded skill text', async t => {
  const f = await fixture(t);
  await f.session.prompt('/skill:inherited-skill');
  await f.session.prompt('PARENT_HISTORY_MUST_NOT_COPY ' + 'irrelevant old context '.repeat(4000));
  await f.session.prompt('DELEGATE');
  await eventually(() => f.calls, calls => calls.some(c => c.worker));
  assert.equal(f.session.isStreaming, false);
  const records = await f.records(); assert.equal(records.length, 1); assert.equal(records[0]!.status, 'running');
  await f.session.prompt('Can we still talk?');
  assert.equal(f.session.getLastAssistantText(), 'Foreground is responsive.');
  const child = f.calls.find(c => c.worker)!;
  assert.equal(child.model, 'main'); assert.equal(child.reasoning, 'high'); assert.deepEqual(child.budgets, { medium: 1000, high: 9000 });
  assert.match(child.system, /inherited-skill/); assert.match(child.system, /Inherited identity/); assert.match(child.system, /background_worker/);
  assert.match(child.system, /inherited-skill\/SKILL\.md/);
  assert.doesNotMatch(child.transcript, /PARENT_HISTORY_MUST_NOT_COPY|Use this skill for the fixture\./);
  assert.match(child.transcript, /Do the delegated fixture work and verify it\./);
  assert.ok(child.transcript.length < 50_000, 'Large parent conversation must not enlarge the worker request.');
  assert.equal(records[0]!.contextMode, 'brief'); assert.equal(records[0]!.provider, f.model.provider);
  assert.ok(child.tools.includes('read')); assert.ok(child.tools.includes('slow_fixture')); assert.ok(!child.tools.includes('background_dispatch')); assert.ok(!child.tools.includes('telegram_attach'));
  f.release(); await eventually(f.records, rows => rows[0]!.status === 'completed' && rows[0]!.notification === 'read');
  const output = await f.store().output(records[0]!.id);
  assert.equal(output, 'Verified delegated result.'); assert.doesNotMatch(output, /PRIVATE_REASONING/);
  assert.deepEqual(f.errors, []);
});
test('real Pi SDK: selected context transmits supplied facts only, without copying irrelevant conversation', async t => {
  const f = await fixture(t);
  await f.session.prompt('PARENT_PRIVATE_IRRELEVANT_MARKER');
  f.setParams({ context_mode: 'selected', context_text: 'SELECTED_REFERENCE_MARKER: only inspect source.txt, preserve compatibility.' });
  await f.session.prompt('DELEGATE'); await eventually(() => f.calls, calls => calls.some(c => c.worker));
  const child = f.calls.find(c => c.worker)!;
  assert.match(child.transcript, /SELECTED_REFERENCE_MARKER/); assert.doesNotMatch(child.transcript, /PARENT_PRIVATE_IRRELEVANT_MARKER/);
  assert.match(child.text, /Do the delegated fixture work/); assert.equal((await f.records())[0]!.contextMode, 'selected');
  assert.doesNotMatch(await fs.readFile(f.store().path((await f.records())[0]!.id, 'json'), 'utf8'), /SELECTED_REFERENCE_MARKER|PARENT_PRIVATE/);
  assert.deepEqual(f.errors, []);
});
test('real Pi SDK: explicitly requested full mode retains projected conversation and never replays unfinished dispatch', async t => {
  const f = await fixture(t); await f.session.prompt('EXPLICIT_FULL_HISTORY_MARKER');
  f.setParams({ context_mode: 'full' }); await f.session.prompt('DELEGATE'); await eventually(() => f.calls, calls => calls.some(c => c.worker));
  const child = f.calls.find(c => c.worker)!; assert.match(child.transcript, /EXPLICIT_FULL_HISTORY_MARKER/);
  assert.match(child.text, /Do the delegated fixture work/); assert.equal((await f.records())[0]!.contextMode, 'full');
  assert.ok(!child.transcript.includes('"name":"background_dispatch","arguments"'));
  assert.deepEqual(f.errors, []);
});
for (const bad of [{ context_mode: 'selected' as const }, { context_mode: 'brief' as const, context_text: 'Unexpected reference' }]) {
  test(`real Pi SDK: invalid ${bad.context_mode} context is rejected before any worker starts`, async t => {
    const f = await fixture(t); f.setParams(bad); await f.session.prompt('DELEGATE');
    assert.equal((await f.records()).length, 0); assert.equal(f.calls.some(c => c.worker), false);
    const result = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_dispatch').at(-1)!;
    assert.equal(result.role === 'toolResult' && result.isError, true); assert.deepEqual(f.errors, []);
  });
}
test('real Pi SDK: inherited builtin read uses parent hooks and responds in an independent multi-turn worker', async t => {
  const f = await fixture(t); f.setBehavior('read'); await f.session.prompt('DELEGATE');
  await eventually(f.records, rows => rows.length > 0 && rows[0]!.notification === 'read' && rows[0]!.status === 'completed');
  assert.ok(f.hooks.includes('read')); assert.equal(f.calls.filter(c => c.worker).length, 2);
  const records = await f.records(); assert.equal(records[0]!.toolCalls, 1); assert.equal(records[0]!.turns, 2);
  assert.equal(records[0]!.usage.totalTokens, 60); assert.deepEqual(f.errors, []);
});
test('real Pi SDK: foreground abort does not abort worker; explicit cancellation does', async t => {
  const f = await fixture(t); f.setBehavior('slow'); await f.session.prompt('DELEGATE');
  await eventually(f.slowState, s => s.slowStarted);
  await f.session.abort(); assert.equal(f.slowState().slowAborted, false);
  const id = (await f.records())[0]!.id;
  await f.session.prompt(`/bg cancel ${id}`);
  await eventually(f.slowState, s => s.slowAborted);
  await eventually(f.records, rows => rows[0]!.status === 'cancelled');
  assert.deepEqual(f.errors, []);
});
test('real Pi SDK: active writer permits authorized foreground writes and another normal conversation', async t => {
  const f = await fixture(t); await f.session.prompt('DELEGATE'); await eventually(() => f.calls, calls => calls.some(c => c.worker)); await f.session.prompt('TRY-WRITE');
  assert.equal(await fs.readFile(join(f.root, 'competing.txt'), 'utf8'), 'foreground edit');
  const result = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'write').at(-1)!;
  assert.equal(result.role === 'toolResult' && result.isError, false);
  assert.ok(f.hooks.includes('write'));
  await f.session.prompt('Keep chatting'); assert.equal(f.session.getLastAssistantText(), 'Foreground is responsive.');
});
test('real Pi SDK: capacity-only queue returns immediately and queued cancellation starts no effects', async t => {
  const f = await fixture(t); f.setCapacity(1); const before = performance.now(); await f.session.prompt('DOUBLE');
  assert.ok(performance.now() - before < 1000); assert.equal((await f.records()).length, 2);
  const results = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_dispatch');
  assert.equal(results.length, 2); assert.ok(results.every(r => r.role === 'toolResult' && !r.isError));
  const rows = await eventually(f.records, rows => rows.some(r => r.status === 'running'));
  const queued = rows.find(r => r.status === 'queued')!; assert.ok(queued); assert.equal(queued.turns, 0);
  await f.session.prompt(`/bg cancel ${queued.id}`); assert.equal((await f.records()).find(r => r.id === queued.id)!.status, 'cancelled');
  f.release(); await eventually(f.records, rows => rows.every(r => r.status === 'completed' || r.status === 'cancelled'));
  assert.equal(f.calls.filter(c => c.worker).length, 1);
});
test('real Pi SDK: two actual direct writers overlap foreground Python lookup, memory query and same-file write without bypassing hooks', async t => {
  const f = await fixture(t); f.setBehavior('direct_write', true);
  await f.session.prompt('DELEGATE first');
  await eventually(() => f.calls, calls => calls.some(c => c.worker && c.lastRole === 'toolResult'));
  await f.session.prompt('DELEGATE second');
  await eventually(() => f.calls, calls => calls.filter(c => c.worker && c.lastRole === 'toolResult').length === 2);
  assert.equal((await f.records()).filter(r => r.status === 'running').length, 2);
  assert.match(await fs.readFile(join(f.root, 'competing.txt'), 'utf8'), /worker edit/);
  for (const prompt of ['LOCAL-LOOKUP', 'MEMORY-LOOKUP', 'TRY-WRITE']) await f.session.prompt(prompt);
  for (const name of ['bash', 'memoria_search', 'write']) {
    const result = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === name).at(-1)!;
    assert.ok(result.role === 'toolResult' && !result.isError, name); assert.ok(f.hooks.includes(name));
  }
  const lookup = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'bash').at(-1)!;
  assert.match(JSON.stringify(lookup), /Known inherited-tool result/);
  assert.equal(await fs.readFile(join(f.root, 'competing.txt'), 'utf8'), 'foreground edit');
  await f.session.prompt('DENIED-READ'); const denied = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'read').at(-1)!;
  assert.ok(denied.role === 'toolResult' && denied.isError); assert.match(JSON.stringify(denied), /Inherited permission guard/);
  await assert.rejects(fs.stat(join(f.store().root, 'locks')), { code: 'ENOENT' });
  f.release(); await eventually(f.records, rows => rows.every(r => r.status === 'completed'));
  assert.deepEqual(f.errors, []);
});

test('real Pi SDK: active staged snapshots do not block foreground shell/memory/write; stale publication remains explicit', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.root, 'a.txt'), 'base'); f.setBehavior('staged', true);
  f.setParams({ execution: 'staged', stage: { inputs: ['source.txt'], outputs: ['a.txt'] } });
  await f.session.prompt('DELEGATE'); await eventually(() => f.calls, calls => calls.some(c => c.worker && c.transcript.includes('Staged file updated')));
  for (const prompt of ['LOCAL-LOOKUP', 'MEMORY-LOOKUP', 'TRY-WRITE']) await f.session.prompt(prompt);
  for (const name of ['bash', 'memoria_search', 'write']) { const result = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === name).at(-1)!; assert.ok(result.role === 'toolResult' && !result.isError); }
  await fs.writeFile(join(f.root, 'a.txt'), 'concurrent parent edit'); f.release();
  const rows = await eventually(f.records, rows => rows.length === 1 && rows[0]!.status === 'completed' && !!rows[0]!.manifest);
  await f.waitSettled(rows[0]!.id); await f.session.prompt(`PUBLISH ${rows[0]!.id} ${rows[0]!.manifest!.hash}`, { streamingBehavior: 'followUp' }); await f.session.waitForIdle();
  const rejected = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_publish').at(-1)!;
  assert.ok(rejected.role === 'toolResult' && rejected.isError); assert.match(JSON.stringify(rejected), /Stale publication base/);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'concurrent parent edit'); assert.deepEqual(f.errors, []);
});

test('real Pi SDK: automatic long routing accepts work; exactly two minutes stays inline', async t => {
  const f = await fixture(t); f.setParams({ eta_seconds: 120, eta_max_seconds: 120, mode: 'auto' });
  await f.session.prompt('AUTO-LONG'); assert.equal((await f.records()).length, 0); assert.equal(f.calls.some(c => c.worker), false);
  f.setParams({ eta_seconds: 121, eta_max_seconds: 180 }); await f.session.prompt('AUTO-LONG');
  await eventually(() => f.calls, rows => rows.some(c => c.worker)); assert.equal((await f.records()).length, 1);
  assert.match(f.calls.find(c => !c.worker)!.system, /MORE THAN 120/);
});
test('real Pi SDK: manual command obtains realistic ETA then returns, even for short task', async t => {
  const f = await fixture(t); f.setParams({ eta_seconds: 30, eta_max_seconds: 60 });
  await f.session.prompt('/bg Read the source and summarize it.');
  await eventually(() => f.calls, rows => rows.some(c => c.worker));
  assert.equal((await f.records())[0]!.etaSeconds, 30);
  const mainCall = f.calls.find(c => !c.worker)!;
  assert.match(mainCall.system, /Acknowledge the work naturally with an honest estimated duration/);
  assert.match(mainCall.system, /Keep task IDs internal unless genuinely necessary for clarity or troubleshooting, or explicitly requested/);
  assert.match(mainCall.system, /fixed catchphrases, and vary the wording naturally/);
  const request = f.session.messages.find(m => m.role === 'user');
  assert.ok(request && request.role === 'user');
  const requestText = typeof request.content === 'string' ? request.content : JSON.stringify(request.content);
  assert.match(requestText, /Acknowledge the work naturally with an honest estimated duration, explicitly as an estimate/);
  assert.match(requestText, /Keep task IDs internal unless genuinely necessary for clarity or troubleshooting, or explicitly requested/);
  assert.match(requestText, /fixed catchphrases, and vary the wording naturally/);
  assert.doesNotMatch(requestText, /Acknowledge the accepted ID/);
  assert.equal(f.session.isStreaming, false);
});
test('real Pi SDK: read-only worker cannot use shell or mutating tools', async t => {
  const f = await fixture(t); f.setParams({ access: 'read' }); await f.session.prompt('DELEGATE');
  await eventually(() => f.calls, rows => rows.some(c => c.worker));
  const child = f.calls.find(c => c.worker)!;
  assert.ok(child.tools.includes('read')); assert.ok(!child.tools.includes('bash')); assert.ok(!child.tools.includes('write')); assert.ok(!child.tools.includes('slow_fixture'));
});
test('real Pi SDK: nested tools cannot bypass background restrictions or start another Telegram owner', async t => {
  const f = await fixture(t); f.setBehavior('nested'); await f.session.prompt('DELEGATE');
  await eventually(f.records, rows => rows.length > 0 && rows[0]!.status === 'completed');
  assert.equal(f.nestedEffects(), 0); assert.equal((await f.records()).length, 1); assert.deepEqual(f.errors, []);
});
test('real Pi SDK: tools enabled at runtime become available on the next worker request', async t => {
  const f = await fixture(t); f.setBehavior('dynamic'); await f.session.prompt('DELEGATE');
  await eventually(f.records, rows => rows.length > 0 && rows[0]!.status === 'completed');
  assert.ok(f.calls.filter(c => c.worker)[1]!.tools.includes('new_fixture_tool')); assert.ok(f.hooks.includes('new_fixture_tool'));
  assert.deepEqual(f.errors, []);
});
test('real Pi SDK: active worker stays on dispatch snapshot when main model/thinking changes', async t => {
  const f = await fixture(t); await f.session.prompt('DELEGATE');
  await eventually(() => f.calls, rows => rows.some(c => c.worker));
  await f.session.setModel({ ...f.model, id: 'second' }); f.session.setThinkingLevel('off');
  await f.session.prompt('Use the new model now.');
  assert.equal(f.calls.filter(c => !c.worker).at(-1)!.model, 'second');
  assert.equal(f.calls.filter(c => !c.worker).at(-1)!.reasoning, undefined);
  f.release(); await eventually(f.records, rows => rows[0]!.status === 'completed');
  const worker = f.calls.find(c => c.worker)!; assert.equal(worker.model, 'main'); assert.equal(worker.reasoning, 'high');
});
test('real Pi SDK: worker usage is returned only once, result pages never expose reasoning', async t => {
  const f = await fixture(t); f.setBehavior('read'); await f.session.prompt('DELEGATE');
  await eventually(f.records, rows => rows.length > 0 && rows[0]!.status === 'completed' && rows[0]!.notification === 'read');
  const id = (await f.records())[0]!.id;
  await f.waitSettled(id);
  await f.session.prompt(`RESULT ${id}`, { streamingBehavior: 'followUp' }); await f.session.waitForIdle();
  await f.session.prompt(`RESULT ${id}`, { streamingBehavior: 'followUp' }); await f.session.waitForIdle();
  const results = await eventually(() => f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_tasks'), rows => rows.some(m => m.role === 'toolResult' && m.usage));
  const usages = results.filter(m => m.role === 'toolResult' && m.usage);
  assert.equal(usages.length, 1); assert.equal(usages[0]!.role === 'toolResult' && usages[0]!.usage!.totalTokens, 60);
  for (const m of results) assert.doesNotMatch(JSON.stringify(m), /PRIVATE_REASONING/);
});
for (const behavior of ['error', 'length'] as const) test(`real Pi SDK: ${behavior} response is failure, not successful completion`, async t => {
  const f = await fixture(t); f.setBehavior(behavior); await f.session.prompt('DELEGATE');
  await eventually(f.records, rows => rows.length > 0 && rows[0]!.status === 'failed');
  const id = (await f.records())[0]!.id;
  assert.doesNotMatch(await fs.readFile(f.store().path(id, 'json'), 'utf8'), /SECRET_NOT_FOR_LOGS/);
});
test('real Pi SDK: print mode refuses false background promises', async t => {
  const f = await fixture(t, 'print'); await f.session.prompt('DELEGATE');
  assert.equal(f.calls.some(c => c.worker), false); assert.equal((await f.records()).length, 0);
  const result = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_dispatch').at(-1)!;
  assert.equal(result.role === 'toolResult' && result.isError, true);
});
test('real Pi SDK: shutdown cancels an inherited tool and leaves recoverable state, without a late foreground continuation', async t => {
  const f = await fixture(t); f.setBehavior('slow'); await f.session.prompt('DELEGATE'); await eventually(f.slowState, s => s.slowStarted);
  const before = f.calls.filter(c => !c.worker).length;
  await f.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
  assert.equal(f.slowState().slowAborted, true);
  await eventually(f.records, rows => rows[0]!.status === 'cancelled');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.calls.filter(c => !c.worker).length, before); assert.deepEqual(f.errors, []);
});

test('real Pi SDK: standalone workers interleave with foreground work and emit task-scoped private metadata', async t => {
  const f = await fixture(t, 'rpc', undefined, true);
  const originalFetch = globalThis.fetch; let network = 0;
  globalThis.fetch = (() => { network++; throw new Error('Live network forbidden in SDK fixture'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  f.setParams({ access: 'read' }); f.setBehavior('read', true);
  await f.session.prompt('DELEGATE one'); await f.session.prompt('DELEGATE two');
  await eventually(() => f.calls, calls => calls.filter(c => c.worker && c.lastRole === 'toolResult').length >= 2);
  assert.equal((await f.records()).length, 2);
  await f.session.prompt('FOREGROUND-READ while workers run');
  const foreground = f.calls.filter(call => !call.worker).at(-1)!;
  assert.equal(foreground.lastRole, 'toolResult');
  const modelEventsBefore = f.metadata.filter(event => event.type === 'model-start').length;
  await f.session.prompt('Foreground question while workers are blocked');
  assert.equal(f.metadata.filter(event => event.type === 'model-start').length, modelEventsBefore, 'foreground inference is not worker metadata');
  f.release(); const settled = await eventually(f.records, rows => rows.every(row => row.status === 'completed'));
  await Promise.all(settled.map(row => f.waitSettled(row.id)));
  for (const record of settled) {
    const events = f.metadata.filter(event => event.taskId === record.id);
    assert.equal(events.filter(event => event.type === 'worker-start').length, 1);
    assert.equal(events.filter(event => event.type === 'worker-end').length, 1);
    assert.equal(events.filter(event => event.type === 'model-start').length, 2);
    assert.equal(events.filter(event => event.type === 'model-end').reduce((sum, event) => sum + (event.usage?.totalTokens ?? 0), 0), 60);
    assert.ok(events.every(event => event.rootCallId));
  }
  assert.equal(new Set(f.metadata.filter(event => event.type === 'model-start').map(event => event.requestId)).size, 4);
  assert.doesNotMatch(JSON.stringify(f.metadata), /PRIVATE_REASONING|SDK_TELEMETRY_PRIVATE|Known inherited-tool result|Do the delegated fixture/);
  assert.equal(network, 0); assert.deepEqual(f.errors, []);
});

test('real Pi SDK: nested tool usage is separate worker aggregate telemetry and not duplicated by foreground retrieval', async t => {
  const f = await fixture(t, 'rpc', undefined, true); f.setBehavior('nested');
  await f.session.prompt('DELEGATE'); await eventually(f.records, rows => rows.length > 0 && rows[0]!.status === 'completed');
  const record = (await f.records())[0]!; assert.equal(record.usage.totalTokens, 71); await f.waitSettled(record.id);
  await f.session.prompt(`RESULT ${record.id}`, { streamingBehavior: 'followUp' }); await f.session.waitForIdle(); await f.session.prompt(`RESULT ${record.id}`, { streamingBehavior: 'followUp' }); await f.session.waitForIdle();
  const results = await eventually(() => f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_tasks' && m.usage), rows => rows.length === 1);
  assert.equal(results.length, 1); assert.ok(results[0]!.role === 'toolResult'); assert.equal(results[0]!.usage!.totalTokens, 71);
  const events = f.metadata.filter(event => event.taskId === record.id);
  assert.equal(events.filter(event => event.type === 'model-end').reduce((sum, event) => sum + (event.usage?.totalTokens ?? 0), 0), 60);
  const aggregates = events.filter(event => event.type === 'tool-usage');
  assert.equal(aggregates.length, 1); assert.equal(aggregates[0]!.usage!.totalTokens, 11);
  assert.equal(aggregates[0]!.usage!.output, 7);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REASONING|SDK_TELEMETRY_PRIVATE/);
  assert.deepEqual(f.errors, []);
});

test('real Pi SDK: inspection, foreground writes and second direct writers stay available under an importer', async t => {
  const f = await fixture(t, 'rpc', undefined, true);
  await f.session.prompt('DELEGATE'); await eventually(() => f.calls, calls => calls.some(c => c.worker));
  await f.session.prompt('INSPECT unrelated source');
  const result = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_fs_inspect').at(-1)!;
  assert.ok(result.role === 'toolResult' && !result.isError);
  assert.match(JSON.stringify(result), /Known inherited-tool result/);
  assert.ok(f.hooks.includes('background_fs_inspect'), 'inspection still runs through the host permission hook');
  await f.session.prompt('TRY-WRITE'); assert.equal(await fs.readFile(join(f.root, 'competing.txt'), 'utf8'), 'foreground edit');
  await f.session.prompt('DELEGATE second writer'); assert.equal((await f.records()).length, 2);
  const accepted = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_dispatch').at(-1)!;
  assert.ok(accepted.role === 'toolResult' && !accepted.isError);
  await eventually(f.records, rows => rows.length === 2 && rows.every(r => r.status === 'running'));
  await eventually(() => f.calls, calls => calls.filter(c => c.worker).length === 2);
  assert.deepEqual(f.errors, []);
});

test('actual Pi SDK: two staged file writers, foreground cached/uncached HTTPS lookup and retrieval, disjoint writes and reviewed publication', async t => {
  const f = await fixture(t, 'rpc', undefined, true); const network = await offlineWeb(t, f.root, f.agentDir);
  await fs.writeFile(join(f.root, 'a.txt'), 'base a'); await fs.writeFile(join(f.root, 'b.txt'), 'base b');
  f.setBehavior('staged', true); f.setParams({ execution: 'staged', stage: { inputs: ['source.txt'], outputs: ['a.txt'], immutable_refs: [join(f.agentDir, 'skills', 'inherited-skill', 'SKILL.md')] } });
  await f.session.prompt('DELEGATE staged a');
  await eventually(() => f.calls, calls => calls.some(c => c.worker && c.lastRole === 'toolResult' && c.transcript.includes('Staged file updated')));
  f.setParams({ stage: { inputs: ['source.txt'], outputs: ['b.txt'] } }); await f.session.prompt('DELEGATE staged b');
  await eventually(() => f.calls, calls => calls.filter(c => c.worker && c.lastRole === 'toolResult' && c.transcript.includes('Staged file updated')).length >= 2);
  const active = await f.records(); assert.equal(active.filter(r => r.status === 'running' && r.execution === 'staged').length, 2);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'base a'); assert.equal(await fs.readFile(join(f.root, 'b.txt'), 'utf8'), 'base b');
  for (const worker of f.calls.filter(c => c.worker)) { assert.ok(!worker.tools.includes('bash')); assert.ok(!worker.tools.includes('slow_fixture')); assert.ok(!worker.tools.includes('background_publish')); }
  for (const query of ['cached', 'cached', 'uncached']) await f.session.prompt(`SAFE-WEB ${query}`);
  assert.equal(network.requests(), 2);
  const lookup = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_web_search').at(-1)!;
  assert.ok(lookup.role === 'toolResult' && !lookup.isError); const text = lookup.content[0]!; assert.ok(text.type === 'text'); const result = JSON.parse(text.text);
  await f.session.prompt(`SAFE-RESULT ${result.responseId}`); const retrieved = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_web_result').at(-1)!;
  assert.ok(retrieved.role === 'toolResult' && !retrieved.isError); assert.match(JSON.stringify(retrieved), /SDK source-linked/);
  assert.ok(f.hooks.includes('background_stage_file')); assert.ok(f.hooks.includes('background_web_search')); assert.ok(f.hooks.includes('background_web_result'));
  await f.session.prompt('TRY-WRITE unrelated parent file'); assert.equal(await fs.readFile(join(f.root, 'competing.txt'), 'utf8'), 'foreground edit', 'parent writes remain subject to normal hooks and are allowed');
  f.release(); const done = await eventually(f.records, rows => rows.length === 2 && rows.every(r => r.status === 'completed' && r.manifest));
  for (const record of done) { await f.waitSettled(record.id); assert.equal(record.publication, 'ready'); assert.equal(record.manifest!.outputs.length, 1); await f.session.prompt(`PUBLISH ${record.id} ${record.manifest!.hash}`, { streamingBehavior: 'followUp' }); await f.session.waitForIdle(); }
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'Staged result for a.txt'); assert.equal(await fs.readFile(join(f.root, 'b.txt'), 'utf8'), 'Staged result for b.txt');
  assert.equal((await fs.stat(join(f.root, 'a.txt'))).mode & 0o777, 0o644);
  for (const record of done) {
    assert.equal(record.turns, 3);
    assert.equal(f.metadata.filter(event => event.taskId === record.id && event.type === 'model-start').length, 3);
  }
  assert.doesNotMatch(JSON.stringify(f.metadata), /SDK_SYNTHETIC_WEB_CREDENTIAL|PRIVATE_REASONING|Known inherited-tool result/); assert.deepEqual(f.errors, []);
});

test('actual Pi SDK: capacity-queued work later starts on its captured model; queue time is not execution ETA', async t => {
  const f = await fixture(t, 'rpc', undefined, true); f.setCapacity(1); await f.session.prompt('DOUBLE');
  const waiting = await eventually(f.records, rows => rows.length === 2 && rows.some(r => r.status === 'running') && rows.some(r => r.status === 'queued'));
  const queued = waiting.find(r => r.status === 'queued')!; assert.equal(queued.turns, 0); assert.equal(queued.queueWaitMs, undefined);
  await f.session.setModel({ ...f.model, id: 'second' }); f.session.setThinkingLevel('off'); f.release();
  const done = await eventually(f.records, rows => rows.every(r => r.status === 'completed'));
  assert.equal(done.find(r => r.id === queued.id)!.model, 'main'); assert.ok(done.find(r => r.id === queued.id)!.queueWaitMs! > 0);
  assert.equal(f.calls.filter(c => c.worker).length, 2); assert.ok(f.calls.filter(c => c.worker).every(c => c.model === 'main')); assert.deepEqual(f.errors, []);
});

test('actual Pi SDK: real safe HTTPS lookup and retrieval also stay available during direct importer work', async t => {
  const f = await fixture(t, 'rpc', undefined, true); const network = await offlineWeb(t, f.root, f.agentDir);
  await f.session.prompt('DELEGATE'); await eventually(() => f.calls, calls => calls.some(c => c.worker));
  await f.session.prompt('SAFE-WEB importer fixture'); await f.session.prompt('SAFE-WEB importer fixture'); assert.equal(network.requests(), 1);
  const result = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_web_search').at(-1)!; assert.ok(result.role === 'toolResult' && !result.isError); const content = result.content[0]!; assert.ok(content.type === 'text');
  await f.session.prompt(`SAFE-RESULT ${JSON.parse(content.text).responseId}`); assert.ok(f.hooks.includes('background_web_result'));
  const retrieved = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_web_result').at(-1)!; assert.ok(retrieved.role === 'toolResult' && !retrieved.isError);
  assert.equal((await f.records())[0]!.status, 'running'); assert.deepEqual(f.errors, []);
});

test('actual Pi SDK: queued permission revalidation can deny later execution, without worker calls or replay', async t => {
  const f = await fixture(t, 'rpc', undefined, true); f.setCapacity(1); await f.session.prompt('DOUBLE');
  await eventually(f.records, rows => rows.length === 2 && rows.some(r => r.status === 'running'));
  f.denyStart(); f.release(); const rows = await eventually(f.records, rows => rows.every(r => r.status === 'completed' || r.status === 'failed'));
  const denied = rows.find(r => r.status === 'failed')!; assert.ok(denied); assert.equal(denied.turns, 0); assert.equal(denied.usage.totalTokens, 0);
  assert.equal(f.calls.filter(c => c.worker).length, 1); assert.deepEqual(f.errors, []);
});

test('actual Pi SDK: bounded queue rejects overflow clearly and accepts capacity conflicts immediately', async t => {
  const f = await fixture(t); f.setCapacity(1); await f.session.prompt('DELEGATE active'); await eventually(() => f.calls, calls => calls.some(c => c.worker));
  for (let i = 0; i < 32; i++) await f.session.prompt(`DELEGATE queued ${i}`);
  const rows = await f.records(); assert.equal(rows.length, 33); assert.equal(rows.filter(r => r.status === 'queued').length, 32); assert.equal(f.calls.filter(c => c.worker).length, 1);
  const start = performance.now(); await f.session.prompt('DELEGATE overflow'); assert.ok(performance.now() - start < 1000);
  const rejected = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_dispatch').at(-1)!; assert.ok(rejected.role === 'toolResult' && rejected.isError); assert.match(JSON.stringify(rejected), /queue is full/); assert.equal((await f.records()).length, 33);
  for (const row of rows.filter(r => r.status === 'queued')) await f.session.prompt(`/bg cancel ${row.id}`);
  assert.equal(f.calls.filter(c => c.worker).length, 1); assert.ok((await f.records()).filter(r => r.status === 'cancelled').every(r => r.turns === 0)); assert.deepEqual(f.errors, []);
});

test('actual Pi SDK: the staged broker refuses escaping builtin arguments and cannot publish an unrelated change', async t => {
  const f = await fixture(t, 'rpc', undefined, true); await fs.writeFile(join(f.root, 'a.txt'), 'base');
  f.setBehavior('stage_escape', false); f.setParams({ execution: 'staged', stage: { inputs: [], outputs: ['a.txt'] } }); await f.session.prompt('DELEGATE');
  const rows = await eventually(f.records, rows => rows.length === 1 && rows[0]!.status === 'completed' && !!rows[0]!.manifest);
  assert.equal(rows[0]!.manifest!.outputs.length, 0); assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'base');
  await assert.rejects(fs.stat(join(f.root, '..', 'staged-escape.txt')), { code: 'ENOENT' });
  assert.ok(f.hooks.includes('background_stage_file')); assert.match(f.calls.filter(c => c.worker).at(-1)!.transcript, /explicit relative regular-file paths/);
  await f.waitSettled(rows[0]!.id); await f.session.waitForIdle(); await f.session.prompt(`PUBLISH ${rows[0]!.id} ${rows[0]!.manifest!.hash}`, { streamingBehavior: 'followUp' }); await f.session.waitForIdle();
  const rejected = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_publish').at(-1)!; assert.ok(rejected.role === 'toolResult' && rejected.isError); assert.deepEqual(f.errors, []);
});

test('actual Pi SDK: expensive builtin subprocess calls share one admission lane through the real nested host pipeline', async t => {
  const f = await fixture(t, 'rpc', undefined, true);
  await fs.writeFile(join(f.root, 'shell-test.mjs'), `import {appendFileSync} from 'node:fs'; const [path,id]=process.argv.slice(2); appendFileSync(path,JSON.stringify({event:'start',id})+'\\n'); await new Promise(r=>setTimeout(r,100)); appendFileSync(path,JSON.stringify({event:'end',id})+'\\n');`);
  f.setBehavior('shell_pair', false); await f.session.prompt('DELEGATE'); await eventually(f.records, rows => rows.length === 1 && rows[0]!.status === 'completed');
  const events = (await fs.readFile(join(f.root, 'shell-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.deepEqual(events.map(e => e.event), ['start', 'end', 'start', 'end']);
  assert.equal((await f.records())[0]!.toolCalls, 2); assert.ok(f.hooks.includes('bash')); assert.deepEqual(f.errors, []);
});

test('actual Pi SDK: mutable parent start-hook arguments cannot alter the captured staged contract', async t => {
  const f = await fixture(t, 'rpc', undefined, true); await fs.writeFile(join(f.root, 'a.txt'), 'base');
  f.setParams({ execution: 'staged', stage: { inputs: [], outputs: ['a.txt'] } }); f.mutateStart(); await f.session.prompt('DELEGATE');
  const rows = await eventually(f.records, rows => rows.length === 1 && rows[0]!.status === 'failed');
  assert.equal(rows[0]!.turns, 0); assert.equal(f.calls.some(c => c.worker), false); assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'base');
  await assert.rejects(fs.stat(join(f.store().recordsDir, `${rows[0]!.id}.stage`)), { code: 'ENOENT' }); await assert.rejects(fs.stat(join(f.root, 'injected.txt')), { code: 'ENOENT' }); assert.deepEqual(f.errors, []);
});

test('actual Pi SDK: public foreground compaction boundaries defer NEW worker model admission without blocking the main chat', async t => {
  const f = await fixture(t); f.setParams({ access: 'read' }); f.setBehavior('plain', false);
  await f.session.extensionRunner.emit({ type: 'session_before_compact' } as never);
  await f.session.prompt('DELEGATE while foreground compaction is active');
  await eventually(f.records, rows => rows.length === 1 && rows[0]!.status === 'running');
  await new Promise(r => setTimeout(r, 30)); assert.equal(f.calls.filter(c => c.worker).length, 0);
  await f.session.prompt('An unrelated foreground question remains responsive.'); assert.match(f.session.getLastAssistantText()!, /responsive/);
  await f.session.extensionRunner.emit({ type: 'session_compact_failed' } as never);
  const rows = await eventually(f.records, rows => rows.length === 1 && rows[0]!.status === 'completed'); await f.waitSettled(rows[0]!.id);
  assert.equal(f.calls.filter(c => c.worker).length, 1); assert.deepEqual(f.errors, []);
});
