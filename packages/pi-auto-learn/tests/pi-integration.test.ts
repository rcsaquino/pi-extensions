import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import type { AssistantMessage, Model, Api, SimpleStreamOptions } from '@earendil-works/pi-ai';
import autoLearn from '../src/index.ts';
import { fixture, markdown } from './helpers.ts';
import { atomicWrite, exists, tree, treeHash } from '../src/filesystem.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

interface Call { model: string; reasoning?: string; budgets?: unknown; learning: boolean; tools: number; text: string; system: string }
async function sdkFixture(t: Parameters<typeof fixture>[0], virtual = false, mode: 'rpc' | 'print' = 'print') {
  const f = await fixture(t, false);
  const previous = process.env.PI_CODING_AGENT_DIR; const offline = process.env.PI_OFFLINE;
  const agentDir = join(f.base, 'agent'); process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
  const calls: Call[] = [];
  const errors: string[] = [];
  const provider = virtual ? 'auto-learn-router-test' : 'auto-learn-provider-test';
  const physical: Model<Api> = { id: 'strong', name: 'Strong fake', provider, api: 'auto-learn-fake-api', baseUrl: 'http://127.0.0.1', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 65_536 };
  let behavior: 'create' | 'noop' = 'create';
  const providerExtension = (pi: ExtensionAPI) => {
    pi.registerProvider(provider, {
      baseUrl: 'http://127.0.0.1', apiKey: 'fake-local-test-credential', api: physical.api,
      models: [{ ...physical }, { ...physical, id: 'cheap', name: 'Cheap fake' }],
      streamSimple: (model, context, options: SimpleStreamOptions | undefined) => {
        const stream = createAssistantMessageEventStream();
        const learning = options?.sessionId?.startsWith('auto-learn-') ?? false;
        const system = getCurrentSystemPrompt(context.messages);
        const last = context.messages.filter(m => m.role === 'user').at(-1);
        const text = last?.role === 'user' ? (typeof last.content === 'string' ? last.content : last.content.filter(c => c.type === 'text').map(c => c.text).join('')) : '';
        calls.push({ model: model.id, reasoning: options?.reasoning, budgets: options?.thinkingBudgets, learning, tools: getCurrentTools(context.messages).length, text, system });
        let result = 'Completed this workflow and verified the result.';
        if (learning) {
          if (system.includes('fresh review inference')) result = JSON.stringify({ protocolVersion: 1, verdict: 'approve', reason: 'Explicit reusable workflow with valid scoped instructions.' });
          else {
            const input = JSON.parse(text);
            result = behavior === 'noop' ? JSON.stringify({ protocolVersion: 1, decision: 'noop', evidenceIds: [], changes: [] }) : JSON.stringify({ protocolVersion: 1, decision: 'change', evidenceIds: input.evidence.map((e: { id: string }) => e.id), changes: [{ operation: 'create', skillId: 'release-checklist', baseHash: null, workflow: 'release checklist verification', reason: 'User explicitly requested a reusable procedure', files: [{ path: 'SKILL.md', content: markdown('release-checklist') }] }] });
          }
        }
        queueMicrotask(() => {
          const message: AssistantMessage = { role: 'assistant', content: [], provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: 'pending', usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'start', partial: message });
          message.content = [{ type: 'text', text: '' }]; stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          message.content = [{ type: 'text', text: result }]; stream.push({ type: 'text_delta', contentIndex: 0, delta: result, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: result, partial: message });
          message.stopReason = 'stop'; stream.push({ type: 'done', reason: 'stop', message }); stream.end();
        });
        return stream;
      },
    });
    if (virtual) pi.registerVirtualModel({
      provider, id: 'auto', name: 'Router fake', thinkingLevels: ['medium', 'high'],
      route(request, ctx) { return { model: ctx.modelRegistry.find(provider, request.reason === 'direct' ? 'cheap' : 'strong')!, thinkingLevel: request.reason === 'direct' ? 'off' : 'high' }; },
    });
  };
  const settingsManager = SettingsManager.inMemory({ defaultTools: ['read'], defaultProvider: provider, defaultModel: virtual ? 'auto' : 'strong', defaultThinkingLevel: 'medium', thinkingBudgets: { medium: 9000, high: 17000 }, cacheWarming: 'off', retry: { enabled: false }, enableAnalytics: false, enableInstallTelemetry: false });
  const resourceLoader = new DefaultResourceLoader({ cwd: f.base, agentDir, settingsManager, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [providerExtension, autoLearn] });
  await resourceLoader.reload();
  const model = virtual ? { ...physical, id: 'auto', api: 'pi-virtual' } : physical;
  const { session } = await createAgentSession({ cwd: f.base, agentDir, model, thinkingLevel: 'medium', settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(f.base), tools: ['read'] });
  await session.bindExtensions({ mode, onError: e => errors.push(e.error) });
  await atomicWrite(join(f.state, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, hourlyTokens: 1_000_000 }));
  t.after(async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    await fs.rm(f.base, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
  });
  return { ...f, session, calls, errors, setBehavior: (v: typeof behavior) => { behavior = v; } };
}

test('actual Pi SDK loads extension, runs main chat, creates skill in separate same-model calls and exposes status', async t => {
  const f = await sdkFixture(t);
  const outside = treeHash(await tree(f.other));
  await f.session.prompt('Please create a reusable skill for this release checklist workflow.');
  await f.session.prompt('/auto-learn run');
  assert.deepEqual(f.errors, []);
  assert.equal(await exists(join(f.root, 'release-checklist', 'SKILL.md')), true);
  const background = f.calls.filter(c => c.learning);
  assert.equal(f.calls.filter(c => !c.learning).length, 1);
  assert.equal(background.length, 2);
  for (const c of background) { assert.equal(c.model, 'strong'); assert.equal(c.reasoning, 'medium'); assert.deepEqual(c.budgets, { medium: 9000, high: 17000 }); assert.equal(c.tools, 0); }
  assert.equal(f.session.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(treeHash(await tree(f.other)), outside);
  assert.ok(f.session.extensionRunner.getToolDefinition('auto_learn_status'));
  f.setBehavior('noop'); await f.session.prompt('Use this release checklist procedure again and verify the outcome.');
  assert.match(f.calls.filter(c => !c.learning).at(-1)!.system, /release-checklist/);
});
test('actual virtual router dispatches foreground to strong/high and learner bypasses cheap/off direct routing', async t => {
  const f = await sdkFixture(t, true);
  await f.session.prompt('Please create a reusable skill for this release checklist workflow.');
  await f.session.prompt('/auto-learn run');
  assert.deepEqual(f.errors, []);
  assert.equal(await exists(join(f.root, 'release-checklist', 'SKILL.md')), true);
  const background = f.calls.filter(c => c.learning);
  assert.equal(background.length, 2);
  for (const c of background) { assert.equal(c.model, 'strong'); assert.equal(c.reasoning, 'high'); }
});
test('actual RPC-mode settled chat schedules learning without a foreground continuation', async t => {
  const f = await sdkFixture(t, false, 'rpc');
  await atomicWrite(join(f.state, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, debounceMs: 1, hourlyTokens: 1_000_000 }));
  await f.session.prompt('Please create a reusable skill for this release checklist workflow.');
  const deadline = Date.now() + 5000;
  while (!await exists(join(f.root, 'release-checklist', 'SKILL.md')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  assert.equal(await exists(join(f.root, 'release-checklist', 'SKILL.md')), true);
  assert.equal(f.calls.filter(c => c.learning).length, 2);
  assert.equal(f.session.messages.filter(m => m.role === 'assistant').length, 1);
  assert.deepEqual(f.errors, []);
});

test('actual print-mode ordinary chat does not automatically start background inference', async t => {
  const f = await sdkFixture(t);
  await f.session.prompt('Please remember this workflow for future repeatable releases.');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(f.calls.filter(c => c.learning).length, 0);
  assert.equal(await fs.readFile(join(f.root, 'learning-policy', 'SKILL.md'), 'utf8').then(s => s.includes('Learning policy')), true);
});
