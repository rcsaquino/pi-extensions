import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { MemoryDatabase } from "../src/database.ts";
import { ExpectedError } from "../src/errors.ts";
import { HotMemoryStore } from "../src/hot-memory.ts";
import { HOT_LIMIT } from "../src/text.ts";
import { temporary } from "./helpers.ts";

async function store(t: Parameters<typeof temporary>[0]) {
  const directory = await temporary(t);
  const path = join(directory, "MEMORY.md");
  const db = new MemoryDatabase(join(directory, "memoria.sqlite"));
  t.after(() => db.close());
  const hot = new HotMemoryStore(path, (entries) => { db.archive(entries, path); });
  return { directory, path, db, hot };
}

test("entire MEMORY.md fits exactly 5,000 characters; failed add/edit never changes it", async (t) => {
  const { hot, path } = await store(t);
  const first = await hot.add("x");
  const overhead = first.text.length - 1;
  const full = await hot.edit(first.memory.id, "x".repeat(HOT_LIMIT - overhead));
  assert.equal(full.characters, HOT_LIMIT);
  assert.equal((await readFile(path, "utf8")).length, HOT_LIMIT);
  await assert.rejects(hot.add("another"), (error: unknown) => error instanceof ExpectedError && error.code === "hot_capacity" && (error.details as { reason?: string }).reason === "cannot_free_space");
  await assert.rejects(hot.edit(first.memory.id, "x".repeat(HOT_LIMIT)), (error: unknown) => error instanceof ExpectedError && error.code === "hot_capacity" && (error.details as { reason?: string }).reason === "bullet_too_large");
  assert.equal(await readFile(path, "utf8"), full.text);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("more important hot memory displaces lower priority into durable SQLite", async (t) => {
  const { hot, db, path } = await store(t);
  const low = await hot.add("low ".repeat(700), 10);
  const high = await hot.add("high ".repeat(600), 90);
  assert.equal(high.archived[0]?.id, low.memory.id);
  assert.equal(high.entries.length, 1);
  assert.equal(db.search("low").results.length, 1);
  assert.ok((await readFile(path, "utf8")).length <= HOT_LIMIT);
  const deleted = await hot.delete(high.memory.id);
  assert.equal(deleted.entries.length, 0);
  assert.equal(db.search("high").results.length, 0, "explicit deletion does not archive");
});

test("archive failure leaves the previous hot file intact", async (t) => {
  const { path, hot } = await store(t);
  const original = await hot.add("a".repeat(4_000), 5);
  const broken = new HotMemoryStore(path, () => { throw new Error("disk full"); });
  await assert.rejects(broken.add("b".repeat(2_000), 90), /disk full/u);
  assert.equal(await readFile(path, "utf8"), original.text);
});

test("manual bullets get stable IDs; oversized edits are backed up and archived before repair", async (t) => {
  const { hot, path, db } = await store(t);
  await writeFile(path, "- Start every sentence with beep_boop.\n");
  const one = await hot.load();
  assert.equal(one.entries[0]?.content, "Start every sentence with beep_boop.");
  assert.equal((await hot.load()).entries[0]?.id, one.entries[0]?.id);
  const manual = `- ${"first".repeat(650)}\n- ${"second".repeat(650)}\n`;
  await writeFile(path, manual);
  const repaired = await hot.load();
  assert.ok(repaired.characters <= HOT_LIMIT);
  assert.ok(repaired.backup);
  assert.equal(await readFile(repaired.backup!, "utf8"), manual);
  assert.equal(db.search("hot-archive").results.length, 1);
  assert.ok((await readFile(path, "utf8")).length <= HOT_LIMIT);
});

test("large Unicode manual entries are archived in full without splitting surrogate pairs", async (t) => {
  const { hot, db, path } = await store(t);
  const content = "🚀".repeat(9_499) + "   spaced boundary   " + "🚀".repeat(10_501);
  await writeFile(path, `- ${content}\n`);
  const result = await hot.load();
  assert.equal(result.text, "");
  const records = db.search("hot-archive").results.map((item) => db.get(item.id)).sort((a, b) => a.source.localeCompare(b.source));
  assert.equal(records.map((item) => item.content).join(""), content);
});

test("stale updates fail and stale crashed-process locks recover", async (t) => {
  const { hot, path } = await store(t);
  const original = await hot.add("before");
  await hot.edit(original.memory.id, "after", undefined, "before");
  await assert.rejects(hot.delete(original.memory.id, "before"), /changed/u);
  await mkdir(`${path}.lock`);
  const old = new Date(Date.now() - 60_000);
  await utimes(`${path}.lock`, old, old);
  assert.equal((await hot.load()).entries[0]?.content, "after");
});

test("concurrent processes preserve every hot bullet and database fact", async (t) => {
  const { hot, db, directory } = await store(t);
  const execute = promisify(execFile);
  await Promise.all([0, 1, 2, 3].map((label) => execute(process.execPath, ["--import", "tsx", "test/fixtures/writer.ts", directory, String(label)])));
  const snapshot = await hot.load();
  assert.equal(snapshot.entries.length, 32);
  assert.equal(new Set(snapshot.entries.map((entry) => entry.content)).size, 32);
  assert.equal(db.search("Writer", "any", 50).results.length, 32);
  assert.ok(snapshot.characters <= HOT_LIMIT);
});

test("a cancelled mutation never writes after waiting in the file queue", async (t) => {
  const { path, hot } = await store(t);
  await hot.add("existing");
  const controller = new AbortController();
  const queued = new HotMemoryStore(path, () => {}, async (_path, operation) => {
    controller.abort();
    return operation();
  });
  await assert.rejects(queued.add("cancelled", 50, controller.signal), /abort/iu);
  assert.deepEqual((await hot.load()).entries.map((entry) => entry.content), ["existing"]);
});

test("repeated hot adds reuse the first entry without rewriting, archiving, or consuming capacity", async (t) => {
  const { hot, db, path } = await store(t);
  const first = await hot.add("Start every sentence with beep_boop.", 40);
  assert.equal(first.created, true);
  const bytes = await readFile(path, "utf8");
  const repeated = await hot.add("Start every sentence with beep_boop.", 99);
  assert.equal(repeated.created, false);
  assert.equal(repeated.memory.id, first.memory.id);
  assert.equal(repeated.memory.priority, 40, "a repeated add must not reprioritize the existing entry");
  assert.equal(repeated.memory.content, first.memory.content);
  assert.deepEqual(repeated.archived, []);
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.equal(db.search("hot-archive").results.length, 0);
  const different = await hot.add("Start every sentence with beep_boop now.", 99);
  assert.equal(different.created, true);
  assert.notEqual(different.memory.id, first.memory.id);
});

test("a repeated hot add succeeds when the file is exactly at the cap", async (t) => {
  const { hot, path } = await store(t);
  const first = await hot.add("x");
  const body = "x".repeat(HOT_LIMIT - (first.text.length - 1));
  const full = await hot.edit(first.memory.id, body);
  assert.equal(full.characters, HOT_LIMIT);
  const repeated = await hot.add(body, 100);
  assert.equal(repeated.created, false);
  assert.equal(repeated.memory.id, first.memory.id);
  assert.equal(await readFile(path, "utf8"), full.text);
});

test("same-process parallel duplicate adds produce one entry and exactly one created=true", async (t) => {
  const { hot } = await store(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => hot.add("Parallel identical startup rule.", 60)));
  assert.equal(new Set(results.map((result) => result.memory.id)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal((await hot.load()).entries.length, 1);
});

test("separate processes adding the same hot content produce one durable entry", async (t) => {
  const { hot, directory } = await store(t);
  const execute = promisify(execFile);
  const content = "Cross-process identical startup rule.";
  const writers = await Promise.all([0, 1, 2, 3].map(() => execute(process.execPath, [
    "--import", "tsx", "test/fixtures/duplicate-hot-writer.ts", directory, content,
  ])));
  const results = writers.flatMap(({ stdout }) => JSON.parse(stdout) as Array<{ id: string; created: boolean }>);
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  const snapshot = await hot.load();
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0]?.content, content);
});

test("hot content preserves internal spacing and rejects line separators explicitly", async (t) => {
  const { hot, path } = await store(t);
  const quoted = 'Always separate fields with "a  b".';
  const added = await hot.add(`  ${quoted}  `);
  assert.equal(added.memory.content, quoted);
  assert.equal(await readFile(path, "utf8"), `- [${added.memory.id}] [p=50] ${quoted}\n`);
  assert.equal((await hot.load()).entries[0]?.content, quoted);
  const tabbed = `tab\there café 東京 🚀`;
  const withTab = await hot.add(tabbed);
  assert.equal(withTab.memory.content, tabbed);
  assert.match(await readFile(path, "utf8"), /tab\there café 東京 🚀/u);
  const before = await readFile(path, "utf8");
  for (const separator of ["\r", "\n", "\u2028", "\u2029"]) {
    await assert.rejects(hot.add(`first${separator}second`), (error: unknown) => error instanceof ExpectedError && error.code === "invalid_input");
  }
  await assert.rejects(hot.add(" \t "), (error: unknown) => error instanceof ExpectedError && error.code === "invalid_input");
  await assert.rejects(hot.add("with\0nul"), (error: unknown) => error instanceof ExpectedError && error.code === "invalid_input");
  await assert.rejects(hot.add("x", 101), (error: unknown) => error instanceof ExpectedError && error.code === "invalid_input");
  assert.equal(await readFile(path, "utf8"), before);
});

test("whitespace-sensitive expected_content checks accept the current value and reject another", async (t) => {
  const { hot } = await store(t);
  const added = await hot.add('Keep "two  spaces" exactly.');
  await assert.rejects(hot.edit(added.memory.id, "changed", undefined, 'Keep "two spaces" exactly.'), (error: unknown) => error instanceof ExpectedError && error.code === "conflict");
  const edited = await hot.edit(added.memory.id, "changed", undefined, 'Keep "two  spaces" exactly.');
  assert.equal(edited.memory.content, "changed");
  await assert.rejects(hot.delete(added.memory.id, 'Keep "two spaces" exactly.'), (error: unknown) => error instanceof ExpectedError && error.code === "conflict");
});

test("hot edits cannot change an entry into another entry's content", async (t) => {
  const { hot, path } = await store(t);
  const first = await hot.add("First distinct rule.");
  const second = await hot.add("Second distinct rule.");
  const before = await readFile(path, "utf8");
  await assert.rejects(hot.edit(first.memory.id, second.memory.content), (error: unknown) => error instanceof ExpectedError && error.code === "duplicate_hot_content"
    && (error.details as { id?: string }).id === first.memory.id && (error.details as { existing_id?: string }).existing_id === second.memory.id);
  assert.equal(await readFile(path, "utf8"), before);
  const unchanged = await hot.edit(first.memory.id, first.memory.content, 70);
  assert.equal(unchanged.memory.priority, 70);
});

test("pre-existing managed duplicates are preserved and the first entry is returned", async (t) => {
  const { hot, path } = await store(t);
  const duplicate = "Legacy duplicated startup rule.";
  await writeFile(path, `- [h_first0000000000] [p=50] ${duplicate}\n- [h_second000000000] [p=50] ${duplicate}\n`);
  const before = await readFile(path, "utf8");
  const result = await hot.add(duplicate, 100);
  assert.equal(result.created, false);
  assert.equal(result.memory.id, "h_first0000000000");
  assert.equal(result.memory.priority, 50);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await hot.load()).entries.length, 2);
});

test("capacity diagnostics report exact serialized sizes and leave file and archive unchanged", async (t) => {
  const { hot, db, path } = await store(t);
  const low = await hot.add("l".repeat(1_000), 10);
  const keeper = await hot.add("h".repeat(200), 80);
  const before = await readFile(path, "utf8");
  const big = "b".repeat(4_800);
  let failure: ExpectedError | undefined;
  try { await hot.add(big, 50); } catch (error) { failure = error as ExpectedError; }
  const details = failure!.details as Record<string, any>;
  assert.equal(failure?.code, "hot_capacity");
  assert.equal(details.reason, "cannot_free_space");
  assert.equal(details.limit, HOT_LIMIT);
  assert.equal(details.current_characters, (await hot.load()).characters);
  assert.equal(details.proposed_characters, details.current_characters + details.proposed_entry.characters);
  assert.equal(details.over_by, details.proposed_characters - HOT_LIMIT);
  assert.equal(details.remaining, HOT_LIMIT - details.current_characters);
  assert.deepEqual(details.eligible.map((entry: { id: string }) => entry.id), [low.memory.id]);
  assert.equal(details.eligible_characters, `- [${low.memory.id}] [p=10] ${low.memory.content}\n`.length);
  assert.equal(details.shortfall_after_eligible_eviction, 62);
  assert.equal(details.live_file_unchanged, true);
  for (const entry of details.entries) {
    assert.equal(entry.characters, `- [${entry.id}] [p=${entry.priority}] ${entry.content}\n`.length);
  }
  assert.deepEqual(details.entries.map((entry: { id: string }) => entry.id).sort(), [low.memory.id, keeper.memory.id].sort());
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(db.search("hot-archive").results.length, 0);
  assert.equal((await hot.load()).entries.length, 2);
});

test("a failed edit with lower-priority candidates still cannot free enough space", async (t) => {
  const { hot, db, path } = await store(t);
  const low = await hot.add("l".repeat(100), 10);
  const anchor = await hot.add("k".repeat(4_000), 80);
  const editMe = await hot.add("m".repeat(300), 50);
  const before = await readFile(path, "utf8");
  let failure: ExpectedError | undefined;
  try { await hot.edit(editMe.memory.id, "e".repeat(3_000)); } catch (error) { failure = error as ExpectedError; }
  const details = failure!.details as Record<string, any>;
  assert.equal(failure?.code, "hot_capacity");
  assert.equal(details.reason, "cannot_free_space");
  assert.equal(details.proposed_entry.content, "e".repeat(3_000));
  assert.deepEqual(details.eligible.map((entry: { id: string }) => entry.id), [low.memory.id]);
  assert.equal(details.shortfall_after_eligible_eviction, 2_062);
  assert.equal(details.live_file_unchanged, true);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(db.search("hot-archive").results.length, 0);
  assert.equal((await hot.load()).entries.length, 3);
  assert.ok(anchor.memory.id && editMe.memory.id);
});

test("capacity sizes count UTF-16 units for emoji exactly as serialization does", async (t) => {
  const { hot, path } = await store(t);
  const added = await hot.add("short");
  const emoji = "🚀".repeat(2_490);
  assert.equal([...emoji].length, 2_490);
  assert.equal(emoji.length, 4_980);
  const before = await readFile(path, "utf8");
  let failure: ExpectedError | undefined;
  try { await hot.edit(added.memory.id, emoji); } catch (error) { failure = error as ExpectedError; }
  const details = failure!.details as Record<string, any>;
  assert.equal(failure?.code, "hot_capacity");
  assert.equal(details.reason, "bullet_too_large");
  assert.equal(details.proposed_entry.characters, `- [${added.memory.id}] [p=50] ${emoji}\n`.length);
  assert.ok(details.proposed_entry.characters > HOT_LIMIT);
  assert.equal(await readFile(path, "utf8"), before);
});

test("expected hot failures expose stable codes and useful details", async (t) => {
  const { hot } = await store(t);
  const added = await hot.add("A stable rule.");
  await assert.rejects(hot.edit("h_missing", "x"), (error: unknown) => error instanceof ExpectedError && error.code === "not_found" && (error.details as { id?: string }).id === "h_missing");
  await assert.rejects(hot.delete("h_missing"), (error: unknown) => error instanceof ExpectedError && error.code === "not_found");
  await assert.rejects(hot.edit(added.memory.id, "x", undefined, "wrong"), (error: unknown) => error instanceof ExpectedError && error.code === "conflict"
    && (error.details as { current_content?: string }).current_content === "A stable rule.");
  const oversized = `line one${String.fromCharCode(10)}line two`;
  await assert.rejects(hot.add(oversized), (error: unknown) => error instanceof ExpectedError && error.code === "invalid_input" && /single line/u.test(error.message));
});
