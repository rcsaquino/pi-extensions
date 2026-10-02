import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Store, atomicPrivateWrite } from '../src/store.ts';
import { emptyUsage } from '../src/types.ts';
import type { RecordData } from '../src/types.ts';
import { scratch } from './helpers.ts';

async function fixture(t: TestContext) {
  const root = await scratch('bg-store-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'state'), 'parent'); await store.init(); return { root, store };
}
const data = (): RecordData => ({ version: 1, id: 'bg-111111111111', title: 'Work', sessionId: 'parent', cwd: '/workspace', provider: 'fake', model: 'live', thinking: 'high', status: 'running', access: 'write', startedAt: Date.now(), etaSeconds: 300, etaMaxSeconds: 500, estimateReason: 'Tests', lastActivityAt: Date.now(), toolCalls: 0, turns: 0, usage: emptyUsage(), usageReported: false, notification: 'read', overrunNotified: false });

test('runtime directories and files are private, and result roundtrip works', async t => {
  const { store } = await fixture(t); const record = { ...data(), status: 'completed' as const };
  await store.write(record, 'Verified result\n');
  assert.equal((await fs.stat(store.recordsDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(store.path(record.id, 'json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(store.path(record.id, 'md'))).mode & 0o777, 0o600);
  assert.equal(await store.output(record.id), 'Verified result\n');
  assert.equal((await store.restore())[0]!.status, 'completed');
});
test('context metadata roundtrips, and legacy tasks restore without inventing a new mode', async t => {
  const { store } = await fixture(t);
  for (const contextMode of ['brief', 'selected', 'full'] as const) {
    await store.write({ ...data(), status: 'completed', contextMode }); assert.equal((await store.restore())[0]!.contextMode, contextMode);
  }
  await store.write({ ...data(), status: 'completed' }); assert.equal((await store.restore())[0]!.contextMode, undefined);
});
test('corrupt context metadata is rejected rather than treated as brief-only', async t => {
  const { store } = await fixture(t); await store.write({ ...data(), contextMode: 'wrong' as never });
  await assert.rejects(store.restore(), /Invalid/);
});
test('crashed tasks become interrupted and are never replayed', async t => {
  const { store } = await fixture(t); await store.write(data());
  const restored = await store.restore(); assert.equal(restored[0]!.status, 'interrupted');
  assert.match(restored[0]!.error!, /NOT replayed/); assert.equal(restored[0]!.notification, 'pending');
  assert.equal((await store.restore())[0]!.status, 'interrupted');
});
test('task paths cannot escape storage', async t => {
  const { store } = await fixture(t);
  for (const id of ['../escape', '/absolute', 'bg-abc', 'bg-111111111111/../x']) assert.throws(() => store.path(id, 'md'));
});
test('result symlinks and storage-directory symlinks are rejected', async t => {
  const { root, store } = await fixture(t); const target = join(root, 'private'); await fs.writeFile(target, 'private content');
  await fs.symlink(target, store.path(data().id, 'md')); await assert.rejects(store.output(data().id));
  await fs.mkdir(join(root, 'elsewhere')); await fs.symlink(join(root, 'elsewhere'), join(root, 'alias'));
  await assert.rejects(new Store(join(root, 'alias', 'state'), 'parent').init());
  assert.deepEqual(await fs.readdir(join(root, 'elsewhere')), []);
});
test('atomic writes replace a result symlink without following it', async t => {
  const { root, store } = await fixture(t); const target = join(root, 'private'); await fs.writeFile(target, 'unchanged');
  await fs.symlink(target, store.path(data().id, 'md'));
  await atomicPrivateWrite(store.path(data().id, 'md'), 'replacement');
  assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
  assert.equal(await store.output(data().id), 'replacement');
});
test('one writer across sessions sharing a workspace, release is idempotent', async t => {
  const { store } = await fixture(t); const second = new Store(store.root, 'another'); await second.init();
  const release = await store.acquireWriter('/workspace');
  await assert.rejects(second.acquireWriter('/workspace'), /live background writer/);
  const releaseOther = await second.acquireWriter('/other-workspace'); await releaseOther();
  await release(); await release(); const release2 = await second.acquireWriter('/workspace'); await release2();
});
test('foreign metadata and malformed metadata fail closed', async t => {
  const { store } = await fixture(t); await store.write({ ...data(), sessionId: 'different' });
  await assert.rejects(store.restore(), /Invalid/);
});
