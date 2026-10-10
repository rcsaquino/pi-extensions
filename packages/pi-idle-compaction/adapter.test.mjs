import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_REGISTRY_KEY } from './background.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, tryNative: false });
const { default: install } = await jiti.import('./index.ts');

for (const scenario of ['standalone', 'idle', 'active', 'wrong-session', 'provider-active', 'rpc-error',
  'capacity-used', 'missing-fleet', 'status-error', 'wrong-version', 'no-responder',
  'provider-throws', 'malformed-registry', 'shutdown-during-rpc', 'shutdown-after-ping', 'batch-mode']) {
  test(`adapter integration: ${scenario}`, async t => {
    const sandbox = await mkdtemp(join(root, '.adapter-test-'));
    const standalone = scenario === 'standalone';
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const handlers = new Map(), bus = new Map(), commands = new Map();
    let compacted = 0, rpcRequests = 0, lastNotice = '', shutdownTask;
    const ctx = {
      mode: scenario === 'batch-mode' ? 'print' : 'tui', isIdle: () => true, hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 120_000 }), ui: { notify: message => { lastNotice = message; } },
      sessionManager: {
        getSessionFile: () => '/mock/session.jsonl', getSessionId: () => 'session',
        getLeafId: () => 'message-1',
        getBranch: () => [{ type: 'message', message: { role: 'assistant' } }],
      },
      compact: () => { compacted++; },
    };
    const symbol = Symbol.for(LEGACY_REGISTRY_KEY), previous = globalThis[symbol];
    if (scenario === 'provider-active') globalThis[symbol] = {
      version: 1, providers: new Map([['test', {
        name: 'test', listActiveWork: () => [{ id: 'job', sessionId: '/mock/session.jsonl' }],
      }]]),
    };
    else if (scenario === 'provider-throws') globalThis[symbol] = {
      version: 1, providers: new Map([['broken', {
        name: 'broken', listActiveWork: () => { throw Error('unavailable'); },
      }]]),
    };
    else if (scenario === 'malformed-registry') globalThis[symbol] = { version: 2 };
    else delete globalThis[symbol];
    try {
      install({
        on: (name, fn) => handlers.set(name, fn), registerCommand: (name, value) => commands.set(name, value),
        getAllTools: () => standalone ? [] : [{ name: 'subagents_enable' }],
        events: {
          on: (name, fn) => { bus.set(name, fn); return () => bus.delete(name); },
          emit: (_name, req) => {
            rpcRequests++;
            if (scenario === 'no-responder' || scenario === 'shutdown-during-rpc') return;
            const data = req.method === 'ping'
              ? { session: { sessionFile: scenario === 'wrong-session' ? '/other' : '/mock/session.jsonl' } }
              : scenario === 'missing-fleet' ? {} : {
                isError: scenario === 'status-error',
                fleet: { version: 1, totalActive: scenario === 'active' ? 1 : 0,
                  topLevelAsyncCapacity: { used: scenario === 'capacity-used' ? 1 : 0 } },
              };
            bus.get(`subagents:rpc:v1:reply:${req.requestId}`)?.({
              version: scenario === 'wrong-version' ? 2 : 1,
              requestId: req.requestId, success: scenario !== 'rpc-error', data,
            });
            if (scenario === 'shutdown-after-ping' && req.method === 'ping')
              shutdownTask = handlers.get('session_shutdown')({}, ctx);
          },
        },
      });
      handlers.get('session_start')({}, ctx);
      t.mock.timers.tick(60 * 60 * 1000);
      if (scenario === 'shutdown-during-rpc') await handlers.get('session_shutdown')({}, ctx);
      if (scenario === 'shutdown-after-ping') await shutdownTask;
      if (scenario === 'no-responder') t.mock.timers.tick(5000);
      // Wait for the actual state transition, not an arbitrary number of turns.
      const deadline = process.hrtime.bigint() + 2_000_000_000n;
      while (!['batch-mode', 'shutdown-during-rpc', 'shutdown-after-ping'].includes(scenario)) {
        await commands.get('idle-compact').handler('status', ctx);
        if (/compaction requested|deferred:|skipped:/.test(lastNotice)) break;
        if (process.hrtime.bigint() > deadline) assert.fail(`guard did not settle: ${lastNotice}`);
        await new Promise(setImmediate);
      }
      const shouldCompact = ['standalone', 'idle'].includes(scenario);
      assert.equal(compacted, shouldCompact ? 1 : 0, lastNotice);
      assert.equal(bus.size, 0, 'RPC listeners cleaned up');
      if (standalone) assert.equal(rpcRequests, 0, 'standalone mode never depends on a subagent responder');
      if (scenario === 'shutdown-after-ping') assert.equal(rpcRequests, 1, 'shutdown prevents a new status RPC');
      await handlers.get('session_shutdown')({}, ctx);
    } finally {
      if (previous === undefined) delete globalThis[symbol]; else globalThis[symbol] = previous;
      await rm(sandbox, { recursive: true, force: true });
    }
  });
}
