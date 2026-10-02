import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SessionSearch } from "../src/sessions.ts";
import { temporary } from "./helpers.ts";

function message(id: string, content: string, role = "user", timestamp = "2025-03-04T05:06:07.000Z") {
  return { type: "message", id, parentId: "parent", timestamp, message: { role, content } };
}

async function file(path: string, entries: unknown[]) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, entries.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") + "\n");
}

test("search includes every project, hidden and ignored files, old branches, and custom roots", async (t) => {
  const directory = await temporary(t);
  const roots = [join(directory, "sessions"), join(directory, "archive")];
  const path = join(roots[0]!, "--project-a--", "old.jsonl");
  await file(path, [
    { type: "session", version: 3, id: "session-a", cwd: "/a" },
    message("abandoned", "We chose SQLite for the ledger."),
    { type: "compaction", id: "summary", summary: "A summary with no target term.", firstKeptEntryId: "latest" },
    message("latest", "Current branch has other plans."),
  ]);
  await file(join(roots[0]!, ".hidden", "ignored.jsonl"), [message("hidden", "SQLite hidden preference")]);
  await writeFile(join(roots[0]!, ".gitignore"), "**/*.jsonl\n");
  await file(join(roots[0]!, "--project-b--", "other.jsonl"), [message("other", "SQLite other project", "assistant")]);
  await file(join(roots[1]!, "custom.jsonl"), [message("custom", "SQLite custom archive")]);
  const search = new SessionSearch(() => [...roots, join(roots[0]!, "--project-a--")]);
  const response = await search.search({ query: "sqlite" });
  assert.equal(response.results.length, 4);
  assert.equal(response.exhausted, true, JSON.stringify(response.warnings));
  assert.equal(response.roots.length, 2);
  const old = response.results.find((item) => item.entry_id === "abandoned")!;
  assert.equal(old.line, 2);
  assert.equal(old.parent_id, "parent");
  assert.equal(old.citation, `${path}:2`);
  const original = await search.read(old.path, old.line);
  assert.match(original.text, /We chose SQLite for the ledger\./u);
  assert.equal(original.timestamp, "2025-03-04T05:06:07.000Z");
});

test("literal search decodes Unicode, newlines, quotes, backslashes and optional escaped slashes", async (t) => {
  const root = await temporary(t);
  const entry = JSON.stringify(message("escaped", 'Café 🚀 path a/b and C:\\temp said "hello"\nnext line'))
    .replace("Café", "Caf\\u00e9").replace("🚀", "\\ud83d\\ude80").replace("a/b", "a\\/b");
  await file(join(root, "escaped.jsonl"), [entry]);
  const search = new SessionSearch(() => [root]);
  for (const query of ["CAFÉ", "🚀", "a/b", "C:\\temp", '"hello"\nnext', "next line"]) {
    const page = await search.search({ query });
    assert.equal(page.results.length, 1, query);
    assert.equal(page.exhausted, true, JSON.stringify(page.warnings));
  }
  assert.equal((await search.search({ query: "café missing", mode: "any" })).results.length, 1);
  assert.equal((await search.search({ query: "café missing", mode: "all" })).results.length, 0);
});

test("session pagination can enumerate every entry without silent clipping", async (t) => {
  const root = await temporary(t);
  await file(join(root, "a.jsonl"), Array.from({ length: 37 }, (_, i) => message(`a${i}`, `needle ${i}`)));
  await file(join(root, "b.jsonl"), Array.from({ length: 39 }, (_, i) => message(`b${i}`, `needle ${i}`)));
  const search = new SessionSearch(() => [root]);
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await search.search({ query: "needle", limit: 6, offset });
    seen.push(...page.results.map((item) => item.entry_id!));
    offset = page.next_offset;
    assert.equal(page.exhausted, offset === null, JSON.stringify(page.warnings));
  }
  assert.equal(seen.length, 76);
  assert.equal(new Set(seen).size, 76);
  assert.equal((await search.search({ query: "", offset: 75 })).results.length, 1);
});

test("role/date filters apply to decoded entries, with an exclusive upper date boundary", async (t) => {
  const root = await temporary(t);
  await file(join(root, "dates.jsonl"), [
    message("a", "deadline", "user", "2025-03-03T23:59:59Z"),
    message("b", "deadline", "user", "2025-03-04T01:00:00Z"),
    message("c", "deadline", "assistant", "2025-03-04T01:00:00Z"),
    message("d", "deadline", "user", "2025-03-05T00:00:00Z"),
  ]);
  const search = new SessionSearch(() => [root]);
  const page = await search.search({ query: "deadline", role: "user", after: "2025-03-04", before: "2025-03-05" });
  assert.deepEqual(page.results.map((item) => item.entry_id), ["b"]);
  await assert.rejects(search.search({ after: "yesterday" }), /ISO/u);
});

test("Unicode simple case folding, structured numeric values and keys remain searchable", async (t) => {
  const root = await temporary(t);
  await file(join(root, "structured.jsonl"), [
    message("fold", "ſpecial Kelvin"),
    { type: "message", id: "args", message: { role: "assistant", content: [{ type: "toolCall", name: "build", arguments: { uniqueKey: 123456789, enabled: true, textSignature: "a real argument" } }] } },
  ]);
  const search = new SessionSearch(() => [root]);
  for (const query of ["special", "kelvin", "uniqueKey", "123456789", "true", "a real argument"]) {
    assert.equal((await search.search({ query })).results.length, 1, query);
  }
  assert.equal((await search.search({ query: "   ", mode: "any" })).results.length, 2);
});

test("long entries remain fully readable and citations cannot read outside session roots", async (t) => {
  const root = await temporary(t);
  const content = "📖".repeat(10_000) + " final decision";
  const path = join(root, "long.jsonl");
  await file(path, [message("long", content)]);
  const search = new SessionSearch(() => [root]);
  const page = await search.search({ query: "final decision" });
  assert.equal(page.results[0]?.text_clipped, true);
  let offset: number | null = 0;
  let full = "";
  while (offset !== null) {
    const part = await search.read(path, 1, offset);
    full += part.text;
    offset = part.next_text_offset;
  }
  assert.ok(full.includes(content));
  await assert.rejects(search.read(path, 2), /no line 2/u);
  const outside = join(await temporary(t), "outside.jsonl");
  await file(outside, [message("no", "not inside root")]);
  await assert.rejects(search.read(outside), /inside a configured/u);
});

test("missing roots, malformed entries and rg failures are explicit, never clean no-match results", async (t) => {
  const root = await temporary(t);
  await file(join(root, "partial.jsonl"), ['{"type":"message","broken":"needle"', message("good", "needle")]);
  const search = new SessionSearch(() => [root, join(root, "missing")]);
  const page = await search.search({ query: "needle" });
  assert.equal(page.results.length, 2);
  assert.equal(page.exhausted, false);
  assert.ok(page.warnings.some((value) => value.includes("malformed")));
  assert.ok(page.warnings.some((value) => value.includes("Cannot search")));
  await assert.rejects(new SessionSearch(() => [root], join(root, "missing-rg")).search({ query: "needle" }), /Install rg/u);
});

test("session search cancels child processes and reports timeouts", async (t) => {
  const root = await temporary(t);
  const executable = join(root, "slow-rg");
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const search = new SessionSearch(() => [root], executable);
  const page = await search.search({ query: "x", timeout_ms: 30 });
  assert.equal(page.exhausted, false);
  assert.ok(page.warnings.some((value) => value.includes("timed out")));
  const controller = new AbortController();
  const work = search.search({ query: "x" }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(work, /abort/iu);
});

test("symlinked archives are searchable, deduplicated, and readable through their scoped path", async (t) => {
  const root = await temporary(t);
  const archive = await temporary(t);
  await file(join(archive, "old.jsonl"), [message("linked", "archived needle " + "x".repeat(8_000))]);
  await symlink(archive, join(root, "archive"), "dir");
  await symlink(archive, join(root, "duplicate"), "dir");
  const search = new SessionSearch(() => [root]);
  const page = await search.search({ query: "archived needle" });
  assert.equal(page.results.length, 1);
  const first = await search.read(page.results[0]!.path, 1);
  assert.ok(first.next_text_offset);
  const second = await search.read(first.path, 1, first.next_text_offset!);
  assert.equal(second.next_text_offset, null);
});
