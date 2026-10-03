import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
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
async function fixture(t: TestContext, mode: ExtensionContext['mode'] = 'rpc', forcedPrompt?: string) {
  const root = await scratch('bg-sdk-test-');
  const agentDir = join(root, 'agent'); await fs.mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR, offline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
  const provider = 'background-offline-fixture';
  const model: Model<Api> = { id: 'main', name: 'Main offline fixture', provider, api: 'background-fake-api', baseUrl: 'http://127.0.0.1', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32000 };
  const calls: Call[] = [], errors: string[] = [], hooks: string[] = [];
  const file = join(root, 'source.txt'); await fs.writeFile(file, 'Known inherited-tool result');
  await fs.mkdir(join(agentDir, 'skills', 'inherited-skill'), { recursive: true });
  await fs.writeFile(join(agentDir, 'skills', 'inherited-skill', 'SKILL.md'), '---\nname: inherited-skill\ndescription: Special inherited fixture skill.\n---\nUse this skill for the fixture.\n');
  let gate = deferred(), blocked = true;
  let behavior: 'plain' | 'read' | 'slow' | 'nested' | 'dynamic' | 'error' | 'length' = 'plain';
  let nestedEffects = 0;
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
    pi.registerProvider(provider, {
      baseUrl: model.baseUrl, apiKey: 'inert-offline-fixture-key', api: model.api, models: [{ ...model }, { ...model, id: 'second', name: 'Second fixture' }],
      streamSimple(m, context, options: SimpleStreamOptions | undefined) {
        const stream = createAssistantMessageEventStream();
        const worker = options?.sessionId?.startsWith('background-') ?? false;
        const last = context.messages.filter(message => message.role !== 'system').at(-1)!;
        const text = textOf(context);
        calls.push({ worker, model: m.id, reasoning: options?.reasoning, budgets: options?.thinkingBudgets, system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(t => t.name), text, lastRole: last.role, transcript: JSON.stringify(context.messages) });
        const produce = async () => {
          let content: AssistantMessage['content']; let stop: AssistantMessage['stopReason'] | undefined;
          if (worker) {
            if (blocked && (behavior === 'plain' || behavior === 'error' || behavior === 'length')) await gate.promise;
            if (last.role === 'user' && behavior === 'read') content = [toolCall('read', { path: file })];
            else if (last.role === 'user' && behavior === 'slow') content = [toolCall('slow_fixture', {})];
            else if (last.role === 'user' && behavior === 'nested') content = [toolCall('nested_fixture', {})];
            else if (last.role === 'user' && behavior === 'dynamic') content = [toolCall('enable_fixture', {})];
            else if (last.role === 'toolResult' && last.toolName === 'enable_fixture') content = [toolCall('new_fixture_tool', {})];
            else {
              content = [{ type: 'thinking', thinking: 'FIXTURE_PRIVATE_REASONING_NEVER_EXPORT' }, { type: 'text', text: behavior === 'error' ? 'Partial result' : 'Verified delegated result.' }];
              stop = behavior === 'error' ? 'error' : behavior === 'length' ? 'length' : 'stop';
            }
          } else if (last.role === 'toolResult') content = [{ type: 'text', text: 'Foreground acknowledgment.' }];
          else if (text.startsWith('DELEGATE') || text.startsWith('Manual background delegation')) content = [toolCall('background_dispatch', { ...p })];
          else if (text.startsWith('AUTO-LONG')) content = [toolCall('background_dispatch', { ...p, mode: 'auto' })];
          else if (text.startsWith('DOUBLE')) content = [toolCall('background_dispatch', { ...p, title: 'One' }, 'first-dispatch'), toolCall('background_dispatch', { ...p, title: 'Two' }, 'second-dispatch')];
          else if (text.startsWith('TRY-WRITE')) content = [toolCall('write', { path: join(root, 'competing.txt'), content: 'must not write' })];
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
        return { content: [{ type: 'text', text: 'All nested prohibitions held.' }], details: undefined };
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
    pi.on('tool_call', event => { hooks.push(event.toolName); if (event.toolName === 'read' && event.input.path === '/denied') return { block: true, reason: 'Inherited permission guard.' }; });
  };
  const settings = SettingsManager.inMemory({ defaultTools: ['read', 'bash', 'edit', 'write'], defaultProvider: provider, defaultModel: model.id, defaultThinkingLevel: 'high', thinkingBudgets: { medium: 1000, high: 9000 }, retry: { enabled: false }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noContextFiles: true, noPromptTemplates: true, noThemes: true, appendSystemPrompt: ['Inherited identity and workspace rules.'], extensionFactories: [fake, extension] });
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
  return { root, session, model, calls, errors, hooks, records, store,
    setParams: (next: Partial<Dispatch>) => { p = { ...p, ...next }; },
    setBehavior: (value: typeof behavior, wait = false) => { behavior = value; blocked = wait; },
    release: () => gate.resolve(),
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
test('real Pi SDK: parent writer guard prevents racing writes but permits another normal conversation', async t => {
  const f = await fixture(t); await f.session.prompt('DELEGATE'); await f.session.prompt('TRY-WRITE');
  await assert.rejects(fs.stat(join(f.root, 'competing.txt')), { code: 'ENOENT' });
  const result = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'write').at(-1)!;
  assert.equal(result.role === 'toolResult' && result.isError, true);
  await f.session.prompt('Keep chatting'); assert.equal(f.session.getLastAssistantText(), 'Foreground is responsive.');
});
test('real Pi SDK: second writer is rejected rather than secretly queued or waiting', async t => {
  const f = await fixture(t); await f.session.prompt('DOUBLE');
  assert.equal((await f.records()).length, 1);
  const results = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_dispatch');
  assert.equal(results.length, 2); assert.equal(results[0]!.role === 'toolResult' && results[0]!.isError, false);
  assert.equal(results[1]!.role === 'toolResult' && results[1]!.isError, true);
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
  await f.session.prompt(`RESULT ${id}`); await f.session.prompt(`RESULT ${id}`);
  const results = f.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'background_tasks');
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
