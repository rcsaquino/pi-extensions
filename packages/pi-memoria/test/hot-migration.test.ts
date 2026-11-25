import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryDatabase } from "../src/database.ts";
import { INITIAL_SCHEMA, VERSION_TWO } from "../src/database-schema.ts";
import { migrateLegacyHot } from "../src/hot-migration.ts";
import { temporary } from "./helpers.ts";

function legacyVersion(path: string, version: 1 | 2): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(INITIAL_SCHEMA);
    if (version === 2) db.exec(VERSION_TWO);
    db.exec("PRAGMA application_id=0x4d454d4f;");
  } finally { db.close(); }
}

test("legacy MEMORY.md is imported once, renamed to backups, and never re-imported", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "memoria.sqlite");
  writeFileSync(join(directory, "MEMORY.md"), [
    "- [h_aaaaaaaaaaaaaaaa] [p=90] Never use em dashes.",
    "- [h_bbbbbbbbbbbbbbbb] [p=60] Prefer plain English.",
    "- Hand-written rule.",
    "",
  ].join("\n"));
  const db = new MemoryDatabase(path);
  t.after(() => db.close());

  const first = await migrateLegacyHot(db, directory);
  assert.equal(first.status, "migrated");
  assert.equal(first.entries, 3);
  assert.ok(first.backup && existsSync(first.backup));
  assert.equal(existsSync(join(directory, "MEMORY.md")), false);
  assert.match(readFileSync(first.backup!, "utf8"), /\[h_aaaaaaaaaaaaaaaa\]/u);
  assert.deepEqual(db.hotSnapshot().entries.map((entry) => [entry.id, entry.priority, entry.position]), [
    ["h_aaaaaaaaaaaaaaaa", 90, 0],
    ["h_bbbbbbbbbbbbbbbb", 60, 1],
    [db.hotSnapshot().entries[2]!.id, 50, 2],
  ]);
  assert.equal(db.hotSnapshot().text, "- Never use em dashes.\n- Prefer plain English.\n- Hand-written rule.");

  const second = await migrateLegacyHot(db, directory);
  assert.equal(second.status, "already");
  assert.equal(db.hotSnapshot().entries.length, 3);
});

test("duplicate content merges but duplicate explicit ids fail without touching the file", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "memoria.sqlite");
  const file = join(directory, "MEMORY.md");
  writeFileSync(file, "- Same rule.\n- Same rule.\n");
  const db = new MemoryDatabase(path);
  t.after(() => db.close());
  const migrated = await migrateLegacyHot(db, directory);
  assert.equal(migrated.status, "migrated");
  assert.equal(db.hotSnapshot().entries.length, 1);

  const broken = join(directory, "broken");
  mkdirSync(broken);
  const brokenDbPath = join(broken, "memoria.sqlite");
  writeFileSync(join(broken, "MEMORY.md"), "- [h_duplicate] [p=10] One.\n- [h_duplicate] [p=20] Two.\n");
  const brokenDb = new MemoryDatabase(brokenDbPath);
  t.after(() => brokenDb.close());
  await assert.rejects(migrateLegacyHot(brokenDb, broken), (error: unknown) => (error as { code?: string }).code === "hot_migration");
  assert.equal(existsSync(join(broken, "MEMORY.md")), true);
  assert.equal(brokenDb.hotSnapshot().entries.length, 0);
  assert.equal(brokenDb.hotMigration(), undefined);
});

test("oversized legacy files evict the lowest priority and archive it as a durable fact", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "memoria.sqlite");
  writeFileSync(join(directory, "MEMORY.md"), [
    `- [h_low] [p=10] ${"low ".repeat(1_400)}`,
    `- [h_high] [p=90] ${"high ".repeat(500)}`,
  ].join("\n"));
  const db = new MemoryDatabase(path);
  t.after(() => db.close());
  const result = await migrateLegacyHot(db, directory);
  assert.equal(result.status, "migrated");
  assert.equal(result.archived, 1);
  assert.equal(db.hotSnapshot().entries.length, 1);
  assert.equal(db.hotSnapshot().entries[0]?.id, "h_high");
  assert.equal(db.search("hot-archive").results.length, 1);
});

test("a symlinked legacy file is refused and left untouched", async (t) => {
  const directory = await temporary(t);
  const outside = join(directory, "outside.md");
  writeFileSync(outside, "- Should not be imported.\n");
  symlinkSync(outside, join(directory, "MEMORY.md"));
  const db = new MemoryDatabase(join(directory, "memoria.sqlite"));
  t.after(() => db.close());
  await assert.rejects(migrateLegacyHot(db, directory), (error: unknown) => (error as { code?: string }).code === "hot_migration");
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(join(directory, "MEMORY.md")), true);
  assert.equal(db.hotSnapshot().entries.length, 0);
});

test("no legacy file records an absent marker, and a later stray file is retired without import", async (t) => {
  const directory = await temporary(t);
  const db = new MemoryDatabase(join(directory, "memoria.sqlite"));
  t.after(() => db.close());
  const first = await migrateLegacyHot(db, directory);
  assert.equal(first.status, "absent");
  assert.equal(db.hotMigration()?.status, "absent");

  writeFileSync(join(directory, "MEMORY.md"), "- A stray rule.\n");
  const second = await migrateLegacyHot(db, directory);
  assert.equal(second.status, "already");
  assert.equal(db.hotSnapshot().entries.length, 0);
  assert.equal(existsSync(join(directory, "MEMORY.md")), false);
  assert.ok(second.backup && existsSync(second.backup));
});

test("version 1 and version 2 databases gain the hot schema and a private pre-v3 snapshot", async (t) => {
  for (const version of [1, 2] as const) {
    const directory = await temporary(t);
    const path = join(directory, "memoria.sqlite");
    legacyVersion(path, version);
    const raw = new DatabaseSync(path);
    try {
      raw.prepare("INSERT INTO memories(id,content,tags,tag_text,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run("m_legacy", "A durable legacy fact.", "[]", "", "", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    } finally { raw.close(); }
    const db = new MemoryDatabase(path);
    try {
      assert.equal(db.get("m_legacy").content, "A durable legacy fact.");
      assert.equal(db.hotSnapshot().entries.length, 0);
      const check = new DatabaseSync(path);
      try { assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 3); }
      finally { check.close(); }
      const backups = join(directory, "backups");
      assert.equal(existsSync(backups), true);
      assert.match(readFileSync(join(backups, readdirSync(backups)[0]!), "utf8"), /SQLite format 3/u);
    } finally { db.close(); }
  }
});

test("concurrent migration imports once and keeps the original file safe", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "memoria.sqlite");
  writeFileSync(join(directory, "MEMORY.md"), "- Concurrent rule.\n");
  const first = new MemoryDatabase(path);
  const second = new MemoryDatabase(path);
  t.after(() => { first.close(); second.close(); });
  const results = await Promise.all([migrateLegacyHot(first, directory), migrateLegacyHot(second, directory)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["already", "migrated"]);
  assert.equal(first.hotSnapshot().entries.length, 1);
  assert.equal(existsSync(join(directory, "MEMORY.md")), false);
});

test("hot rows without a marker fail closed before importing the file", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "memoria.sqlite");
  const db = new MemoryDatabase(path);
  t.after(() => db.close());
  db.hotAdd("Already present.", 50);
  writeFileSync(join(directory, "MEMORY.md"), "- Legacy rule.\n");
  await assert.rejects(migrateLegacyHot(db, directory), /migration marker/u);
  assert.equal(existsSync(join(directory, "MEMORY.md")), true);
  assert.equal(db.hotSnapshot().entries.length, 1);
});

test("a repaired file migrates on the next attempt", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "memoria.sqlite");
  const file = join(directory, "MEMORY.md");
  writeFileSync(file, "- [h_duplicate] [p=10] One.\n- [h_duplicate] [p=20] Two.\n");
  const db = new MemoryDatabase(path);
  t.after(() => db.close());
  await assert.rejects(migrateLegacyHot(db, directory));
  writeFileSync(file, "- Repaired rule.\n");
  const result = await migrateLegacyHot(db, directory);
  assert.equal(result.status, "migrated");
  assert.equal(db.hotSnapshot().entries.length, 1);
  assert.equal(existsSync(file), false);
});
