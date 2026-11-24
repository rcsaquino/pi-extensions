import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryDatabase } from "../src/database.ts";
import { temporary } from "./helpers.ts";

const LOCK_TABLE = "/proc/locks";

function holdsLockOn(path: string, pid: number): boolean {
  const inode = statSync(path).ino;
  return readFileSync(LOCK_TABLE, "utf8").split("\n").some(line => {
    const field = line.trim().split(/\s+/);
    return field[1] === "POSIX" && field[3]?.includes("READ")
      && field[4] === String(pid) && field[5]?.endsWith(`:${inode}`);
  });
}

test("an open store keeps SQLite's POSIX lock on an existing database", async (t) => {
  if (!existsSync(LOCK_TABLE)) { t.skip("POSIX lock table not available"); return; }
  const path = join(await temporary(t), "memoria.sqlite");

  const seed = new MemoryDatabase(path);
  seed.add({ content: "before the second connection" });
  seed.close();

  // Reopening an existing store is when SQLite acquires and keeps its SHARED
  // lock. privateMode() must not close a second descriptor after that, because
  // POSIX releases every lock the process holds on the file when any
  // descriptor for it is closed.
  const db = new MemoryDatabase(path);
  t.after(() => db.close());
  assert.equal(holdsLockOn(path, process.pid), true, "database file is no longer locked");

  const wal = `${path}-wal`;
  assert.equal(existsSync(wal), true);
  const inode = statSync(wal).ino;

  const other = new DatabaseSync(path);
  other.close();

  assert.equal(holdsLockOn(path, process.pid), true, "lock lost after another connection closed");
  assert.equal(existsSync(wal), true, "live WAL was unlinked");
  assert.equal(statSync(wal).ino, inode, "live WAL was replaced");
  const { memory } = db.add({ content: "after the second connection" });
  db.close();

  const reread = new MemoryDatabase(path);
  t.after(() => reread.close());
  assert.deepEqual(reread.get(memory.id)?.content, "after the second connection");
});
