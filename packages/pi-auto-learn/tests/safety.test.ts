import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, addSkill, proposed, markdown } from './helpers.ts';
import { DEFAULT_CONFIG, parseConfig } from '../src/config.ts';
import { atomicWrite, safeRelative, tree, treeHash, within } from '../src/filesystem.ts';
import { inventory, frontmatter } from '../src/skill-library.ts';
import { parseProposal, validateChange, eligibleUnused } from '../src/validation.ts';
import { CORE, DAY } from '../src/types.ts';
import { capture, guestInput } from '../src/observations.ts';
import { safeExcerpt } from '../src/privacy.ts';

test('configuration rejects unknown fields, prototype keys, and excessive limits', () => {
  assert.throws(() => parseConfig({ constructor: 'bad' }));
  assert.throws(() => parseConfig({ ...DEFAULT_CONFIG, maxDeletes: 9 }));
  assert.throws(() => parseConfig({ ...DEFAULT_CONFIG, timeoutMs: -1 }));
  assert.equal(parseConfig({ version: 1 }).unusedDays, 90);
});
test('strict relative paths reject traversal, absolute paths, prefix confusion and prototype components', () => {
  for (const p of ['../sibling', '/tmp/x', 'x/../../y', 'x\\y', './x', '.hidden', 'a//b', '__proto__']) assert.throws(() => safeRelative(p));
  assert.equal(safeRelative('category/user-skill'), 'category/user-skill');
  assert.equal(within('/root/x', '/root/xx/skill'), false);
});
test('frontmatter checks valid natural names, duplicates, and aliases', () => {
  assert.equal(frontmatter(markdown()).name, 'release-checklist');
  assert.throws(() => frontmatter('---\nname: first\nname: second\ndescription: x\n---\nx'));
  assert.throws(() => frontmatter('---\nname: &a hello\ndescription: *a\n---\nx'));
});
test('schema blocks executable files, absolute writes, duplicate operations and unknown keys', () => {
  const base = { protocolVersion: 1, decision: 'change', evidenceIds: ['obs-1'], changes: [{ operation: 'create', skillId: 'release-checklist', baseHash: null, workflow: 'release review', reason: 'Verified task', files: proposed() }] };
  assert.equal(parseProposal(JSON.stringify(base), DEFAULT_CONFIG).changes.length, 1);
  for (const path of ['scripts/evil.sh', '/etc/config', '../outside.md']) {
    const input = structuredClone(base); input.changes[0].files[0].path = path;
    assert.throws(() => parseProposal(JSON.stringify(input), DEFAULT_CONFIG));
  }
  assert.throws(() => parseProposal(JSON.stringify({ ...base, overrideSafety: true }), DEFAULT_CONFIG));
  assert.throws(() => parseProposal(JSON.stringify({ ...base, changes: [base.changes[0], base.changes[0]] }), DEFAULT_CONFIG));
});
test('inventory admits manual unprefixed nested skills and does not follow symlinks', async t => {
  const f = await fixture(t);
  await addSkill(f.root, 'category/user-workflow');
  await addSkill(f.other, 'external-workflow');
  await fs.symlink(f.other, join(f.root, 'linked-external'));
  const rows = await inventory(f.root);
  assert.deepEqual(rows.map(r => r.id), ['category/user-workflow']);
  await f.learner.sync();
  assert.ok((await f.store.read()).skills['category/user-workflow']);
});
test('a manually added Pi skill with a fallback directory name is valid and enrolled', async t => {
  const f = await fixture(t);
  await atomicWrite(join(f.root, 'fallback-name', 'SKILL.md'), '---\ndescription: Use for the fallback workflow.\n---\n\nVerify the outcome.\n');
  const rows = await inventory(f.root);
  assert.equal(rows[0].valid, true); assert.equal(rows[0].name, 'fallback-name');
});
test('writer refuses symlink and hard-link trees and leaves their external targets intact', async t => {
  const f = await fixture(t);
  await addSkill(f.root, 'user-skill'); await addSkill(f.other, 'outside');
  const original = await fs.readFile(join(f.other, 'outside', 'SKILL.md'));
  await fs.symlink(join(f.other, 'outside', 'SKILL.md'), join(f.root, 'user-skill', 'link.md'));
  await assert.rejects(() => tree(join(f.root, 'user-skill')));
  await fs.unlink(join(f.root, 'user-skill', 'link.md'));
  await fs.link(join(f.other, 'outside', 'SKILL.md'), join(f.root, 'user-skill', 'hard.md'));
  await assert.rejects(() => tree(join(f.root, 'user-skill')));
  assert.deepEqual(await fs.readFile(join(f.other, 'outside', 'SKILL.md')), original);
});
test('new names must be natural, but existing user-added names are not renamed', async t => {
  const f = await fixture(t);
  await addSkill(f.root, 'custom-directory', undefined, 'my-workflow'); await f.learner.sync();
  const s = await f.store.read(); const rows = f.learner.records;
  const old = rows[0];
  assert.equal(validateChange({ operation: 'update', skillId: old.id, baseHash: old.hash, reason: 'Clarify', files: proposed('my-workflow', 'Verify before finishing.') }, rows, s, DEFAULT_CONFIG, Date.now(), new Set()), undefined);
  const prefixed = { operation: 'create' as const, skillId: 'auto-learn-messy', baseHash: null, reason: 'New task', workflow: 'task', files: proposed('auto-learn-messy') };
  assert.match(validateChange(prefixed, rows, s, DEFAULT_CONFIG, Date.now(), new Set())!, /natural name/);
});
test('pins, dependencies, core slot and nested skill roots prevent deletion', async t => {
  const f = await fixture(t);
  await f.writer.ensureCore('test-session');
  await addSkill(f.root, 'obsolete'); await addSkill(f.root, 'retained', 'Use the obsolete skill for prerequisites.');
  await f.learner.sync();
  const s = await f.store.read(); const old = f.learner.records.find(r => r.id === 'obsolete')!;
  const deletion = { operation: 'delete' as const, skillId: old.id, baseHash: old.hash, reason: 'Obsolete', retirement: { reasonCode: 'stale' as const } };
  assert.match(validateChange(deletion, f.learner.records, s, DEFAULT_CONFIG, Date.now(), new Set())!, /references/);
  s.pins.push(old.id);
  assert.match(validateChange(deletion, [old], s, DEFAULT_CONFIG, Date.now(), new Set())!, /pinned/);
  const core = f.learner.records.find(r => r.id === CORE)!;
  assert.match(validateChange({ ...deletion, skillId: CORE, baseHash: core.hash }, [core], s, DEFAULT_CONFIG, Date.now(), new Set())!, /recovery/);
  await addSkill(join(f.root, 'obsolete'), 'nested');
  const nested = (await inventory(f.root)).find(r => r.id === 'obsolete')!;
  assert.match(validateChange({ ...deletion, baseHash: nested.hash }, [nested], { ...s, pins: [] }, DEFAULT_CONFIG, Date.now(), new Set())!, /Nested/);
});
test('unused deletion requires duration, foreground observation and separated reviews', async t => {
  const f = await fixture(t); await addSkill(f.root, 'infrequent'); await f.learner.sync();
  const s = await f.store.read(); const row = f.learner.records[0]; const now = Date.now();
  const stat = s.skills[row.id]; stat.firstSeen = stat.lastActivity = now - 100 * DAY; stat.qualifyingRuns = 50;
  assert.equal(eligibleUnused(stat, now, DEFAULT_CONFIG), true);
  const c = { operation: 'delete' as const, skillId: row.id, baseHash: row.hash, reason: 'Unused', retirement: { reasonCode: 'unused' as const } };
  assert.match(validateChange(c, [row], s, DEFAULT_CONFIG, now, new Set())!, /repeated/);
  stat.cleanupReviews = [now - 8 * DAY, now];
  assert.equal(validateChange(c, [row], s, DEFAULT_CONFIG, now, new Set()), undefined);
  stat.qualifyingRuns = 0;
  assert.match(validateChange(c, [row], s, DEFAULT_CONFIG, now, new Set())!, /observation/);
});
test('capture excludes thought blocks, tool payloads, casual greetings and sensitive records', () => {
  const branch = [{ type: 'message', id: 'u', message: { role: 'user', content: 'Please remember this reusable testing workflow.' } }, { type: 'message', id: 'a', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'private hidden trace' }, { type: 'text', text: 'Verified.' }] } }];
  const e = capture(branch, 's', [], [])!;
  assert.equal(e.assistant, 'Verified.'); assert.ok(!JSON.stringify(e).includes('hidden trace'));
  branch[0].message.content = 'Hello'; assert.equal(capture(branch, 's', [], []), undefined);
  assert.equal(safeExcerpt('patient name: Real Person'), undefined);
  assert.equal(safeExcerpt('Surgical cases tomorrow:\n1. Sample Person, 55/M, operation'), undefined);
  assert.equal(safeExcerpt('api_key=not-a-real-but-secretlike-value'), undefined);
  assert.equal(guestInput('[telegram|guest:group] hello'), true);
  assert.equal(guestInput('[telegram|from:user] hello'), false);
});
test('hash covers scripts, modes and empty directories', async t => {
  const f = await fixture(t); await addSkill(f.root, 'complete');
  await fs.mkdir(join(f.root, 'complete', 'empty'));
  const before = treeHash(await tree(join(f.root, 'complete')));
  await atomicWrite(join(f.root, 'complete', 'script.sh'), '#!/bin/sh\necho test\n', 0o700);
  assert.notEqual(treeHash(await tree(join(f.root, 'complete'))), before);
});
