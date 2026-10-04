import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { outboundFile, UPLOAD_LIMIT } from "../src/api.ts";

// Schedule real filesystem mutations at the checked-file stat boundary. Support both
// the old pathname stat and the descriptor implementation, without inventing bytes.
async function atFileStat(path: string, change: () => Promise<void>, work: () => Promise<void>) {
  const identity = await fs.stat(path);
  const originalStat = promises.stat, originalOpen = promises.open, originalReadFile = promises.readFile;
  const readBytes: Buffer[] = [];
  let changed = false;
  const mutate = async () => { if (!changed) { changed = true; await change(); } };
  promises.stat = (async (name: unknown, ...args: unknown[]) => {
    const info = await (originalStat as Function)(name, ...args);
    if (String(name) === path) await mutate();
    return info;
  }) as typeof promises.stat;
  promises.open = (async (...args: unknown[]) => {
    const handle = await (originalOpen as Function)(...args);
    const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
    handle.stat = async (...options: unknown[]) => {
      const info = await stat(...options);
      if (info.ino === identity.ino && info.dev === identity.dev) await mutate();
      return info;
    };
    handle.read = async (...options: unknown[]) => {
      const result = await read(...options);
      readBytes.push(Buffer.from(result.buffer.subarray(0, result.bytesRead)));
      return result;
    };
    return handle;
  }) as typeof promises.open;
  promises.readFile = (async (...args: unknown[]) => {
    const data = await (originalReadFile as Function)(...args);
    if (String(args[0]) === path && Buffer.isBuffer(data)) readBytes.push(data);
    return data;
  }) as typeof promises.readFile;
  syncBuiltinESMExports();
  try { await work(); assert.equal(changed, true, "test reached the real checked-file boundary"); }
  finally {
    promises.stat = originalStat; promises.open = originalOpen; promises.readFile = originalReadFile;
    syncBuiltinESMExports();
  }
  return Buffer.concat(readBytes);
}
async function fixture(t: test.TestContext) {
  const base = await fs.mkdtemp(join(process.env.TELEGRAM_TEST_DIR || process.env.TMPDIR || "/tmp", "attachment-race-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = join(base, "workspace"), parent = join(cwd, "allowed"), outside = join(base, "outside");
  await fs.mkdir(parent, { recursive: true }); await fs.mkdir(outside);
  const path = join(parent, "report.txt");
  await fs.writeFile(path, "approved"); await fs.writeFile(join(outside, "report.txt"), "OUTSIDE_SENTINEL");
  return { cwd, parent, outside, path };
}
test("ancestor rename/symlink swap never reads outside bytes, even if a late check rejects", async t => {
  const f = await fixture(t);
  const read = await atFileStat(f.path, async () => {
    await fs.rename(f.parent, `${f.parent}-original`); await fs.symlink(f.outside, f.parent, "dir");
  }, async () => {
    try { assert.equal((await outboundFile(f.cwd, "allowed/report.txt")).data.toString(), "approved"); }
    catch (error) { if (error instanceof assert.AssertionError) throw error; }
  });
  assert.equal(read.includes(Buffer.from("OUTSIDE_SENTINEL")), false, "rejecting after unauthorized read is not a fix");
});
test("post-check growth is rejected and the actual descriptor read is bounded", async t => {
  const f = await fixture(t);
  const read = await atFileStat(f.path, () => fs.truncate(f.path, UPLOAD_LIMIT + 4096), async () => {
    await assert.rejects(outboundFile(f.cwd, "allowed/report.txt"), /size|50 MB|changed|oversized/i);
  });
  assert.ok(read.length <= UPLOAD_LIMIT + 1, "read at most the limit plus one overflow byte");
});
test("cancellation before descriptor reads cleans up, and unsupported platforms never use pathname fallback", async t => {
  const f = await fixture(t), controller = new AbortController();
  const descriptors = (await fs.readdir('/proc/self/fd')).length;
  const data = await atFileStat(f.path, async () => { controller.abort(); }, async () => {
    await assert.rejects(outboundFile(f.cwd, 'allowed/report.txt', undefined, undefined, controller.signal), /abort/i);
  });
  assert.equal(data.length, 0); assert.equal((await fs.readdir('/proc/self/fd')).length, descriptors);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'unsupported-fixture' });
    await assert.rejects(outboundFile(f.cwd, 'allowed/report.txt'), /Linux.*procfs/);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
test("ordinary files, in-root symlink targets and downloaded attachments retain byte/type/name policy", async t => {
  const f = await fixture(t);
  await fs.symlink(f.path, join(f.cwd, "link.txt"));
  assert.deepEqual(await outboundFile(f.cwd, "link.txt"), { data: Buffer.from("approved"), filename: "report.txt", kind: "document" });
  const downloads = join(f.outside, "downloads"); await fs.mkdir(downloads);
  const download = join(downloads, "photo.png"); await fs.writeFile(download, "synthetic image");
  assert.equal((await outboundFile(f.cwd, download, undefined, downloads)).kind, "photo");
  await fs.writeFile(join(f.parent, ".env"), "synthetic private config");
  await assert.rejects(outboundFile(f.cwd, "allowed/.env"), /secret/);
  await assert.rejects(outboundFile(f.cwd, "allowed"), /regular/);
});
