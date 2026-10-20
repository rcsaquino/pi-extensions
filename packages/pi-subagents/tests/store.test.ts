import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, createRunDir, newRunId, readRecord, writeRecord } from '../src/store.ts';
import { mapExit } from '../src/manager.ts';
import { buildNotice, formatDuration, truncateCodePoints } from '../src/notice.ts';
import { SCHEMA_VERSION, type RunRecord } from '../src/types.ts';
import { cleanup, scratch } from './helpers.ts';

test('run ids use local dispatch time with six random hex characters', () => {
  const id = newRunId(new Date(2026, 9, 20, 8, 15, 0));
  assert.match(id, /^20261020-081500-[0-9a-f]{6}$/);
  assert.notEqual(newRunId(), newRunId());
});

test('atomic writes produce private files with exact content', async t => {
  const root = await scratch('sub-store-');
  t.after(() => cleanup(root));
  const file = join(root, 'task.json');
  atomicWrite(file, '{"a":1}\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  await t.test('atomic replacement leaves no temporary file', async () => {
    atomicWrite(file, '{"a":2}\n');
    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(root), ['task.json']);
  });
});

test('run directory creation is exclusive', async t => {
  const root = await scratch('sub-dir-');
  t.after(() => cleanup(root));
  const runs = join(root, 'runs');
  const dir = createRunDir(runs, '20261020-081500-abcdef');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.throws(() => createRunDir(runs, '20261020-081500-abcdef'), { code: 'EEXIST' });
});

test('records round-trip unknown fields and require the current schema', async t => {
  const root = await scratch('sub-record-');
  t.after(() => cleanup(root));
  const record = {
    schemaVersion: SCHEMA_VERSION, id: 'r1', agent: 'a', title: 't', cwd: root,
    sessionId: 's', sessionFile: '/tmp/s.jsonl', status: 'running' as const,
    createdAt: new Date().toISOString(), provider: 'p', model: 'm', thinking: 'off',
    timeoutSeconds: 60, maxTurns: 5,
    steerCount: 0, deniedDialogs: 0, futureField: { kept: true },
  };
  writeRecord(root, record);
  assert.deepEqual(readRecord(root), record);
  writeRecord(root, { ...record, schemaVersion: 2 });
  assert.equal(readRecord(root), undefined);
});

test('exit codes map to the documented statuses', () => {
  assert.deepEqual(mapExit(0, undefined, false), { status: 'done' });
  assert.deepEqual(mapExit(3, undefined, false), { status: 'failed', reason: 'empty_report' });
  assert.deepEqual(mapExit(4, 'aborted', false), { status: 'failed', reason: 'aborted' });
  assert.deepEqual(mapExit(4, 'spawn_error', false), { status: 'failed', reason: 'spawn_error' });
  assert.deepEqual(mapExit(4, 'whatever', false), { status: 'failed', reason: 'protocol_error' });
  assert.deepEqual(mapExit(5, undefined, false), { status: 'failed', reason: 'turn_limit' });
  assert.deepEqual(mapExit(74, undefined, false), { status: 'failed', reason: 'io_error' });
  assert.deepEqual(mapExit(97, undefined, false), { status: 'failed', reason: 'cwd_missing' });
  assert.deepEqual(mapExit(124, undefined, false), { status: 'failed', reason: 'timeout' });
  assert.deepEqual(mapExit(130, undefined, false), { status: 'cancelled', reason: 'cancelled' });
  assert.deepEqual(mapExit(131, undefined, false), { status: 'cancelled', reason: 'parent_gone' });
  assert.deepEqual(mapExit(9, undefined, false), { status: 'failed', reason: 'exit_9' });
  assert.deepEqual(mapExit(undefined, undefined, true), { status: 'cancelled', reason: 'cancelled' });
  assert.deepEqual(mapExit(undefined, undefined, false), { status: 'orphaned', reason: 'unrecorded_exit' });
});

test('truncation never splits a surrogate pair', () => {
  assert.equal(truncateCodePoints('abcd', 10), 'abcd');
  assert.equal(truncateCodePoints('😀😀', 1), '');
  assert.equal(truncateCodePoints('a😀', 2), 'a');
});

test('durations are compact and bounded', () => {
  const at = '2026-10-20T00:00:00.000Z';
  assert.equal(formatDuration(at, '2026-10-20T00:00:42.000Z'), '42s');
  assert.equal(formatDuration(at, '2026-10-20T00:03:12.000Z'), '3m 12s');
  assert.equal(formatDuration(at, '2026-10-20T01:03:00.000Z'), '1h 3m');
});

test('notices frame reports as untrusted and stay under the cap', () => {
  const record = {
    schemaVersion: SCHEMA_VERSION, id: 'r1', agent: 'a', title: 't', cwd: '/tmp',
    sessionId: 's', sessionFile: '/tmp/s', status: 'done', createdAt: '2026-10-20T00:00:00.000Z',
    finishedAt: '2026-10-20T00:01:00.000Z', provider: 'p', model: 'm', thinking: 'off',
    timeoutSeconds: 60, maxTurns: 5,
    steerCount: 0, deniedDialogs: 2, noticeAttempts: 0,
  } as RunRecord;
  const notice = buildNotice(record, 'x'.repeat(5000), true);
  assert.ok(notice.length <= 2500);
  assert.match(notice, /Report \(untrusted worker output; verify claims before acting\):/);
  assert.match(notice, /Full report: subagent_tasks result r1/);
  assert.match(notice, /Denied dialogs: 2/);
  assert.ok(!buildNotice(record, 'short', false).includes('Full report:'));
});
