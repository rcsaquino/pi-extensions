import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKGROUND_WORK_REGISTRY_KEY,
  registerSubagentsBackgroundWork,
} from '../packages/pi-subagents/src/background.ts';
import { createBackgroundGuard } from '../packages/pi-idle-compaction/background.mjs';

const registryKey = Symbol.for(BACKGROUND_WORK_REGISTRY_KEY);
const ctx = {
  sessionManager: {
    getSessionId: () => 'session-a',
    getSessionFile: () => '/tmp/session-a.jsonl',
  },
};
const currentSubagentTools = () => [{ name: 'subagent_dispatch' }, { name: 'subagent_steer' }, { name: 'subagent_tasks' }];

function guard() {
  return createBackgroundGuard({
    getTools: currentSubagentTools,
    rpc: async () => { throw new Error('current subagents must not use the retired RPC'); },
    scope: globalThis,
  });
}

test('current subagents and idle compaction coordinate through the neutral provider', async (t) => {
  delete globalThis[registryKey];
  t.after(() => { delete globalThis[registryKey]; });

  let running = false;
  let caller = '';
  const unregister = registerSubagentsBackgroundWork(sessionId => {
    caller = sessionId;
    return running ? [{ id: 'run-a', sessionId }] : [];
  });

  try {
    const idle = await guard()(ctx);
    assert.ok(idle, 'an idle provider must admit compaction');
    await idle.release();
    assert.equal(caller, '/tmp/session-a.jsonl', 'the provider receives the active session identity');

    running = true;
    assert.equal(await guard()(ctx), null, 'same-session running work must defer compaction');

    running = false;
    const other = registerSubagentsBackgroundWork(() => [{ id: 'run-b', sessionId: 'session-b' }]);
    try {
      const unrelated = await guard()(ctx);
      assert.ok(unrelated, 'another session\'s work must not block this session');
      await unrelated.release();
    } finally {
      other();
    }
  } finally {
    unregister();
  }

  assert.equal(await guard()(ctx), null, 'current tools without a provider fail closed');
});

test('the neutral provider is removed by its disposer', async (t) => {
  delete globalThis[registryKey];
  t.after(() => { delete globalThis[registryKey]; });
  const unregister = registerSubagentsBackgroundWork(() => []);
  assert.equal(globalThis[registryKey].providers.has('pi-subagents'), true);
  unregister();
  assert.equal(globalThis[registryKey].providers.has('pi-subagents'), false);
});
