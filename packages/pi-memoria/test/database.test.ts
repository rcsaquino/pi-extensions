import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { MemoryDatabase } from "../src/database.ts";
import { temporary } from "./helpers.ts";

test("SQLite facts persist, search content/tags/source, and update FTS atomically", async (t) => {
  const path = join(await temporary(t), "memoria.sqlite");
  let db = new MemoryDatabase(path);
  t.after(() => db.close());
  const { memory: original, created } = db.add({ content: "The user likes apples.", tags: ["fruit", "preference"], source: "/sessions/earlier.jsonl:27" });
  assert.equal(created, true);
  for (const query of ["apple", "fruit", "earlier", "appl"]) assert.equal(db.search(query).results[0]?.id, original.id);
  db.close();
  db = new MemoryDatabase(path);
  assert.deepEqual(db.get(original.id), original);
  const updated = db.edit(original.id, { content: "The user prefers pears.", tags: ["food"] }, 1);
  assert.equal(updated.revision, 2);
  assert.equal(db.search("apples").results.length, 0);
  assert.equal(db.search("pear").results[0]?.id, original.id);
  assert.throws(() => db.edit(original.id, { content: "stale" }, 1), /changed/u);
  assert.throws(() => db.delete(original.id, 1), /changed/u);
  db.delete(original.id, 2);
  assert.equal(db.search("pear").results.length, 0);
  assert.throws(() => db.get(original.id), /does not exist/u);
});

test("repeated facts reuse the original memory across sessions without overwriting metadata", async (t) => {
  const path = join(await temporary(t), "memoria.sqlite");
  let db = new MemoryDatabase(path);
  t.after(() => db.close());
  const { memory: original } = db.add({ content: "The user likes apples.", tags: ["fruit"], source: "first-session#entry" });
  db.close();
  db = new MemoryDatabase(path);
  const repeated = db.add({ content: "  The user likes apples.\n", tags: ["preferences"], source: "another-session#entry" });
  assert.deepEqual(repeated, { memory: original, created: false });
  assert.deepEqual(db.get(original.id), original);
  assert.equal(db.search().results.length, 1);
  assert.equal(db.search("fruit").results[0]?.id, original.id);
  assert.equal(db.search("preferences").results.length, 0, "repeating a fact must not silently edit its tags");
  assert.throws(() => db.add({ content: original.content, tags: [" "] }), /tag/u);
  assert.throws(() => db.add({ content: original.content, source: "x".repeat(2_001) }), /source/u);

  const corrected = db.edit(original.id, { content: "The user dislikes apples." }, 1);
  assert.deepEqual(db.add({ content: corrected.content }), { memory: corrected, created: false });
  assert.equal(db.search("dislikes").results[0]?.id, original.id);
  const { memory: different } = db.add({ content: "The user likes apples." });
  assert.notEqual(different.id, original.id, "related but different facts must not be merged");
  assert.equal(db.search().results.length, 2);
});

test("concurrent processes adding the same fact produce one durable memory", async (t) => {
  const directory = await temporary(t);
  const db = new MemoryDatabase(join(directory, "memoria.sqlite"));
  t.after(() => db.close());
  const execute = promisify(execFile);
  const writers = await Promise.all([0, 1, 2, 3].map((label) => execute(process.execPath, [
    "--import", "tsx", "test/fixtures/duplicate-writer.ts", directory, String(label),
  ])));
  const results = writers.flatMap(({ stdout }) => JSON.parse(stdout) as { id: string; created: boolean }[]);
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(db.search().results.length, 1);
  assert.equal(db.search("apples").results[0]?.id, results[0]?.id);
});

test("upgrading a version 1 database preserves existing duplicates, archives, and search indexes", async (t) => {
  const path = join(await temporary(t), "memoria.sqlite");
  let db = new MemoryDatabase(path);
  t.after(() => db.close());
  const { memory: original } = db.add({ content: "The user likes apples.", tags: ["fruit"], source: "first-session" });
  const archiveId = db.archive([{ id: "h_archived", content: original.content }], "MEMORY.md")[0]!;
  db.rememberRoots(["/tmp/legacy-sessions"]);
  db.close();

  const raw = new DatabaseSync(path);
  try {
    // Recreate the previous on-disk schema with two pre-existing copies of a fact.
    raw.exec("DROP INDEX memories_content; PRAGMA user_version=1;");
    raw.prepare(`INSERT INTO memories(id,content,tags,tag_text,source,created_at,updated_at)
      SELECT ?,content,tags,tag_text,?,created_at,updated_at FROM memories WHERE id=?`)
      .run("m_legacy_duplicate", "second-session", original.id);
  } finally { raw.close(); }

  db = new MemoryDatabase(path);
  assert.deepEqual(db.add({ content: original.content }), { memory: original, created: false });
  assert.equal(db.search("apples").results.length, 3);
  assert.equal(db.get("m_legacy_duplicate").source, "second-session");
  assert.deepEqual(db.get(archiveId).tags, ["hot-archive"]);
  assert.deepEqual(db.roots(), ["/tmp/legacy-sessions"]);
  db.edit(original.id, { content: "The user likes pears." });
  assert.equal(db.search("pears").results[0]?.id, original.id);
  assert.equal(db.search("apples").results.length, 2);
  db.delete(archiveId);
  assert.equal(db.add({ content: original.content }).memory.id, "m_legacy_duplicate");
  db.close();
  db = new MemoryDatabase(path);
  assert.equal(db.search().results.length, 2);
  const check = new DatabaseSync(path);
  try { assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 2); }
  finally { check.close(); }
});

test("a failed insert rolls back before another fact can be saved", async (t) => {
  const path = join(await temporary(t), "memoria.sqlite");
  const db = new MemoryDatabase(path);
  t.after(() => db.close());
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`CREATE TRIGGER reject_insert AFTER INSERT ON memories WHEN new.content='fail this insert'
      BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;`);
  } finally { raw.close(); }
  assert.throws(() => db.add({ content: "fail this insert" }), /injected storage failure/u);
  assert.equal(db.search("fail").results.length, 0);
  assert.equal(db.search().results.length, 0);
  const saved = db.add({ content: "A subsequent fact persists." });
  assert.equal(saved.created, true);
  assert.equal(db.search("subsequent").results[0]?.id, saved.memory.id);
});

test("query modes handle symbols, accents, multilingual text and FTS metacharacters", async (t) => {
  const db = new MemoryDatabase(join(await temporary(t), "memoria.sqlite"));
  t.after(() => db.close());
  const { memory: a } = db.add({ content: "C++ uses 100% _symbols_; Café 東京 🚀", tags: ["code", 'quoted "tag"', "C:\\project", "green\nblue"] });
  const { memory: b } = db.add({ content: "red green blue" });
  db.add({ content: "red yellow" });
  assert.equal(db.search("C++", "literal").results[0]?.id, a.id);
  for (const text of ["100%", "_symbols_", "CAFÉ", "東京", "🚀"]) assert.equal(db.search(text, "literal").results[0]?.id, a.id);
  assert.equal(db.search("cafe").results[0]?.id, a.id);
  for (const query of ['quoted "tag"', "C:\\project"]) assert.equal(db.search(query, "literal").results[0]?.id, a.id);
  assert.deepEqual(new Set(db.search("blue").results.map((value) => value.id)), new Set([a.id, b.id]));
  assert.equal(db.search("red nonexistent", "any").results.length, 2);
  assert.equal(db.search("red blue", "all").results[0]?.id, b.id);
  assert.equal(db.search("green blue", "phrase").results.length, 2);
  assert.equal(db.search("blue green", "phrase").results.length, 0);
  for (const query of ['" OR NOT * : ( )', "'; DROP TABLE memories; --", "!!!"]) assert.doesNotThrow(() => db.search(query));
  assert.equal(db.search().results.length, 3);
});

test("every memory is reachable through pagination without a hidden top-k cutoff", async (t) => {
  const db = new MemoryDatabase(join(await temporary(t), "memoria.sqlite"));
  t.after(() => db.close());
  const expected = Array.from({ length: 123 }, (_, i) => db.add({ content: `batch recall item ${i}` }).memory.id);
  for (const query of ["batch", "", "recall item"]) {
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = db.search(query, query === "recall item" ? "literal" : "any", 7, offset);
      seen.push(...page.results.map((item) => item.id));
      offset = page.next_offset;
    }
    assert.deepEqual(seen.sort(), expected.toSorted());
  }
  assert.throws(() => db.search("", "any", 0), /limit/u);
  assert.throws(() => db.add({ content: " " }), /content/u);
});

test("two database connections see each other's changes; archived hot entries survive retries", async (t) => {
  const path = join(await temporary(t), "memoria.sqlite");
  const first = new MemoryDatabase(path);
  const second = new MemoryDatabase(path);
  t.after(() => { first.close(); second.close(); });
  const { memory: value } = first.add({ content: "shared memory" });
  assert.equal(second.get(value.id).content, "shared memory");
  second.edit(value.id, { content: "cross-session update" });
  assert.equal(first.search("cross").results[0]?.id, value.id);
  const items = [{ id: "h_test", content: "startup preference" }];
  first.archive(items, "/global/MEMORY.md");
  second.archive(items, "/global/MEMORY.md");
  assert.equal(first.search("hot-archive").results.length, 1);
  second.rememberRoots(["/tmp/root", "/tmp/root"]);
  assert.deepEqual(first.roots(), ["/tmp/root"]);
});

test("unknown future schema fails without overwriting data", async (t) => {
  const path = join(await temporary(t), "memoria.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version=999; CREATE TABLE important(value TEXT); INSERT INTO important VALUES('preserve');");
  raw.close();
  assert.throws(() => new MemoryDatabase(path), /newer/u);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("SELECT value FROM important").get()?.value, "preserve");
  check.close();
});

test("alias expansion uses the existing FTS index without hiding literal matches or pagination", async (t) => {
  const directory = await temporary(t);
  const db = new MemoryDatabase(join(directory, "memoria.sqlite"));
  t.after(() => db.close());
  const aliasOnly = db.add({ content: "The Kubernetes cluster runs in fra1." }).memory;
  const literal = db.add({ content: "k8s notes are stored here." }).memory;
  const both = db.add({ content: "kubernetes and k8s together" }).memory;
  const expanded = db.search("k8s");
  assert.deepEqual(expanded.results.map((row) => row.id).sort(), [aliasOnly.id, literal.id, both.id].sort());
  assert.equal(expanded.alias_expansion_enabled, true);
  assert.deepEqual(expanded.expansions, [{ term: "k8s", aliases: ["kubernetes"] }]);
  const unexpanded = db.search("k8s", "any", 20, 0, { expandAliases: false });
  assert.deepEqual(unexpanded.results.map((row) => row.id).sort(), [literal.id, both.id].sort());
  assert.equal(unexpanded.alias_expansion_enabled, false);
  assert.deepEqual(unexpanded.expansions, []);
  assert.deepEqual(db.search("k8s", "literal").results.map((row) => row.id).sort(), [literal.id, both.id].sort());
  const phrase = db.search("k8s", "phrase");
  assert.equal(phrase.alias_expansion_enabled, false);
  assert.deepEqual(phrase.results.map((row) => row.id).sort(), [literal.id, both.id].sort());
  assert.equal(db.search("", "any").alias_expansion_enabled, false);
  // `all` requires every original concept but accepts an alias for an individual concept.
  assert.deepEqual(db.search("k8s cluster", "all").results.map((row) => row.id), [aliasOnly.id]);
  assert.equal(db.search("k8s missing", "all").results.length, 0);
  // A row matching both an original term and an alias appears once across pages.
  for (let i = 0; i < 10; i++) db.add({ content: `kubernetes pagination item ${i}`, tags: ["page"] });
  for (let i = 0; i < 10; i++) db.add({ content: `k8s pagination item ${i}`, tags: ["page"] });
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = db.search("k8s", "any", 7, offset, { tags: ["page"] });
    seen.push(...page.results.map((row) => row.id));
    offset = page.next_offset;
  }
  assert.equal(seen.length, 20);
  assert.equal(new Set(seen).size, 20);
});

test("a user synonyms file overrides, disables, and reloads per database instance", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "synonyms.json");
  const databasePath = join(directory, "memoria.sqlite");
  await writeFile(path, JSON.stringify({ k8s: ["pods"], prefs: [] }));
  const first = new MemoryDatabase(databasePath, path);
  const pods = first.add({ content: "pods are running" }).memory;
  const cluster = first.add({ content: "kubernetes cluster" }).memory;
  assert.deepEqual(first.search("k8s").results.map((row) => row.id), [pods.id]);
  assert.equal(first.search("prefs").results.length, 0, "an empty array disables the built-in alternatives");
  await writeFile(path, JSON.stringify({ k8s: ["kubernetes"] }));
  assert.deepEqual(first.search("k8s").results.map((row) => row.id), [pods.id], "the instance keeps its cached configuration");
  first.close();
  const second = new MemoryDatabase(databasePath, path);
  t.after(() => second.close());
  assert.deepEqual(second.search("k8s").results.map((row) => row.id), [cluster.id], "recreating the database reloads the file");
  await writeFile(path, "{not json");
  second.close();
  const third = new MemoryDatabase(databasePath, path);
  t.after(() => third.close());
  const fallback = third.search("k8s");
  assert.deepEqual(fallback.results.map((row) => row.id), [cluster.id]);
  assert.ok(fallback.warnings.some((warning) => warning.includes("not valid JSON")));
});

test("exact tag filters apply in every SQL branch before pagination and fallback", async (t) => {
  const directory = await temporary(t);
  const db = new MemoryDatabase(join(directory, "memoria.sqlite"));
  t.after(() => db.close());
  const both = db.add({ content: "shared alpha", tags: ["ops", "ci"] }).memory;
  const extra = db.add({ content: "shared beta mentions ops", tags: ["ops-extra"], source: "ops" }).memory;
  const ciOnly = db.add({ content: "shared gamma", tags: ["ci"] }).memory;
  const upper = db.add({ content: "deploy note upper", tags: ["Deploy"] }).memory;
  const lower = db.add({ content: "deploy note lower", tags: ["deploy"] }).memory;
  const special = db.add({ content: "special tag row", tags: ["C++", "a b", 'quote"tag', "per%cent", "under_score", "back\\slash"] }).memory;

  assert.deepEqual(db.search("shared", "any", 20, 0, { tags: ["ops", "ci"] }).results.map((row) => row.id), [both.id]);
  assert.deepEqual(db.search("shared", "any", 20, 0, { tags: ["ops"] }).results.map((row) => row.id), [both.id]);
  assert.ok(db.search("ops", "literal", 20, 0, { tags: ["ops"] }).results.every((row) => row.id !== extra.id), "content and source mentions are not tag matches");
  assert.deepEqual(db.search("shared", "any", 20, 0, { tags: ["ops-extra"] }).results.map((row) => row.id), [extra.id]);
  assert.deepEqual(db.search("", "any", 20, 0, { tags: ["ci"] }).results.map((row) => row.id).sort(), [both.id, ciOnly.id].sort());
  assert.deepEqual(db.search("shared alpha", "phrase", 20, 0, { tags: ["ops", "ci"] }).results.map((row) => row.id), [both.id]);
  assert.deepEqual(db.search("shared gamma", "literal", 20, 0, { tags: ["ci"] }).results.map((row) => row.id), [ciOnly.id]);
  assert.deepEqual(db.search("deploy", "any", 20, 0, { tags: ["Deploy"] }).results.map((row) => row.id), [upper.id]);
  assert.deepEqual(db.search("deploy", "any", 20, 0, { tags: ["deploy"] }).results.map((row) => row.id), [lower.id]);
  for (const tag of special.tags) assert.deepEqual(db.search("special", "any", 20, 0, { tags: [tag] }).results.map((row) => row.id), [special.id], tag);
  assert.equal(db.search("special", "any", 20, 0, { tags: ["C#"] }).results.length, 0);
  const deduped = db.search("shared", "any", 20, 0, { tags: [" ops ", "ops"] });
  assert.deepEqual(deduped.tags, ["ops"]);
  assert.equal(deduped.results.length, 1);
  assert.equal(db.search("shared", "any", 20, 0, { tags: [] }).results.length, 3);
  assert.throws(() => db.search("shared", "any", 20, 0, { tags: [""] }), /tag/u);
  assert.throws(() => db.search("shared", "any", 20, 0, { tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }), /30 tags/u);

  const injection = db.add({ content: "injected tag row", tags: ["x'); DROP TABLE memories; --"] }).memory;
  assert.deepEqual(db.search("injected", "any", 20, 0, { tags: ["x'); DROP TABLE memories; --"] }).results.map((row) => row.id), [injection.id]);
  assert.equal(db.search().results.length, 7);

  // A query whose unfiltered FTS matches all fail the tag filter still uses the filtered corpus for fallback.
  db.add({ content: "needle only", tags: ["other"] });
  db.add({ content: "ops only", tags: ["ops"] });
  const filtered = db.search("needle", "any", 20, 0, { tags: ["ops"] });
  assert.equal(filtered.mode, "literal");
  assert.equal(filtered.results.length, 0);
  const filteredDeep = db.search("needle", "any", 20, 5, { tags: ["ops"] });
  assert.equal(filteredDeep.mode, "literal", "the fallback decision must not depend on the page offset");
  assert.equal(filteredDeep.results.length, 0);
  const eligible = db.search("needle", "any", 20, 0, { tags: ["other"] });
  assert.equal(eligible.mode, "any");
  assert.equal(eligible.results.length, 1);
  const pastEnd = db.search("needle", "any", 20, 5, { tags: ["other"] });
  assert.equal(pastEnd.mode, "any", "an empty later FTS page must not switch to literal mode");
  assert.equal(pastEnd.results.length, 0);

  // More eligible rows than one page, with ineligible rows that would otherwise rank first.
  for (let i = 0; i < 10; i++) db.add({ content: `bulk needle ${i}`, tags: ["noise"] });
  const expected = Array.from({ length: 25 }, (_, i) => db.add({ content: `bulk needle eligible ${i}`, tags: ["bulk", "keep"] }).memory.id);
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = db.search("bulk needle", "all", 7, offset, { tags: ["keep"] });
    seen.push(...page.results.map((row) => row.id));
    offset = page.next_offset;
  }
  assert.deepEqual(seen.sort(), expected.sort());
});
