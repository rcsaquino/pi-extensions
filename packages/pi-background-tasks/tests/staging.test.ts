import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Stage, validateStage, safeManifest } from '../src/staging.ts';
import { Directory, readRegular, writeRegular } from '../src/files.ts';
import { scratch } from './helpers.ts';

async function fixture(t: test.TestContext) {
  const root = await scratch('stage-'); const cwd = join(root, 'parent'); await fs.mkdir(cwd);
  await fs.writeFile(join(cwd, 'input.txt'), 'immutable input'); await fs.writeFile(join(cwd, 'a.txt'), 'base a'); await fs.writeFile(join(cwd, 'b.txt'), 'base b');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = async (id: string, outputs: string[], inputs = ['input.txt']) => { const s = new Stage(id, cwd, join(root, id), validateStage({ inputs, outputs })); await s.snapshot(); t.after(() => s.close()); return s; };
  return { root, cwd, stage };
}
test('two private file writers are bound, references immutable and concurrent checked publication works without locks', async t => {
  const f = await fixture(t), a = await f.stage('bg-aaaaaaaaaaaa', ['a.txt']), b = await f.stage('bg-bbbbbbbbbbbb', ['b.txt']);
  await Promise.all([a.file('write', 'a.txt', 'new a'), b.file('edit', 'b.txt', undefined, [{ oldText: 'base', newText: 'new' }])]);
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'base a'); assert.equal(await a.file('read', 'input.txt'), 'immutable input');
  await assert.rejects(a.file('write', 'input.txt', 'changed'), /not a declared/);
  for (const path of ['../escape', '/etc/passwd', '@a.txt', 'a.txt/../b.txt']) await assert.rejects(a.file('write', path, 'escape'));
  const [am, bm] = await Promise.all([a.seal(), b.seal()]); assert.equal(safeManifest(am, a.taskId).hash, am.hash);
  await assert.rejects(a.publish('f'.repeat(64)), /Review/);
  await Promise.all([a.publish(am.hash), b.publish(bm.hash)]);
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'new a'); assert.equal(await fs.readFile(join(f.cwd, 'b.txt'), 'utf8'), 'new b');
  await assert.rejects(a.file('write', 'a.txt', 'late'), /sealed/);
  await assert.rejects(fs.stat(join(f.root, 'locks')), { code: 'ENOENT' });
});
test('source changes stay invisible in the snapshot and invalidate publication without destructive merge', async t => {
  const f = await fixture(t), s = await f.stage('bg-aaaaaaaaaaaa', ['a.txt']); await s.file('write', 'a.txt', 'changed output');
  await fs.writeFile(join(f.cwd, 'input.txt'), 'concurrent source change'); assert.equal(await s.file('read', 'input.txt'), 'immutable input');
  const m = await s.seal(); await assert.rejects(s.publish(m.hash), /Stale input/); assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'base a');
});
test('overlapping manifests are admitted without resource ownership; detected stale bases and altered reviewed hashes still reject', async t => {
  const f = await fixture(t), a = await f.stage('bg-aaaaaaaaaaaa', ['a.txt']), b = await f.stage('bg-bbbbbbbbbbbb', ['a.txt']);
  await a.file('write', 'a.txt', 'one'); await b.file('write', 'a.txt', 'two'); const am = await a.seal(), bm = await b.seal();
  await a.publish(am.hash); await assert.rejects(b.publish(bm.hash), /Stale publication base/); assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'one');
  const c = await f.stage('bg-cccccccccccc', ['b.txt']); await c.file('write', 'b.txt', 'reviewed'); const cm = await c.seal();
  await fs.writeFile(join(c.root, 'output', 'b.txt'), 'changed after review'); await assert.rejects(c.publish(cm.hash), /changed after review/);
  assert.equal(await fs.readFile(join(f.cwd, 'b.txt'), 'utf8'), 'base b');
});
test('multi-file failure rolls owned changed targets back and keeps a non-destructive journal', async t => {
  const f = await fixture(t), s = await f.stage('bg-aaaaaaaaaaaa', ['a.txt', 'b.txt']);
  await s.file('write', 'a.txt', 'new a'); await s.file('write', 'b.txt', 'new b'); const m = await s.seal();
  await assert.rejects(s.publish(m.hash, undefined, index => { if (index === 1) throw new Error('Synthetic publication failure'); }), /Synthetic publication/);
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'base a'); assert.equal(await fs.readFile(join(f.cwd, 'b.txt'), 'utf8'), 'base b');
  assert.equal(JSON.parse((await fs.readFile(join(s.root, 'recovery', 'journal.json'))).toString()).state, 'rolled-back');
});
test('rollback never clobbers a later edit; uncertainty prevents replay of that manifest, not other operations', async t => {
  const f = await fixture(t), s = await f.stage('bg-aaaaaaaaaaaa', ['a.txt', 'b.txt']);
  await s.file('write', 'a.txt', 'new a'); await s.file('write', 'b.txt', 'new b'); const m = await s.seal();
  const { writeFileSync } = await import('node:fs');
  await assert.rejects(s.publish(m.hash, undefined, index => { if (index === 1) { writeFileSync(join(f.cwd, 'a.txt'), 'outside later change'); throw new Error('Injected'); } }), /recovery requires review/);
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'outside later change');
  assert.equal(JSON.parse(await fs.readFile(join(s.root, 'recovery', 'journal.json'), 'utf8')).state, 'review-required');
  await assert.rejects(s.publish(m.hash), /Review/);
  const next = await f.stage('bg-bbbbbbbbbbbb', ['a.txt']); await next.file('write', 'a.txt', 'separately approved'); const nm = await next.seal(); await next.publish(nm.hash);
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'separately approved');
});
test('symlink/ancestor/hardlink swaps and private namespace replacement fail closed without outside mutation', async t => {
  const f = await fixture(t), s = await f.stage('bg-aaaaaaaaaaaa', ['a.txt']);
  await fs.unlink(join(s.root, 'output', 'a.txt')); await fs.link(join(f.cwd, 'b.txt'), join(s.root, 'output', 'a.txt'));
  await assert.rejects(s.file('write', 'a.txt', 'escape'), /Unsafe/); assert.equal(await fs.readFile(join(f.cwd, 'b.txt'), 'utf8'), 'base b');
  await fs.unlink(join(s.root, 'output', 'a.txt')); await fs.symlink(join(f.cwd, 'b.txt'), join(s.root, 'output', 'a.txt')); await assert.rejects(s.seal());
  const p = await f.stage('bg-bbbbbbbbbbbb', ['b.txt']); await p.file('write', 'b.txt', 'safe'); const m = await p.seal();
  await fs.rename(f.cwd, f.cwd + '-moved'); await fs.symlink(f.cwd + '-moved', f.cwd); await assert.rejects(p.publish(m.hash));
  assert.equal(await fs.readFile(join(f.cwd + '-moved', 'b.txt'), 'utf8'), 'base b');
  const own = new Stage('bg-cccccccccccc', f.cwd + '-moved', join(f.root, 'private'), { inputs: [], outputs: ['a.txt'] }); await own.snapshot(); t.after(() => own.close());
  await fs.rename(own.root, own.root + '-old'); await fs.mkdir(own.root, { mode: 0o700 }); await assert.rejects(own.file('write', 'a.txt', 'escape'), /identity changed/);
  assert.equal((await fs.readdir(own.root)).length, 0);
});
test('descriptor operations reject hardlinks and ancestors, without changing outside mode/content', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); await fs.writeFile(outside, 'synthetic outside', { mode: 0o644 });
  await fs.link(outside, join(f.cwd, 'linked')); await assert.rejects(writeRegular(join(f.cwd, 'linked'), Buffer.from('bad')), /Unsafe/);
  await fs.symlink(f.cwd, join(f.root, 'alias')); await assert.rejects(readRegular(join(f.root, 'alias', 'a.txt')));
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o644); assert.equal(await fs.readFile(outside, 'utf8'), 'synthetic outside');
  const dir = await Directory.open(f.cwd); await fs.rename(f.cwd, f.cwd + '-old'); await fs.mkdir(f.cwd); await assert.rejects(dir.replace('outside', Buffer.from('bad')), /identity changed/); await dir.close();
  assert.equal((await fs.readdir(f.cwd)).length, 0);
});
test('unsupported binary/special-mode targets remain rejected', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.cwd, 'binary'), Buffer.from([0xff, 0, 0x11]));
  const binary = new Stage('bg-aaaaaaaaaaaa', f.cwd, join(f.root, 'binary-stage'), { inputs: [], outputs: ['binary'] }); t.after(() => binary.close()); await assert.rejects(binary.snapshot(), /UTF-8 text/);
  await fs.chmod(join(f.cwd, 'a.txt'), 0o755); const executable = new Stage('bg-bbbbbbbbbbbb', f.cwd, join(f.root, 'exec-stage'), { inputs: [], outputs: ['a.txt'] }); t.after(() => executable.close()); await assert.rejects(executable.snapshot(), /executable\/special-mode/);
});
test('same manifest cannot publish twice concurrently, but cancellation leaves ordinary retry possible', async t => {
  const f = await fixture(t), s = await f.stage('bg-aaaaaaaaaaaa', ['a.txt']); await s.file('write', 'a.txt', 'new'); const m = await s.seal();
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(s.publish(m.hash, cancelled.signal));
  const first = s.publish(m.hash); await assert.rejects(s.publish(m.hash), /already be publishing/); await first;
  assert.equal(await fs.readFile(join(f.cwd, 'a.txt'), 'utf8'), 'new');
});
