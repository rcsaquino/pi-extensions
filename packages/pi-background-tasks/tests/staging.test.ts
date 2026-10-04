import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Stage, validateStage, safeManifest } from '../src/staging.ts';
import { Directory, digest, readRegular, writeRegular } from '../src/files.ts';
import { ResourceLocks, resourcesConflict } from '../src/resources.ts';
import { scratch } from './helpers.ts';

async function fixture(t: test.TestContext) {
  const root = await scratch('stage-'); const cwd = join(root, 'parent'); await fs.mkdir(cwd);
  await fs.writeFile(join(cwd, 'input.txt'), 'immutable input'); await fs.writeFile(join(cwd, 'a.txt'), 'base a'); await fs.writeFile(join(cwd, 'b.txt'), 'base b');
  const locks = new ResourceLocks(join(root, 'locks'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = async (id: string, outputs: string[], inputs = ['input.txt']) => { const s = new Stage(id, cwd, join(root, id), validateStage({ inputs, outputs })); await s.snapshot(); t.after(() => s.close()); return s; };
  return { root, cwd, locks, stage };
}
test('two private file writers are genuinely bound, input references immutable and disjoint checked publication works', async t => {
  const f = await fixture(t), a = await f.stage('bg-aaaaaaaaaaaa', ['a.txt']), b = await f.stage('bg-bbbbbbbbbbbb', ['b.txt']);
  await Promise.all([a.file('write', 'a.txt', 'new a'), b.file('edit', 'b.txt', undefined, [{ oldText: 'base', newText: 'new' }])]);
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'base a'); assert.equal(await a.file('read', 'input.txt'), 'immutable input');
  await assert.rejects(a.file('write', 'input.txt', 'changed'), /not a declared/);
  for (const path of ['../escape', '/etc/passwd', '@a.txt', 'a.txt/../b.txt']) await assert.rejects(a.file('write', path, 'escape'));
  const [am, bm] = await Promise.all([a.seal(), b.seal()]); assert.equal(safeManifest(am, a.taskId).hash, am.hash);
  await assert.rejects(a.publish(f.locks, 'f'.repeat(64)), /Review/);
  // Disjoint outputs with shared read inputs acquire atomically without false conflicts.
  await Promise.all([a.publish(f.locks, am.hash), b.publish(f.locks, bm.hash)]);
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'new a'); assert.equal(await fs.readFile(join(f.cwd, 'b.txt'), 'utf8'), 'new b');
  assert.equal(f.locks.conflicts([{ path: f.cwd, mode: 'write' }]), false);
  await assert.rejects(a.file('write', 'a.txt', 'late'), /sealed/);
});
test('source changes during work remain invisible in the snapshot and invalidate publication without destructive merge', async t => {
  const f = await fixture(t), s = await f.stage('bg-aaaaaaaaaaaa', ['a.txt']); await s.file('write', 'a.txt', 'changed output');
  await fs.writeFile(join(f.cwd, 'input.txt'), 'concurrent source change'); assert.equal(await s.file('read', 'input.txt'), 'immutable input');
  const m = await s.seal(); await assert.rejects(s.publish(f.locks, m.hash), /Stale input/); assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'base a');
  assert.equal(f.locks.conflicts([{ path: f.cwd, mode: 'write' }]), false);
});
test('conflicting manifests serialize and reject stale target bases; intentional stage mutations invalidate reviewed hashes', async t => {
  const f = await fixture(t), a = await f.stage('bg-aaaaaaaaaaaa', ['a.txt']), b = await f.stage('bg-bbbbbbbbbbbb', ['a.txt']);
  await a.file('write', 'a.txt', 'one'); await b.file('write', 'a.txt', 'two'); const am = await a.seal(), bm = await b.seal();
  await a.publish(f.locks, am.hash); await assert.rejects(b.publish(f.locks, bm.hash), /Stale publication base/); assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'one');
  const c = await f.stage('bg-cccccccccccc', ['b.txt']); await c.file('write', 'b.txt', 'reviewed'); const cm = await c.seal();
  await fs.writeFile(join(c.root, 'output', 'b.txt'), 'changed after review'); await assert.rejects(c.publish(f.locks, cm.hash), /changed after review/);
  assert.equal(await fs.readFile(join(f.cwd, 'b.txt'), 'utf8'), 'base b');
});
test('multi-file injected failure rolls all changed targets back and keeps a non-destructive journal', async t => {
  const f = await fixture(t), s = await f.stage('bg-aaaaaaaaaaaa', ['a.txt', 'b.txt']);
  await s.file('write', 'a.txt', 'new a'); await s.file('write', 'b.txt', 'new b'); const m = await s.seal();
  await assert.rejects(s.publish(f.locks, m.hash, undefined, index => { if (index === 1) throw new Error('Synthetic publication failure'); }), /Synthetic publication/);
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'base a'); assert.equal(await fs.readFile(join(f.cwd, 'b.txt'), 'utf8'), 'base b');
  assert.equal(JSON.parse((await fs.readFile(join(s.root, 'recovery', 'journal.json'))).toString()).state, 'rolled-back');
  assert.equal(f.locks.conflicts([{ path: f.cwd, mode: 'write' }]), false);
});
test('rollback never clobbers an uncoordinated later change; uncertain resources remain locked for explicit recovery', async t => {
  const f = await fixture(t), s = await f.stage('bg-aaaaaaaaaaaa', ['a.txt', 'b.txt']);
  await s.file('write', 'a.txt', 'new a'); await s.file('write', 'b.txt', 'new b'); const m = await s.seal();
  const { writeFileSync } = await import('node:fs');
  await assert.rejects(s.publish(f.locks, m.hash, undefined, index => { if (index === 1) { writeFileSync(join(f.cwd, 'a.txt'), 'outside later change'); throw new Error('Injected'); } }), /recovery requires review/);
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'outside later change');
  assert.equal(f.locks.conflicts([{ path: join(f.cwd, 'a.txt'), mode: 'read' }], true), true);
  assert.equal(f.locks.conflicts([{ path: join(f.cwd, 'unrelated'), mode: 'write' }]), false);
});
test('symlink/ancestor/hardlink swaps and private namespace replacement fail closed without chmod or outside mutation', async t => {
  const f = await fixture(t), s = await f.stage('bg-aaaaaaaaaaaa', ['a.txt']);
  await fs.unlink(join(s.root, 'output', 'a.txt')); await fs.link(join(f.cwd, 'b.txt'), join(s.root, 'output', 'a.txt'));
  await assert.rejects(s.file('write', 'a.txt', 'escape'), /Unsafe/); assert.equal(await fs.readFile(join(f.cwd, 'b.txt'), 'utf8'), 'base b');
  await fs.unlink(join(s.root, 'output', 'a.txt')); await fs.symlink(join(f.cwd, 'b.txt'), join(s.root, 'output', 'a.txt')); await assert.rejects(s.seal());
  const p = await f.stage('bg-bbbbbbbbbbbb', ['b.txt']); await p.file('write', 'b.txt', 'safe'); const m = await p.seal();
  await fs.rename(f.cwd, f.cwd + '-moved'); await fs.symlink(f.cwd + '-moved', f.cwd); await assert.rejects(p.publish(f.locks, m.hash));
  assert.equal(await fs.readFile(join(f.cwd + '-moved', 'b.txt'), 'utf8'), 'base b');
  const own = new Stage('bg-cccccccccccc', f.cwd + '-moved', join(f.root, 'private'), { inputs: [], outputs: ['a.txt'] }); await own.snapshot(); t.after(() => own.close());
  await fs.rename(own.root, own.root + '-old'); await fs.mkdir(own.root, { mode: 0o700 }); await assert.rejects(own.file('write', 'a.txt', 'escape'), /identity changed/);
  assert.equal((await fs.readdir(own.root)).length, 0);
});
test('descriptor operations reject hardlinks and ancestors, and do not change outside mode/content', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); await fs.writeFile(outside, 'synthetic outside', { mode: 0o644 });
  await fs.link(outside, join(f.cwd, 'linked')); await assert.rejects(writeRegular(join(f.cwd, 'linked'), Buffer.from('bad')), /Unsafe/);
  await fs.symlink(f.cwd, join(f.root, 'alias')); await assert.rejects(readRegular(join(f.root, 'alias', 'a.txt')));
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o644); assert.equal(await fs.readFile(outside, 'utf8'), 'synthetic outside');
  const dir = await Directory.open(f.cwd); await fs.rename(f.cwd, f.cwd + '-old'); await fs.mkdir(f.cwd); await assert.rejects(dir.replace('outside', Buffer.from('bad')), /identity changed/); await dir.close();
  assert.equal((await fs.readdir(f.cwd)).length, 0);
});
test('shared-read/exclusive-write resources use ancestor conflicts and atomic deterministic multi-acquisition', async t => {
  const f = await fixture(t), other = new ResourceLocks(f.locks.root);
  const readers = await Promise.all([f.locks.acquire([{ path: join(f.cwd, 'a.txt'), mode: 'read' }]), other.acquire([{ path: join(f.cwd, 'a.txt'), mode: 'read' }])]);
  // A mutex contender can report busy without acquiring a partial resource.
  for (const r of readers) if (r) await r();
  const held = await f.locks.acquire([{ path: join(f.cwd, 'a.txt'), mode: 'write' }, { path: join(f.cwd, 'b.txt'), mode: 'write' }]); assert.ok(held);
  assert.equal(await other.acquire([{ path: join(f.cwd, 'b.txt'), mode: 'write' }, { path: join(f.cwd, 'input.txt'), mode: 'write' }]), undefined);
  assert.equal(other.conflicts([{ path: join(f.cwd, 'input.txt'), mode: 'write' }]), false, 'failed multi-acquisition held no partial input lock');
  assert.equal(resourcesConflict([{ path: f.cwd, mode: 'read' }], [{ path: join(f.cwd, 'a.txt'), mode: 'write' }]), true);
  assert.equal(resourcesConflict([{ path: f.cwd, mode: 'write' }], [{ path: f.cwd + '-other', mode: 'read' }]), false);
  await held(); await held(); assert.equal(other.conflicts([{ path: f.cwd, mode: 'write' }]), false);
});
test('dead process resource ownership is recovered without task replay; publication uncertainty is not stolen', async t => {
  const f = await fixture(t); await fs.mkdir(f.locks.root, { mode: 0o700 });
  const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await writeRegular(f.locks.path, Buffer.from(JSON.stringify([{ token, pid: 2147483647, resources: [{ path: f.cwd, mode: 'write' }] }])));
  const lease = await f.locks.acquire([{ path: f.cwd, mode: 'write' }]); assert.ok(lease); await lease();
  await writeRegular(f.locks.path, Buffer.from(JSON.stringify([{ token, pid: 2147483647, retainOnCrash: true, resources: [{ path: f.cwd, mode: 'write' }] }])));
  assert.equal(await f.locks.acquire([{ path: f.cwd, mode: 'write' }]), undefined); assert.equal(f.locks.conflicts([{ path: f.cwd, mode: 'read' }]), true);
  assert.equal(digest('x').length, 64);
});

test('unsupported binary/special-mode targets and resource expansion are rejected rather than silently converted', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.cwd, 'binary'), Buffer.from([0xff, 0, 0x11]));
  const binary = new Stage('bg-aaaaaaaaaaaa', f.cwd, join(f.root, 'binary-stage'), { inputs: [], outputs: ['binary'] }); t.after(() => binary.close()); await assert.rejects(binary.snapshot(), /UTF-8 text/);
  await fs.chmod(join(f.cwd, 'a.txt'), 0o755); const executable = new Stage('bg-bbbbbbbbbbbb', f.cwd, join(f.root, 'exec-stage'), { inputs: [], outputs: ['a.txt'] }); t.after(() => executable.close()); await assert.rejects(executable.snapshot(), /executable\/special-mode/);
  const lease = await f.locks.acquire([{ path: join(f.cwd, 'b.txt'), mode: 'read' }, { path: join(f.root, 'private'), mode: 'write' }]); assert.ok(lease);
  await assert.rejects(lease.narrow([{ path: f.cwd, mode: 'write' }]), /cannot expand/); assert.equal(f.locks.conflicts([{ path: join(f.cwd, 'b.txt'), mode: 'write' }]), true);
  await lease.narrow([{ path: join(f.root, 'private'), mode: 'write' }]); assert.equal(f.locks.conflicts([{ path: join(f.cwd, 'b.txt'), mode: 'write' }]), false); await lease();
});
