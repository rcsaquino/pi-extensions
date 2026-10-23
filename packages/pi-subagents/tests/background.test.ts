import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSubagentsBackgroundWork, BACKGROUND_WORK_PROVIDER, BACKGROUND_WORK_REGISTRY_KEY } from '../src/background.ts';
import { SubagentsManager } from '../src/manager.ts';
import { cleanup, scratch } from './helpers.ts';

test('background provider is synchronous, session-scoped, and replacement-safe', async t => {
  const key = Symbol.for(BACKGROUND_WORK_REGISTRY_KEY);
  const holder = globalThis as unknown as Record<symbol, unknown>;
  delete holder[key];
  t.after(() => { delete holder[key]; });
  const calls: string[] = [];
  const first = registerSubagentsBackgroundWork(sessionId => {
    calls.push(sessionId);
    return [{ id: 'run-a', sessionId }];
  });
  const registry = holder[key] as { version: number; providers: Map<string, unknown> };
  assert.equal(registry.version, 1);
  const provider = registry.providers.get(BACKGROUND_WORK_PROVIDER) as {
    name: string; listActiveWork(context: { sessionId?: unknown }): unknown;
  };
  assert.deepEqual(Object.keys(provider).sort(), ['listActiveWork', 'name']);
  const result = provider.listActiveWork({ sessionId: 'session-a' });
  assert.equal(typeof (result as { then?: unknown }).then, 'undefined', 'provider results must not be promises');
  assert.deepEqual(result, [{ id: 'run-a', sessionId: 'session-a' }]);
  assert.deepEqual(provider.listActiveWork({ sessionId: 'other' }), [{ id: 'run-a', sessionId: 'other' }]);

  const second = registerSubagentsBackgroundWork(() => []);
  first();
  assert.equal(registry.providers.get(BACKGROUND_WORK_PROVIDER) !== undefined, true, 'an old disposer cannot remove a replacement');
  second();
  assert.equal(registry.providers.has(BACKGROUND_WORK_PROVIDER), false);
  assert.deepEqual(calls, ['session-a', 'other']);
});

test('manager activeWork reports only running runs for the requested session', async t => {
  const root = await scratch('sub-bg-manager-');
  t.after(() => cleanup(root));
  const runs = join(root, 'worker', 'runs');
  const write = async (id: string, sessionId: string, status: string, sessionFile = '/tmp/session-a.jsonl') => {
    const dir = join(runs, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'task.json'), JSON.stringify({
      schemaVersion: 1, id, agent: 'worker', title: 't', cwd: root,
      sessionId, sessionFile, status, createdAt: '2026-10-21T00:00:00.000Z',
      provider: 'p', model: 'm', thinking: 'medium', timeoutSeconds: 60, maxTurns: 10,
      steerCount: 0, deniedDialogs: 0,
    }));
  };
  await write('run-a', 'session-a', 'running');
  await write('run-b', 'session-a', 'done');
  await write('run-c', 'session-b', 'running');
  await write('run-d', 'session-d', 'running', '/tmp/session-file-a.jsonl');
  const manager = new SubagentsManager({ getFlag: () => '4' } as unknown as ExtensionAPI, root);
  assert.deepEqual(manager.activeWork('session-a'), [{ id: 'run-a', sessionId: 'session-a' }]);
  assert.deepEqual(manager.activeWork('/tmp/session-file-a.jsonl'), [{ id: 'run-d', sessionId: 'session-d' }]);
  assert.deepEqual(manager.activeWork('session-b'), [{ id: 'run-c', sessionId: 'session-b' }]);
  assert.deepEqual(manager.activeWork('missing'), []);
});

test('activeWork fails closed on unreadable or malformed run state', async (t) => {
  const badRoot = join(await scratch('sub-bg-bad-'), 'root-file');
  await writeFile(badRoot, 'not a directory');
  t.after(() => cleanup(join(badRoot, '..')));
  const unreadable = new SubagentsManager({ getFlag: () => '4' } as unknown as ExtensionAPI, badRoot);
  assert.throws(() => unreadable.activeWork('session-a'), /Cannot inspect subagent run state safely/);

  const root = await scratch('sub-bg-malformed-');
  t.after(() => cleanup(root));
  const dir = join(root, 'worker', 'runs', 'run-bad');
  await mkdir(dir, { recursive: true });
  const manager = new SubagentsManager({ getFlag: () => '4' } as unknown as ExtensionAPI, root);
  await mkdir(join(dir, 'task.json'));
  assert.throws(() => manager.activeWork('session-a'), /unreadable; refusing to report idle/);
  await rm(join(dir, 'task.json'), { recursive: true, force: true });
  await writeFile(join(dir, 'task.json'), '{"schemaVersion":1,');
  assert.throws(() => manager.activeWork('session-a'), /unreadable; refusing to report idle/);
  await writeFile(join(dir, 'task.json'), JSON.stringify({ schemaVersion: 99, id: 'run-bad', sessionId: 'session-a', status: 'running' }));
  assert.throws(() => manager.activeWork('session-a'), /unsupported or malformed; refusing to report idle/);
});

test('manager releases per-run bookkeeping when a directory vanishes or it shuts down', async (t) => {
  const root = await scratch('sub-bg-state-');
  t.after(() => cleanup(root));
  const dir = join(root, 'worker', 'runs', 'run-a');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'task.json'), JSON.stringify({
    schemaVersion: 1, id: 'run-a', agent: 'worker', title: 't', cwd: root,
    sessionId: 'session-a', sessionFile: '/tmp/session-a.jsonl', status: 'running',
    createdAt: '2026-10-21T00:00:00.000Z', provider: 'p', model: 'm', thinking: 'medium',
    timeoutSeconds: 60, maxTurns: 10, steerCount: 0, deniedDialogs: 0,
  }));
  const manager = new SubagentsManager({ getFlag: () => '4' } as unknown as ExtensionAPI, root);
  const internal = manager as unknown as {
    dirs: Map<string, string>; notified: Set<string>; exitSeen: Map<string, number>; chains: Map<string, Promise<unknown>>;
    rememberDirs(): void; forget(id: string): void;
  };
  internal.rememberDirs();
  assert.equal(internal.dirs.get('run-a'), dir);
  internal.notified.add('run-a');
  internal.exitSeen.set('run-a', 10);
  internal.chains.set('run-a', Promise.resolve());
  await rm(dir, { recursive: true, force: true });
  internal.rememberDirs();
  assert.equal(internal.dirs.has('run-a'), false);
  internal.forget('run-a');
  assert.equal(internal.notified.size + internal.exitSeen.size + internal.chains.size, 0);
  internal.dirs.set('kept', dir);
  internal.notified.add('kept');
  await manager.shutdown();
  assert.equal(internal.dirs.size + internal.notified.size + internal.exitSeen.size + internal.chains.size, 0);
});
