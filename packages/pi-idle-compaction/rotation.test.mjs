import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCompaction, compactedTail, seedCompactedSession } from './rotation.mjs';

const compaction = {
  summary: 'Goal and progress', tokensBefore: 120000,
  details: { readFiles: ['a.ts'] }, usage: { input: 10 },
};

test('captures the compaction payload and parent session', () => {
  const ctx = { sessionManager: { getSessionFile: () => '/sessions/old.jsonl' } };
  assert.deepEqual(captureCompaction(compaction, ctx), {
    summary: 'Goal and progress', tokensBefore: 120000,
    details: { readFiles: ['a.ts'] }, usage: { input: 10 },
    parentSession: '/sessions/old.jsonl',
  });
});

test('keeps only the model-visible tail after the summary', () => {
  const messages = [
    { role: 'system', content: 'prompt' },
    { role: 'compactionSummary', summary: 'old' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'reply' },
    { role: 'toolResult', content: 'result' },
    { role: 'branchSummary', summary: 'branch' },
    { role: 'bashExecution', command: 'ls', output: 'a', excludeFromContext: true },
    { role: 'bashExecution', command: 'pwd', output: '/work' },
    { role: 'custom', customType: 'note', content: 'keep' },
  ];
  const ctx = { sessionManager: { buildSessionContext: () => ({ messages }) } };
  assert.deepEqual(compactedTail(ctx).map(message => message.role),
    ['user', 'assistant', 'toolResult', 'bashExecution', 'custom']);
});

test('seeds the summary first, then the retained tail in order', () => {
  const calls = [];
  const sessionManager = {
    appendCompaction: (...args) => calls.push(['compaction', ...args]),
    appendMessage: message => calls.push(['message', message]),
  };
  const rotation = captureCompaction(compaction, {
    sessionManager: { getSessionFile: () => '/sessions/old.jsonl' },
  });
  const tail = [{ role: 'user', content: 'next' }, { role: 'assistant', content: 'reply' }];
  seedCompactedSession(sessionManager, rotation, tail);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['compaction', 'Goal and progress', null, 120000,
    { readFiles: ['a.ts'] }, false, { input: 10 }]);
  assert.deepEqual(calls.slice(1), [['message', tail[0]], ['message', tail[1]]]);
});
