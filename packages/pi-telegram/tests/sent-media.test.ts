import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { SentMediaRegistry, type SentMediaRecord } from "../src/sent-media.ts";

const workspace = process.env.TELEGRAM_TEST_DIR || resolve(process.env.TMPDIR || "/tmp", "pi-telegram-tests");
await mkdir(workspace, { recursive: true });
const record = (chat: number, message: number, path: string, at = Date.now()): SentMediaRecord =>
  ({ chat, message, path, kind: "photo", source: "outbound", at });

async function scratch(t: test.TestContext, name: string): Promise<string> {
  const dir = await mkdtemp(resolve(workspace, `sent-media-${name}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("record/lookup round-trips exact absolute paths and survives a fresh load", async t => {
  const dir = await scratch(t, "roundtrip");
  const path = resolve(dir, "media-index.json"), file = resolve(dir, "photo & one.jpg");
  const registry = new SentMediaRegistry(path);
  await registry.load();
  assert.equal(registry.lookup(123, 7), undefined);
  await registry.record([record(123, 7, file, 1_791_000_000_000)]);
  const stored = { chat: 123, message: 7, path: file, kind: "photo", source: "outbound", at: 1_791_000_000_000 };
  assert.deepEqual(registry.lookup(123, 7), stored);
  assert.equal(registry.lookup(123, 8), undefined, "other message ids stay absent");
  assert.equal(registry.lookup(456, 7), undefined, "other chats stay separate");
  assert.equal(registry.lookup(0, 7), undefined); assert.equal(registry.lookup(NaN, 7), undefined);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, entries: [stored] });
  const reopened = new SentMediaRegistry(path);
  await reopened.load();
  assert.deepEqual(reopened.lookup(123, 7), stored);
  reopened.clear();
  assert.equal(reopened.lookup(123, 7), undefined, "clear drops only memory, not the persisted index");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).entries.length, 1);
});

test("invalid records are dropped on record and load without changing valid entries", async t => {
  const dir = await scratch(t, "invalid");
  const path = resolve(dir, "media-index.json"), file = resolve(dir, "valid.jpg");
  const registry = new SentMediaRegistry(path);
  const hostile = [
    { ...record(1, 1, "relative.jpg"), } as unknown as SentMediaRecord,
    { ...record(2, 2, file), message: 0 } as unknown as SentMediaRecord,
    { ...record(3, 3, file), chat: -1 } as unknown as SentMediaRecord,
    { ...record(4, 4, file), path: "" } as unknown as SentMediaRecord,
    { ...record(5, 5, file), kind: "Photo!" } as unknown as SentMediaRecord,
    { ...record(6, 6, file), source: "elsewhere" } as unknown as SentMediaRecord,
    { ...record(7, 7, file), at: 0 } as unknown as SentMediaRecord,
    null as unknown as SentMediaRecord, "text" as unknown as SentMediaRecord,
  ];
  await registry.record([...hostile, record(8, 8, file)]);
  assert.deepEqual([...Array(8)].map((_, index) => registry.lookup(index + 1, index + 1)?.message ?? null), [null, null, null, null, null, null, null, 8]);
  await writeFile(path, JSON.stringify({ version: 1, entries: [...hostile, record(8, 8, file)] }));
  const reloaded = new SentMediaRegistry(path);
  await reloaded.load();
  assert.deepEqual([...Array(8)].map((_, index) => reloaded.lookup(index + 1, index + 1)?.message ?? null), [null, null, null, null, null, null, null, 8]);
  assert.equal(reloaded.lookup(8, 8)?.path, file);
});

test("retention prunes older-than-90-day entries and keeps only the newest 1024", async t => {
  const dir = await scratch(t, "retention");
  const path = resolve(dir, "media-index.json"), now = Date.now();
  const registry = new SentMediaRegistry(path);
  await registry.record([
    record(1, 1, resolve(dir, "expired.jpg"), now - 91 * 86400_000),
    record(1, 2, resolve(dir, "boundary.jpg"), now - 89 * 86400_000),
  ]);
  assert.equal(registry.lookup(1, 1), undefined, "expired entries are not retained");
  assert.ok(registry.lookup(1, 2));
  const flood = Array.from({ length: 1030 }, (_, index) => record(2, index + 1, resolve(dir, `file-${index}.jpg`), now - (1030 - index) * 1000));
  await registry.record(flood);
  assert.equal(registry.lookup(1, 2), undefined, "the pre-flood entry is older than the kept newest 1024");
  assert.equal(registry.lookup(2, 6), undefined, "oldest flood entries are dropped first");
  assert.equal(registry.lookup(2, 7)?.message, 7);
  assert.equal(registry.lookup(2, 1030)?.message, 1030);
  const entries = JSON.parse(await readFile(path, "utf8")).entries as { message: number }[];
  assert.equal(entries.length, 1024);
  assert.deepEqual(new Set(entries.map(entry => entry.message)).size, 1024, "no duplicate message ids are persisted");
  const reopened = new SentMediaRegistry(path);
  await reopened.load();
  assert.equal(reopened.lookup(2, 1030)?.message, 1030);
  assert.equal(reopened.lookup(2, 7)?.message, 7);
  assert.equal(reopened.lookup(2, 6), undefined);
});

test("missing, corrupt and unreadable index files start empty without rejecting", async t => {
  const dir = await scratch(t, "tolerance");
  const missing = new SentMediaRegistry(resolve(dir, "missing.json"));
  await assert.doesNotReject(missing.load());
  assert.equal(missing.lookup(1, 1), undefined);
  const corrupt = new SentMediaRegistry(resolve(dir, "corrupt.json"));
  await writeFile(resolve(dir, "corrupt.json"), '{"version":1,"entries":[');
  await assert.doesNotReject(corrupt.load());
  assert.equal(corrupt.lookup(1, 1), undefined);
  const directory = new SentMediaRegistry(dir);
  await assert.doesNotReject(directory.load(), "a directory in place of the file is tolerated");
  assert.equal(directory.lookup(1, 1), undefined);
});

test("record failures are swallowed, still usable in memory, and never reject", async t => {
  const dir = await scratch(t, "failure");
  const blocker = resolve(dir, "blocker");
  await writeFile(blocker, "not a directory");
  const registry = new SentMediaRegistry(resolve(blocker, "media-index.json"));
  await assert.doesNotReject(registry.record([record(1, 1, resolve(dir, "file.jpg"))]));
  assert.equal(registry.lookup(1, 1)?.message, 1);
  await assert.doesNotReject(registry.record(undefined as unknown as SentMediaRecord[]));
  await assert.doesNotReject(registry.record([{ get path(): string { throw new Error("hostile getter"); } } as unknown as SentMediaRecord]));
});

test("the persisted index is a private 0600 file", async t => {
  const dir = await scratch(t, "mode");
  const path = resolve(dir, "media-index.json");
  const registry = new SentMediaRegistry(path);
  await registry.record([record(1, 1, resolve(dir, "file.jpg"))]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
