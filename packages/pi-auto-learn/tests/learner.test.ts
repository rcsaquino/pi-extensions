import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, generousConfig, evidence, fakeHost, addSkill, proposed, fakeProfile } from './helpers.ts';
import { CORE } from '../src/types.ts';
import { exists, atomicWrite } from '../src/filesystem.ts';
import { outputBudget } from '../src/model-profile.ts';

async function ready(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t); await generousConfig(f.store); await f.writer.ensureCore('test-session'); await f.learner.sync(); return f;
}
test('background creation uses the supplied main profile for proposal and fresh critique', async t => {
  const f = await ready(t); await evidence(f.learner);
  const host = fakeHost([{ protocolVersion: 1, decision: 'change', evidenceIds: ['obs-1'], changes: [{ operation: 'create', skillId: 'release-checklist', baseHash: null, reason: 'Explicit reusable workflow', workflow: 'release review checklist', files: proposed() }] }, { protocolVersion: 1, verdict: 'approve', reason: 'Supported and useful.' }]);
  assert.match(await f.learner.run(host, true), /Applied 1/);
  assert.equal(await exists(join(f.root, 'release-checklist', 'SKILL.md')), true);
  assert.equal(host.calls.length, 2);
  for (const call of host.calls) assert.equal((call as { profile: typeof fakeProfile }).profile, fakeProfile);
  const s = await f.store.read(); assert.equal(s.evidence.length, 0); assert.equal(s.budget[0].tokens, 200); assert.equal(s.budget[0].reserved, 0);
});
test('a manually supplied skill improves through the ordinary model pipeline', async t => {
  const f = await ready(t); await addSkill(f.root, 'user-checklist'); await f.learner.sync(); await evidence(f.learner, 'The checklist needs this verified precondition before checking the result.', ['user-checklist']);
  const row = f.learner.records.find(r => r.id === 'user-checklist')!;
  const host = fakeHost([{ protocolVersion: 1, decision: 'change', evidenceIds: ['obs-1'], changes: [{ operation: 'update', skillId: row.id, baseHash: row.hash, reason: 'Explicit correction', files: proposed(row.name, 'Check the precondition first. Verify the result.') }] }, { protocolVersion: 1, verdict: 'approve', reason: 'Verified correction.' }]);
  assert.match(await f.learner.run(host, true), /Applied/);
  assert.match(await fs.readFile(join(f.root, row.id, 'SKILL.md'), 'utf8'), /precondition first/);
});
test('stale manual skills can be deleted in the first version using the same worker', async t => {
  const f = await ready(t); await addSkill(f.root, 'old-workflow'); await f.learner.sync(); await evidence(f.learner, 'The old-workflow procedure is obsolete; its old system was retired.', ['old-workflow']);
  const row = f.learner.records.find(r => r.id === 'old-workflow')!;
  const host = fakeHost([{ protocolVersion: 1, decision: 'change', evidenceIds: ['obs-1'], changes: [{ operation: 'delete', skillId: row.id, baseHash: row.hash, reason: 'User confirms the underlying system was retired', retirement: { reasonCode: 'stale' } }] }, { protocolVersion: 1, verdict: 'approve', reason: 'Supported retirement with recoverable archive.' }]);
  assert.match(await f.learner.run(host, true), /Applied/);
  assert.equal(await exists(join(f.root, row.id)), false);
  assert.equal((await f.store.read()).tombstones[0].skillId, row.id);
});
test('core learning policy can update itself without recursive learning requests', async t => {
  const f = await ready(t); await evidence(f.learner, 'Remember to favor concise reusable instructions and avoid redundant examples.', [CORE]);
  const core = f.learner.records.find(r => r.id === CORE)!;
  const host = fakeHost([{ protocolVersion: 1, decision: 'change', evidenceIds: ['obs-1'], changes: [{ operation: 'update', skillId: CORE, baseHash: core.hash, reason: 'Improve concise learning guidance', files: [{ path: 'SKILL.md', content: core.markdown + '\nPrefer a single compact illustrative example when sufficient.\n' }] }] }, { protocolVersion: 1, verdict: 'approve', reason: 'Preserves authority and improves concision.' }]);
  assert.match(await f.learner.run(host, true), /Applied/);
  assert.equal(host.calls.length, 2); assert.match(await fs.readFile(join(f.root, CORE, 'SKILL.md'), 'utf8'), /single compact/);
});
test('no-op costs one request and does not rewrite skills', async t => {
  const f = await ready(t); await evidence(f.learner);
  const before = await fs.readFile(join(f.root, CORE, 'SKILL.md'));
  const host = fakeHost([{ protocolVersion: 1, decision: 'noop', evidenceIds: [], changes: [] }]);
  assert.equal(await f.learner.run(host, true), 'No change justified'); assert.equal(host.calls.length, 1);
  assert.deepEqual(await fs.readFile(join(f.root, CORE, 'SKILL.md')), before);
});
test('invention of evidence IDs fails closed', async t => {
  const f = await ready(t); await evidence(f.learner);
  const host = fakeHost([{ protocolVersion: 1, decision: 'change', evidenceIds: ['invented'], changes: [{ operation: 'create', skillId: 'invented', baseHash: null, workflow: 'invented', reason: 'Invented', files: proposed('invented') }] }]);
  assert.match(await f.learner.run(host, true), /unknown evidence/); assert.equal(await exists(join(f.root, 'invented')), false);
});
test('foreground cancellation and model changes retain evidence and prevent commits', async t => {
  const f = await ready(t); await evidence(f.learner);
  const host = fakeHost([]); host.complete = async (_system, _input, _profile, signal) => {
    f.learner.cancel(); signal.throwIfAborted(); return { text: '', tokens: 0, cost: 0 };
  };
  assert.match(await f.learner.run(host, true), /Cancelled/); assert.equal((await f.store.read()).evidence.length, 1);
  assert.equal((await f.store.read()).budget[0].uncertain, true);
  await f.store.change(s => { s.budget = []; });
  host.complete = async () => { host.profile = () => ({ ...fakeProfile, fingerprint: 'changed' }); return { text: '{}', tokens: 10, cost: 0 }; };
  assert.match(await f.learner.run(host, true), /profile changed/);
});
test('abandoned-branch, excluded, and paused evidence is not learned from', async t => {
  const f = await ready(t); await evidence(f.learner);
  const host = fakeHost([]); host.branchIds = new Set();
  assert.match(await f.learner.run(host, true), /No eligible/); assert.equal(host.calls.length, 0);
  await f.store.change(s => { s.excluded.push(host.sessionId); });
  assert.match(await f.learner.run(host, true), /excluded/);
});
test('tombstones block silent recreation under the same workflow and user re-add clears them', async t => {
  const f = await ready(t); await addSkill(f.root, 'obsolete'); await f.learner.sync(); const row = f.learner.records.find(r => r.id === 'obsolete')!;
  await f.writer.apply({ operation: 'delete', skillId: row.id, baseHash: row.hash, reason: 'Bad procedure', retirement: { reasonCode: 'bad' } }, [], 'test-session');
  await f.learner.sync(); await evidence(f.learner);
  const host = fakeHost([{ protocolVersion: 1, decision: 'change', evidenceIds: ['obs-1'], changes: [{ operation: 'create', skillId: 'new-name', baseHash: null, workflow: row.description, reason: 'Reuse discarded workflow', files: proposed('new-name') }] }]);
  assert.match(await f.learner.run(host, true), /discarded workflow/); assert.equal(await exists(join(f.root, 'new-name')), false);
  await addSkill(f.root, 'obsolete', 'User explicitly re-added this skill.'); await f.learner.sync();
  assert.equal((await f.store.read()).tombstones.length, 0);
});
test('supported new evidence can reopen a discarded workflow without hiding its prior deletion', async t => {
  const f = await ready(t); await addSkill(f.root, 'obsolete'); await f.learner.sync(); const row = f.learner.records.find(r => r.id === 'obsolete')!;
  await f.writer.apply({ operation: 'delete', skillId: row.id, baseHash: row.hash, reason: 'Unsupported old workflow', retirement: { reasonCode: 'bad' } }, [], 'test-session');
  await f.learner.sync(); await evidence(f.learner, 'Create a reusable skill for the corrected workflow now that the unsupported system has been replaced and verified.');
  const host = fakeHost([{ protocolVersion: 1, decision: 'change', evidenceIds: ['obs-1'], changes: [{ operation: 'create', skillId: 'corrected-workflow', baseHash: null, workflow: row.description, reopens: row.id, resolution: 'The former unsupported system has now been replaced with a verified supported implementation.', reason: 'Fresh explicit user evidence resolves the previous failure', files: proposed('corrected-workflow') }] }, { protocolVersion: 1, verdict: 'approve', reason: 'Fresh cited evidence concretely resolves the prior retirement reason.' }]);
  assert.match(await f.learner.run(host, true), /Applied/);
  assert.equal((await f.store.read()).tombstones.length, 0);
});
test('high-impact pending changes retain inspectable proposals without applying them', async t => {
  const f = await ready(t); await evidence(f.learner);
  const host = fakeHost([{ protocolVersion: 1, decision: 'change', evidenceIds: ['obs-1'], changes: [{ operation: 'create', skillId: 'deployment', baseHash: null, workflow: 'privileged deployment workflow', reason: 'Deployment task', files: proposed('deployment', 'Run sudo to change the host deployment.') }] }]);
  assert.match(await f.learner.run(host, true), /require review/);
  const r = (await f.store.read()).history.at(-1)!;
  assert.equal(r.status, 'pending'); assert.ok(r.proposal);
  assert.equal(JSON.parse(await fs.readFile(join(f.state, r.proposal!), 'utf8')).change.skillId, 'deployment');
  assert.equal(await exists(join(f.root, 'deployment')), false);
});
test('casual chats do not count as meaningful non-use observations', async t => {
  const f = await ready(t); const before = (await f.store.read()).skills[CORE].qualifyingRuns;
  await f.learner.observe('test-session', 'greeting-only', undefined, []);
  assert.equal((await f.store.read()).skills[CORE].qualifyingRuns, before);
});
test('effective thinking budgets are inherited and insufficient output/context defers', () => {
  const high = { ...fakeProfile, level: 'high' as const, options: { thinkingBudgets: { high: 24_000 } }, model: { ...fakeProfile.model, maxTokens: 65_536 } };
  assert.ok(outputBudget(high, 8192, 1024).maxTokens >= 25_024);
  assert.throws(() => outputBudget({ ...high, model: { ...high.model, maxTokens: 8192 } }, 8192, 1024), /thinking budget/);
  assert.throws(() => outputBudget({ ...high, model: { ...high.model, contextWindow: 4096 } }, 8192, 1024), /context/);
});
test('live foreground activity and root-wide budgets prevent requests', async t => {
  const f = await ready(t); await evidence(f.learner);
  const host = fakeHost([]); await f.store.activity('another-session', true);
  assert.match(await f.learner.run(host, true), /Foreground/); assert.equal(host.calls.length, 0);
  await f.store.activity('another-session', false);
  await atomicWrite(join(f.state, 'config.json'), JSON.stringify({ ...await f.store.config(), hourlyTokens: 1024 }));
  assert.match(await f.learner.run(host, true), /budget reached/); assert.equal(host.calls.length, 0);
});
