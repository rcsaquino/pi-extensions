import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/database.ts";
import { temporary } from "./helpers.ts";

async function database(t: test.TestContext): Promise<MemoryDatabase> {
  const root = await temporary(t);
  const db = new MemoryDatabase(join(root, "memoria.sqlite"));
  t.after(() => db.close());
  return db;
}

test("rendered hot rules fit exactly 5,000 characters and a failed add changes nothing", async (t) => {
  const db = await database(t);
  const max = db.hotAdd("x".repeat(4_998), 50);
  assert.equal(max.characters, 5_000);
  assert.equal(max.remaining, 0);
  assert.equal(max.text, `- ${"x".repeat(4_998)}`);
  assert.doesNotMatch(max.text, /h_[0-9a-f]|\[p=/u);

  assert.throws(() => db.hotAdd("another rule", 50), (error: unknown) => {
    const value = error as { code?: string; details?: Record<string, unknown> };
    assert.equal(value.code, "hot_capacity");
    assert.equal(value.details?.unchanged, true);
    assert.equal(value.details?.over_by, 15);
    return true;
  });
  assert.deepEqual(db.hotSnapshot().entries.map((entry) => entry.id), [max.memory.id]);
  assert.equal(db.search().results.length, 1);
});

test("a higher-priority rule displaces lower-priority rules and archives them", async (t) => {
  const db = await database(t);
  const low = db.hotAdd("low ".repeat(700), 10);
  const high = db.hotAdd("high ".repeat(700), 90);
  assert.equal(low.entries.length, 1);
  assert.equal(high.entries.length, 1);
  assert.equal(high.archived.length, 1);
  assert.equal(high.archived[0]?.id, low.memory.id);

  const archived = db.search("hot-archive");
  assert.equal(archived.results.length, 1);
  assert.deepEqual((archived.results[0] as { tags: string[] }).tags, ["hot-archive"]);
  assert.equal(db.hotSnapshot().entries.length, 1);
});

test("duplicate adds reuse, duplicate edits reject, and stale expected_content conflicts", async (t) => {
  const db = await database(t);
  const first = db.hotAdd("Prefer plain English.", 50);
  const repeated = db.hotAdd("Prefer plain English.", 80);
  assert.equal(repeated.created, false);
  assert.equal(repeated.memory.id, first.memory.id);
  assert.equal(repeated.memory.priority, 50);
  assert.equal(db.hotSnapshot().entries.length, 1);

  const second = db.hotAdd("Avoid jargon.", 50);
  assert.throws(() => db.hotEdit(second.memory.id, "Prefer plain English."), (error: unknown) => (error as { code?: string }).code === "duplicate_hot_content");
  assert.throws(() => db.hotEdit(first.memory.id, undefined, 80, "stale"), (error: unknown) => (error as { code?: string }).code === "conflict");
  const edited = db.hotEdit(first.memory.id, "Prefer direct English.", 80, "Prefer plain English.");
  assert.equal(edited.memory.id, first.memory.id);
  assert.equal(edited.memory.revision, 2);
  assert.equal(edited.memory.position, first.memory.position);
  assert.equal(edited.text, "- Prefer direct English.\n- Avoid jargon.");
});

test("explicit deletion does not archive and preserves the remaining order", async (t) => {
  const db = await database(t);
  const one = db.hotAdd("One", 10);
  const two = db.hotAdd("Two", 20);
  const three = db.hotAdd("Three", 30);
  const deleted = db.hotDelete(two.memory.id, "Two");
  assert.equal(deleted.deleted.id, two.memory.id);
  assert.equal(db.hotSnapshot().text, "- One\n- Three");
  assert.deepEqual(db.hotSnapshot().entries.map((entry) => entry.id), [one.memory.id, three.memory.id]);
  assert.equal(db.search("hot-archive").results.length, 0);
});

test("a single rule over the rendered cap is rejected without a row or archive", async (t) => {
  const db = await database(t);
  assert.throws(() => db.hotAdd("y".repeat(4_999), 100), (error: unknown) => (error as { code?: string }).code === "hot_capacity");
  assert.equal(db.hotSnapshot().entries.length, 0);
  assert.equal(db.search().results.length, 0);
});

test("hot search returns the rule and its h_ id while the prompt text stays metadata-free", async (t) => {
  const db = await database(t);
  const added = db.hotAdd("Never use em dashes in written output.", 90);
  const result = db.search("em dashes");
  assert.equal(result.results.length, 1);
  const row = result.results[0]!;
  assert.equal(row.store, "hot");
  assert.equal(row.id, added.memory.id);
  assert.equal(row.priority, 90);
  assert.match(JSON.stringify(result), new RegExp(added.memory.id, "u"));
  assert.doesNotMatch(db.hotSnapshot().text, new RegExp(added.memory.id, "u"));
});

test("migrated hot rows keep their position and IDs through edits", async (t) => {
  const db = await database(t);
  const a = db.hotAdd("A", 10);
  const b = db.hotAdd("B", 20);
  const c = db.hotAdd("C", 30);
  assert.deepEqual(db.hotSnapshot().entries.map((entry) => [entry.id, entry.position]), [
    [a.memory.id, 0], [b.memory.id, 1], [c.memory.id, 2],
  ]);
  db.hotEdit(b.memory.id, "B2", 20);
  assert.deepEqual(db.hotSnapshot().entries.map((entry) => [entry.id, entry.position]), [
    [a.memory.id, 0], [b.memory.id, 1], [c.memory.id, 2],
  ]);
});

test("unicode content counts UTF-16 units in the rendered cap", async (t) => {
  const db = await database(t);
  const emoji = "😀".repeat(2_499);
  const result = db.hotAdd(emoji, 50);
  assert.equal(result.characters, 5_000);
  assert.equal(result.remaining, 0);
  assert.throws(() => db.hotAdd("x", 50), (error: unknown) => (error as { code?: string }).code === "hot_capacity");
});

test("combined search paginates hot first, then long-term, without duplicates", async (t) => {
  const db = await database(t);
  const hotA = db.hotAdd("Hot rule A", 10);
  const hotB = db.hotAdd("Hot rule B", 20);
  const hotC = db.hotAdd("Hot rule C", 30);
  const longA = db.add({ content: "Long rule A", tags: ["long"] }).memory;
  const longB = db.add({ content: "Long rule B", tags: ["long"] }).memory;

  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = db.search("rule", "any", 2, offset);
    seen.push(...page.results.map((row) => row.id));
    offset = page.next_offset;
  }
  assert.deepEqual(seen.slice(0, 3), [hotA.memory.id, hotB.memory.id, hotC.memory.id]);
  assert.deepEqual(new Set(seen.slice(3)), new Set([longA.id, longB.id]));
  assert.equal(new Set(seen).size, seen.length);

  const tagged = db.search("rule", "any", 20, 0, { tags: ["long"] });
  assert.deepEqual(new Set(tagged.results.map((row) => row.id)), new Set([longA.id, longB.id]));
  assert.ok(tagged.results.every((row) => row.store === "long_term"));

  const first = db.search("", "any", 2, 0);
  assert.deepEqual(first.results.map((row) => row.id), [hotA.memory.id, hotB.memory.id]);
  const second = db.search("", "any", 2, 2);
  assert.equal(second.results[0]?.id, hotC.memory.id);
  assert.ok([longA.id, longB.id].includes(second.results[1]?.id ?? ""));
});
