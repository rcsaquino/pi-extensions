import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, addSkill, proposed, markdown } from './helpers.ts';
import { atomicWrite, tree, treeHash, exists } from '../src/filesystem.ts';
import { CORE } from '../src/types.ts';
import { acquireLock, BusyError } from '../src/lock.ts';

test('bootstrap creates a clean container and policy and recreates a deleted policy file', async t => {
  const f = await fixture(t);
  assert.equal(await f.writer.ensureCore('test-session'), true);
  assert.equal(await exists(join(f.root, 'SKILL.md')), false);
  assert.equal(await f.writer.ensureCore('test-session'), false);
  await fs.unlink(join(f.root, CORE, 'SKILL.md'));
  assert.equal(await f.writer.ensureCore('test-session'), true);
  assert.match(await fs.readFile(join(f.root, CORE, 'SKILL.md'), 'utf8'), /name: learning-policy/);
});
test('deleted linked policy guidance cannot leave learning permanently unreadable', async t => {
  const f = await fixture(t); await f.writer.ensureCore('test-session');
  await fs.rm(join(f.root, CORE, 'references', 'evidence-policy.md'));
  assert.equal(await f.writer.ensureCore('test-session'), true);
  assert.equal(await exists(join(f.root, CORE, 'references', 'evidence-policy.md')), true);
});
test('deleted core directory/root restores only core, not deleted task skills', async t => {
  const f = await fixture(t); await f.writer.ensureCore('test-session'); await addSkill(f.root, 'user-task');
  await fs.rm(join(f.root, CORE), { recursive: true }); await f.writer.ensureCore('test-session');
  assert.equal(await exists(join(f.root, 'user-task', 'SKILL.md')), true);
  await fs.rm(f.root, { recursive: true }); await f.writer.ensureCore('test-session');
  assert.equal(await exists(join(f.root, CORE, 'SKILL.md')), true);
  assert.equal(await exists(join(f.root, 'user-task')), false);
});
test('invalid core recovers without model access and paused core repair stays stopped', async t => {
  const f = await fixture(t); await f.writer.ensureCore('test-session');
  await atomicWrite(join(f.root, CORE, 'SKILL.md'), 'invalid frontmatter');
  await f.writer.ensureCore('test-session');
  assert.match(await fs.readFile(join(f.root, CORE, 'SKILL.md'), 'utf8'), /name: learning-policy/);
  await f.store.change(s => { s.paused = true; });
  await fs.unlink(join(f.root, CORE, 'SKILL.md'));
  assert.equal(await f.writer.ensureCore('test-session'), false);
  assert.equal(await exists(join(f.root, CORE, 'SKILL.md')), false);
});
test('natural creation and manual-skill improvement leave outside skills byte-identical', async t => {
  const f = await fixture(t); await addSkill(f.other, 'protected');
  const before = treeHash(await tree(f.other));
  await f.writer.apply({ operation: 'create', skillId: 'release-checklist', baseHash: null, workflow: 'release review', reason: 'Useful workflow', files: proposed() }, ['obs-1'], 'test-session');
  await addSkill(f.root, 'user-workflow'); await f.learner.sync();
  const row = f.learner.records.find(r => r.id === 'user-workflow')!;
  await f.writer.apply({ operation: 'update', skillId: row.id, baseHash: row.hash, reason: 'Verified correction', files: proposed(row.name, 'Verify the corrected result.') }, ['obs-1'], 'test-session');
  assert.match(await fs.readFile(join(f.root, row.id, 'SKILL.md'), 'utf8'), /corrected result/);
  assert.equal(treeHash(await tree(f.other)), before);
});
test('manual edits invalidate stale update/deletion hashes', async t => {
  const f = await fixture(t); await addSkill(f.root, 'user-workflow'); await f.learner.sync();
  const row = f.learner.records[0]; await atomicWrite(join(f.root, row.id, 'SKILL.md'), markdown(row.name, 'Manual edit must survive.'));
  await assert.rejects(() => f.writer.apply({ operation: 'update', skillId: row.id, baseHash: row.hash, reason: 'Update', files: proposed(row.name) }, [], 'test-session'), /changed/);
  await assert.rejects(() => f.writer.apply({ operation: 'delete', skillId: row.id, baseHash: row.hash, reason: 'Stale', retirement: { reasonCode: 'stale' } }, [], 'test-session'), /changed/);
  assert.match(await fs.readFile(join(f.root, row.id, 'SKILL.md'), 'utf8'), /Manual edit/);
});
test('whole-skill deletion archives scripts/assets/empty directories and restores without inference', async t => {
  const f = await fixture(t); await addSkill(f.root, 'manual-obsolete');
  await atomicWrite(join(f.root, 'manual-obsolete', 'scripts', 'tool.sh'), '#!/bin/sh\necho retained\n', 0o700);
  await atomicWrite(join(f.root, 'manual-obsolete', 'assets', 'binary.bin'), Buffer.from([0, 255, 1, 2]));
  await fs.mkdir(join(f.root, 'manual-obsolete', 'empty'));
  await f.learner.sync(); const row = f.learner.records[0];
  const revision = await f.writer.apply({ operation: 'delete', skillId: row.id, baseHash: row.hash, reason: 'Verified obsolete procedure', retirement: { reasonCode: 'stale' } }, ['obs-1'], 'test-session');
  assert.equal(await exists(join(f.root, row.id)), false);
  assert.equal(treeHash(await tree(join(f.state, revision.archive!))), row.hash);
  assert.equal((await f.store.read()).tombstones.length, 1);
  await f.writer.restore(revision.id, 'test-session');
  assert.equal(treeHash(await tree(join(f.root, row.id))), row.hash);
  assert.equal((await f.store.read()).tombstones.length, 0);
});
test('restore refuses a recreated skill rather than overwriting it', async t => {
  const f = await fixture(t); await addSkill(f.root, 'obsolete'); await f.learner.sync(); const row = f.learner.records[0];
  const r = await f.writer.apply({ operation: 'delete', skillId: row.id, baseHash: row.hash, reason: 'Obsolete', retirement: { reasonCode: 'stale' } }, [], 'test-session');
  await addSkill(f.root, row.id, 'New manual version.');
  await assert.rejects(() => f.writer.restore(r.id, 'test-session'), /appeared/);
  assert.match(await fs.readFile(join(f.root, row.id, 'SKILL.md'), 'utf8'), /New manual/);
});
test('rollback restores prior instructions and preserves scripts', async t => {
  const f = await fixture(t); await addSkill(f.root, 'workflow');
  await atomicWrite(join(f.root, 'workflow', 'script.sh'), 'original script', 0o700);
  await f.learner.sync(); const row = f.learner.records[0]; const original = row.markdown;
  const r = await f.writer.apply({ operation: 'update', skillId: row.id, baseHash: row.hash, reason: 'Correction', files: proposed(row.name, 'Updated steps.') }, [], 'test-session');
  await f.writer.rollback(row.id, r.id, 'test-session');
  assert.equal(await fs.readFile(join(f.root, row.id, 'SKILL.md'), 'utf8'), original);
  assert.equal(await fs.readFile(join(f.root, row.id, 'script.sh'), 'utf8'), 'original script');
});
test('live locks prevent duplicate workers and release idempotently', async t => {
  const f = await fixture(t); const release = await acquireLock(f.state, 'worker');
  await assert.rejects(() => acquireLock(f.state, 'worker'), BusyError);
  await release(); await release(); const again = await acquireLock(f.state, 'worker'); await again();
});
test('prepared deletion is reconciled after a simulated crash, not replayed blindly', async t => {
  const f = await fixture(t); await addSkill(f.root, 'obsolete'); await f.learner.sync(); const row = f.learner.records[0];
  const id = randomUUID(); const archive = `retired/${id}/skill`;
  await fs.mkdir(join(f.state, 'retired', id), { recursive: true }); await fs.rename(join(f.root, row.id), join(f.state, archive));
  const revision = { id, skillId: row.id, operation: 'delete', timestamp: Date.now(), reason: 'Obsolete', beforeHash: row.hash, afterHash: null, evidenceIds: [], archive, status: 'committed' };
  await atomicWrite(join(f.state, 'transactions', `${id}.json`), JSON.stringify({ version: 1, revision, operation: 'delete', skillId: row.id, beforeHash: row.hash, afterHash: null, phase: 'prepared' }));
  await f.writer.recover(); await f.writer.recover();
  assert.equal((await f.store.read()).history.filter(r => r.id === id).length, 1);
  assert.equal((await f.store.read()).tombstones.length, 1);
  assert.equal(await exists(join(f.root, row.id)), false);
});
