import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { BackgroundManager } from '../src/manager.ts';
import { Stage } from '../src/staging.ts';
import { hash } from '../src/store.ts';
import { emptyUsage } from '../src/types.ts';
import type { RecordData } from '../src/types.ts';
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { scratch } from './helpers.ts';

// The former resource-race suite tested a deleted cooperative lock. Its replacement
// tests absence of resource admission, not a no-op lease under a different name.
test('independent managers ignore legacy reader/writer/mutex evidence and never acquire or clean up workflow locks', async t => {
  const root = await scratch('unlocked-managers-'); const cwd = join(root, 'workspace'); await fs.mkdir(cwd);
  const state = join(root, 'state'); await fs.mkdir(join(state, 'locks'), { recursive: true, mode: 0o700 });
  const evidence = {
    [`${hash(cwd)}.json`]: JSON.stringify({ pid: process.pid, token: 'synthetic-legacy-token' }),
    'resources.json': JSON.stringify([{ pid: process.pid, resources: [{ path: '/', mode: 'write' }] }]),
    'resources.mutex': 'malformed synthetic legacy evidence',
  };
  for (const [name, data] of Object.entries(evidence)) await fs.writeFile(join(state, 'locks', name), data);
  const tools = ['read', 'write', 'bash', 'memoria_search', 'opaque'].map(name => ({ name, exposure: 'direct', sourceInfo: { path: `builtin:${name}` } }));
  const pi = { getFlag: (name: string) => name === 'background-dir' ? state : undefined, getAllTools: () => tools, events: { emit: () => {} }, appendEntry: () => {}, sendMessage: () => {} } as unknown as ExtensionAPI;
  const context = (session: string) => ({ cwd, mode: 'rpc', hasUI: false, isIdle: () => false, hasPendingMessages: () => false, sessionManager: { getSessionId: () => session, getBranch: () => [] }, ui: { notify: () => {} } }) as unknown as ExtensionContext;
  const a = new BackgroundManager(pi), b = new BackgroundManager(pi); const ca = context('a'), cb = context('b');
  await a.init(ca); await b.init(cb);
  const record = (id: string, sessionId: string): RecordData => ({ version: 1, id, sessionId, title: 'Synthetic writer', cwd, provider: 'fake', model: 'fake', thinking: 'off', status: 'running', access: 'write', execution: 'direct', startedAt: Date.now(), etaSeconds: 300, etaMaxSeconds: 300, estimateReason: 'Synthetic', lastActivityAt: Date.now(), toolCalls: 0, turns: 0, usage: emptyUsage(), usageReported: false, notification: 'read', overrunNotified: false });
  a.jobs.set('bg-aaaaaaaaaaaa', { record: record('bg-aaaaaaaaaaaa', 'a'), rootCallId: 'a', controller: new AbortController() });
  b.jobs.set('bg-bbbbbbbbbbbb', { record: record('bg-bbbbbbbbbbbb', 'b'), rootCallId: 'b', controller: new AbortController() });
  await fs.writeFile(join(cwd, 'input.txt'), 'immutable');
  const stage = new Stage('bg-cccccccccccc', cwd, join(root, 'stage'), { inputs: ['input.txt'], outputs: ['out.txt'] }); await stage.snapshot();
  a.jobs.set(stage.taskId, { record: { ...record(stage.taskId, 'a'), execution: 'staged' }, stage, rootCallId: 'stage', controller: new AbortController() });
  t.after(async () => { await a.shutdown(); await b.shutdown(); await stage.close(); await fs.rm(root, { recursive: true, force: true }); });
  const calls: Promise<unknown>[] = [];
  for (const [manager, ctx, owner] of [[a, ca, 'a'], [b, cb, 'b']] as const) {
    for (const name of ['write', 'memoria_search', 'opaque']) for (const nested of [false, true]) {
      const event = { type: 'tool_call', toolCallId: nested ? `${owner}/${name}` : `foreground-${name}`, ...(nested ? { parentToolCallId: owner } : {}), toolName: name, input: { path: join(cwd, 'same.txt'), content: 'synthetic' } } as ToolCallEvent;
      calls.push(manager.guardAndAdmit(event, ctx).then(denied => assert.equal(denied, undefined)));
    }
  }
  await Promise.all(calls);
  assert.equal('locks' in a, false); assert.equal('toolResources' in a, false);
  assert.equal(a.guard({ type: 'tool_call', toolCallId: 'stage/opaque', parentToolCallId: 'stage', toolName: 'opaque', input: {} } as ToolCallEvent, ca)?.block, true, 'staged permission is still independent');
  await a.cancel('bg-aaaaaaaaaaaa'); assert.equal(b.guard({ type: 'tool_call', toolCallId: 'foreground-write', toolName: 'write', input: { path: 'same.txt' } } as ToolCallEvent, cb), undefined);
  for (const [name, data] of Object.entries(evidence)) assert.equal(await fs.readFile(join(state, 'locks', name), 'utf8'), data, 'old evidence is preserved, not repaired or repurposed');
  assert.deepEqual((await fs.readdir(join(state, 'locks'))).sort(), Object.keys(evidence).sort());
});
