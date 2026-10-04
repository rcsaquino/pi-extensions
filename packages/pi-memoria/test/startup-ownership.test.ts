import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryDatabase } from "../src/database.ts";
import { temporary } from "./helpers.ts";

async function unchanged(path: string, action: () => void) {
  const bytes = await fs.readFile(path), mode = (await fs.stat(path)).mode;
  assert.throws(action);
  assert.deepEqual(await fs.readFile(path), bytes, "rejection must not alter the database bytes/version/journal header");
  assert.equal((await fs.stat(path)).mode, mode, "rejection must not chmod an unrelated file");
}
test("foreign version-zero database is rejected before schema, permission or journal mutation", async t => {
  const dir = await temporary(t), path = join(dir, "foreign.sqlite");
  const raw = new DatabaseSync(path); raw.exec("CREATE TABLE foreign_app(value TEXT); INSERT INTO foreign_app VALUES('preserve');"); raw.close();
  await fs.chmod(path, 0o644);
  await unchanged(path, () => new MemoryDatabase(path));
  assert.deepEqual((await fs.readdir(dir)).sort(), ["foreign.sqlite"]);
});
test("foreign WAL database rejection preserves the main file and existing SQLite companions", async t => {
  const dir = await temporary(t), path = join(dir, "foreign-wal.sqlite");
  const raw = new DatabaseSync(path); raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE foreign_app(value TEXT); INSERT INTO foreign_app VALUES('preserve');");
  try {
    const names = await fs.readdir(dir);
    const before = await Promise.all(names.map(async name => ({ name, bytes: await fs.readFile(join(dir, name)), mode: (await fs.stat(join(dir, name))).mode })));
    assert.throws(() => new MemoryDatabase(path));
    assert.deepEqual(await fs.readdir(dir), names);
    for (const entry of before) { assert.deepEqual(await fs.readFile(join(dir, entry.name)), entry.bytes); assert.equal((await fs.stat(join(dir, entry.name))).mode, entry.mode); }
  } finally { raw.close(); }
});
test("future and unsupported/spoofed schemas are rejected byte-for-byte and mode-for-mode", async t => {
  const dir = await temporary(t);
  for (const [name, sql] of [
    ["future", "CREATE TABLE important(value TEXT); PRAGMA user_version=999;"],
    ["spoof", "CREATE TABLE memories(content TEXT); PRAGMA user_version=2;"],
    ["foreign-id", "PRAGMA application_id=1234;"],
  ]) {
    const path = join(dir, `${name}.sqlite`), raw = new DatabaseSync(path); raw.exec(sql!); raw.close(); await fs.chmod(path, 0o644);
    await unchanged(path, () => new MemoryDatabase(path));
  }
});
test("hardlinks, nonregular entries, ancestor symlinks and companion aliases reject without touching outside fixtures", async t => {
  const dir = await temporary(t), outside = join(dir, "outside.sqlite"), storage = join(dir, "storage");
  await fs.mkdir(storage); await fs.writeFile(outside, "", { mode: 0o644 });
  const alias = join(storage, "memoria.sqlite"); await fs.link(outside, alias);
  await unchanged(outside, () => new MemoryDatabase(alias)); await fs.unlink(alias);
  await fs.symlink(outside, alias); await unchanged(outside, () => new MemoryDatabase(alias)); await fs.unlink(alias);
  const linkedDirectory = join(dir, "linked"); await fs.symlink(storage, linkedDirectory, "dir");
  assert.throws(() => new MemoryDatabase(join(linkedDirectory, "memoria.sqlite")));
  await fs.mkdir(alias); assert.throws(() => new MemoryDatabase(alias)); await fs.rmdir(alias);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await fs.link(outside, alias + suffix); await unchanged(outside, () => new MemoryDatabase(alias)); await fs.unlink(alias + suffix);
    await fs.symlink(outside, alias + suffix); await unchanged(outside, () => new MemoryDatabase(alias)); await fs.unlink(alias + suffix);
  }
});
test("new empty files, recognized legacy migration and current reopen preserve durable facts", async t => {
  const dir = await temporary(t), path = join(dir, "memoria.sqlite"); await fs.writeFile(path, "");
  let db = new MemoryDatabase(path); const fact = db.add({ content: "Synthetic durable fact" }).memory; db.close();
  const raw = new DatabaseSync(path); raw.exec("DROP INDEX memories_content; PRAGMA user_version=1; PRAGMA application_id=0;"); raw.close();
  db = new MemoryDatabase(path); assert.deepEqual(db.get(fact.id), fact); db.close();
  db = new MemoryDatabase(path); assert.deepEqual(db.get(fact.id), fact); db.close();
});
