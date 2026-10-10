import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryDatabase } from "../src/database.ts";
import { temporary } from "./helpers.ts";

const wal = "PRAGMA journal_mode=WAL;";
const busy = () => Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });

test("WAL selection retries only numeric SQLITE_BUSY and then preserves durable CRUD", async t => {
  const path = join(await temporary(t), "memoria.sqlite"), original = DatabaseSync.prototype.exec;
  let attempts = 0;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === wal && ++attempts <= 2) throw busy();
    return original.call(this, sql);
  });
  const db = new MemoryDatabase(path);
  const fact = db.add({ content: "Cold-open WAL contention preserves facts." }).memory;
  assert.equal(attempts, 3); db.close(); t.mock.restoreAll();
  const reopened = new MemoryDatabase(path);
  try { assert.deepEqual(reopened.get(fact.id), fact); }
  finally { reopened.close(); }
});

test("WAL selection never retries unrelated errors or message-only busy lookalikes", async t => {
  const dir = await temporary(t), original = DatabaseSync.prototype.exec;
  for (const [index, error] of [
    Object.assign(new Error("cannot open"), { code: "ERR_SQLITE_ERROR", errcode: 14 }),
    Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 6 }),
    new Error("database is locked"),
  ].entries()) {
    let attempts = 0;
    t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
      if (sql === wal) { attempts++; throw error; }
      return original.call(this, sql);
    });
    try { assert.throws(() => new MemoryDatabase(join(dir, `error-${index}.sqlite`)), /SQLite is unavailable/u); assert.equal(attempts, 1); }
    finally { t.mock.restoreAll(); }
  }
});

test("WAL selection contention has a five-second deadline and still reports storage failure", async t => {
  const path = join(await temporary(t), "memoria.sqlite"), original = DatabaseSync.prototype.exec;
  let attempts = 0, clockReads = 0;
  t.mock.method(performance, "now", () => clockReads++ === 0 ? 0 : 5_001);
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === wal) { attempts++; throw busy(); }
    return original.call(this, sql);
  });
  assert.throws(() => new MemoryDatabase(path), /database is locked/u);
  assert.equal(attempts, 1); assert.equal(clockReads, 2);
});

test("WAL busy retry revalidates companion safety before another SQLite attempt", async t => {
  const dir = await temporary(t), path = join(dir, "memoria.sqlite"), outside = join(dir, "outside");
  fs.writeFileSync(outside, "preserve", { mode: 0o644 });
  const bytes = fs.readFileSync(outside), mode = fs.statSync(outside).mode, original = DatabaseSync.prototype.exec;
  let attempts = 0;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === wal) { attempts++; fs.symlinkSync(outside, path + "-shm"); throw busy(); }
    return original.call(this, sql);
  });
  assert.throws(() => new MemoryDatabase(path), /Unsafe database/u);
  assert.equal(attempts, 1); assert.deepEqual(fs.readFileSync(outside), bytes); assert.equal(fs.statSync(outside).mode, mode);
});
