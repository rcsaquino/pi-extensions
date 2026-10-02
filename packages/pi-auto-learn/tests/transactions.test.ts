import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { acquireLock, BusyError } from '../src/lock.ts';
import { fixture, addSkill, proposed, markdown } from './helpers.ts';
import { Writer } from '../src/safe-writer.ts';
import { atomicWrite, tree, treeHash, exists } from '../src/filesystem.ts';

test('simulated cross-filesystem retirement verifies archive before local removal and supports restore', async t => {
  const f = await fixture(t); await addSkill(f.root, 'obsolete'); await f.learner.sync(); const row = f.learner.records[0];
  const writer = new Writer(f.root, f.store, { rename: async (source, destination) => {
    if (source === join(f.root, row.id) && destination.includes('/retired/')) throw Object.assign(new Error('Simulated cross-filesystem move'), { code: 'EXDEV' });
    await fs.rename(source, destination);
  } });
  const r = await writer.apply({ operation: 'delete', skillId: row.id, baseHash: row.hash, reason: 'Verified obsolete task', retirement: { reasonCode: 'stale' } }, [], 'test-session');
  assert.equal(await exists(join(f.root, row.id)), false); assert.equal(treeHash(await tree(join(f.state, r.archive!))), row.hash);
  await writer.restore(r.id, 'test-session'); assert.equal(treeHash(await tree(join(f.root, row.id))), row.hash);
});
test('writer revalidates pins and newly discovered dependencies at commit time', async t => {
  const f = await fixture(t); await addSkill(f.root, 'obsolete'); await f.learner.sync(); const row = f.learner.records[0];
  await addSkill(f.root, 'consumer', 'Use the obsolete skill before completing this task.');
  await assert.rejects(() => f.writer.apply({ operation: 'delete', skillId: row.id, baseHash: row.hash, reason: 'Old task', retirement: { reasonCode: 'stale' } }, [], 'test-session'), /references/);
  assert.equal(await exists(join(f.root, row.id)), true);
});
test('writer itself rejects executable payloads even if its caller omitted proposal validation', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.writer.apply({ operation: 'create', skillId: 'bad', baseHash: null, workflow: 'bad', reason: 'Bad payload', files: [...proposed('bad'), { path: 'scripts/evil.sh', content: 'echo forbidden' }] }, [], 'test-session'), /Only SKILL/);
  assert.equal(await exists(join(f.root, 'bad')), false);
});
test('last-moment model/foreground guard prevents an otherwise valid commit', async t => {
  const f = await fixture(t); await addSkill(f.root, 'workflow'); await f.learner.sync(); const row = f.learner.records[0];
  await assert.rejects(() => f.writer.apply({ operation: 'update', skillId: row.id, baseHash: row.hash, reason: 'Update', files: proposed(row.name, 'A revised instruction.') }, [], 'test-session', undefined, new Set(), () => { throw new Error('Model changed'); }), /Model changed/);
  assert.equal(await fs.readFile(join(f.root, row.id, 'SKILL.md'), 'utf8'), row.markdown);
});
test('rollback does not overwrite a user script edit made after the recorded revision', async t => {
  const f = await fixture(t); await addSkill(f.root, 'workflow'); await atomicWrite(join(f.root, 'workflow', 'script.sh'), 'old script'); await f.learner.sync(); const row = f.learner.records[0];
  const r = await f.writer.apply({ operation: 'update', skillId: row.id, baseHash: row.hash, reason: 'Docs update', files: proposed(row.name, 'Updated documents.') }, [], 'test-session');
  await atomicWrite(join(f.root, row.id, 'script.sh'), 'new manual script');
  await f.writer.rollback(row.id, r.id, 'test-session');
  assert.equal(await fs.readFile(join(f.root, row.id, 'script.sh'), 'utf8'), 'new manual script');
});
test('committed filesystem transaction with missing audit bookkeeping is reconciled', async t => {
  const f = await fixture(t); await addSkill(f.root, 'workflow'); const files = await tree(join(f.root, 'workflow'));
  const id = randomUUID(); const afterHash = treeHash(files);
  const revision = { id, skillId: 'workflow', operation: 'create', timestamp: Date.now(), reason: 'Crash after commit', beforeHash: null, afterHash, evidenceIds: [], status: 'committed' };
  await atomicWrite(join(f.state, 'transactions', `${id}.json`), JSON.stringify({ version: 1, revision, operation: 'create', skillId: 'workflow', beforeHash: null, afterHash, phase: 'committed' }));
  await f.writer.recover(); assert.equal((await f.store.read()).history.filter(r => r.id === id).length, 1);
});
test('a separate Node process holds the shared worker lease exclusively', async t => {
  const f = await fixture(t);
  const module = pathToFileURL(join(import.meta.dirname, '../src/lock.ts')).href;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(module)}; const release = await acquireLock(process.argv[1], 'worker'); console.log('ready'); setTimeout(async () => { await release(); }, 500);`, f.state], { cwd: f.base, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, 'data');
  await assert.rejects(() => acquireLock(f.state, 'worker'), BusyError);
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
  const release = await acquireLock(f.state, 'worker'); await release();
});
test('foreground admission shares the commit gate and blocks the next automatic write', async t => {
  const f = await fixture(t); let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const barrier = new Promise<void>(r => { release = r; });
  t.after(() => release());
  const commit = f.store.commit('test-session', async () => { entered(); await barrier; });
  await started;
  let admitted = false;
  const admission = f.store.activity('another-session', true).then(() => { admitted = true; });
  await new Promise(r => setTimeout(r, 25)); assert.equal(admitted, false);
  release(); await commit; await admission;
  await assert.rejects(() => f.store.commit('test-session', async () => {}), /Foreground activity/);
});
test('simultaneous bookkeeping updates serialize without lost writes or release races', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 40 }, (_, i) => f.store.change(s => { s.seen.push(`concurrent-${i}`); })));
  assert.equal((await f.store.read()).seen.length, 40);
});
test('bounded backup retention removes only old verified private snapshots', async t => {
  const f = await fixture(t); await addSkill(f.root, 'workflow');
  await atomicWrite(join(f.state, 'config.json'), JSON.stringify({ ...await f.store.config(), backupRevisions: 1 }));
  const revisions = [];
  for (let i = 0; i < 3; i++) {
    await f.learner.sync(); const row = f.learner.records[0];
    revisions.push(await f.writer.apply({ operation: 'update', skillId: row.id, baseHash: row.hash, reason: 'Verified correction', files: [{ path: 'SKILL.md', content: markdown(row.name, `Revision ${i}. Verify the output.`) }] }, [], 'test-session'));
  }
  assert.equal(await exists(join(f.state, revisions[0].archive!)), false);
  assert.equal(await exists(join(f.state, revisions.at(-1)!.archive!)), true);
});
