import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync, linkSync, unlinkSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/database.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'analytics-alias-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = join(dir, 'storage'); mkdirSync(storage);
  const outside = join(dir, 'outside.sqlite'); writeFileSync(outside, '', { mode: 0o644 });
  return { dir, storage, outside, path: join(storage, 'analytics.sqlite') };
}
function unchanged(path, action) {
  const bytes = readFileSync(path), mode = statSync(path).mode;
  assert.throws(action);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(statSync(path).mode, mode);
}
test('hardlinked analytics DB is rejected before modifying the outside inode', t => {
  const f = fixture(t); linkSync(f.outside, f.path);
  unchanged(f.outside, () => openDatabase(f.path));
  assert.equal(statSync(f.outside).nlink, 2);
  assert.deepEqual(readdirSync(f.storage), ['analytics.sqlite']);
});
test('ancestor directory symlinks, nonregular DB and unsafe SQLite sidecars fail closed', t => {
  const f = fixture(t); const alias = join(f.dir, 'linked'); symlinkSync(f.storage, alias, 'dir');
  assert.throws(() => openDatabase(join(alias, 'analytics.sqlite')));
  mkdirSync(f.path); assert.throws(() => openDatabase(f.path)); rmSync(f.path, { recursive: true });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    linkSync(f.outside, f.path + suffix); unchanged(f.outside, () => openDatabase(f.path)); unlinkSync(f.path + suffix);
    symlinkSync(f.outside, f.path + suffix); unchanged(f.outside, () => openDatabase(f.path)); unlinkSync(f.path + suffix);
  }
});
test('rejected foreign WAL DB retains database and existing SQLite companion bytes/modes', t => {
  const f = fixture(t), raw = new DatabaseSync(f.path);
  raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE foreign_app(value TEXT); INSERT INTO foreign_app VALUES('preserve');");
  try {
    const names = readdirSync(f.storage), before = names.map(name => ({ name, bytes: readFileSync(join(f.storage, name)), mode: statSync(join(f.storage, name)).mode }));
    assert.throws(() => openDatabase(f.path)); assert.deepEqual(readdirSync(f.storage), names);
    for (const entry of before) { assert.deepEqual(readFileSync(join(f.storage, entry.name)), entry.bytes); assert.equal(statSync(join(f.storage, entry.name)).mode, entry.mode); }
  } finally { raw.close(); }
});
test('normal single-link reopen works, rejected foreign/future DBs retain bytes, modes and settings', t => {
  const f = fixture(t); let db = openDatabase(f.path); db.close(); db = openDatabase(f.path); db.close();
  assert.equal(statSync(f.path).nlink, 1);
  for (const [name, sql] of [['foreign', 'CREATE TABLE foreign_app(value TEXT);'], ['future', 'PRAGMA application_id=1347174740; PRAGMA user_version=999;']]) {
    const path = join(f.storage, `${name}.sqlite`), raw = new DatabaseSync(path); raw.exec(sql); raw.close();
    unchanged(path, () => openDatabase(path));
  }
});
