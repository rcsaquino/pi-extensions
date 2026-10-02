import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ConnectionLease } from "../src/connection-lease.ts";

const workspace = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
await mkdir(workspace, { recursive: true });
const signal = new AbortController().signal;

async function directory(t: test.TestContext) {
  const dir = await mkdtemp(resolve(workspace, "telegram-lease-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("simultaneous claims yield exactly one owner; losing instances never wait or take over", async t => {
  const dir = await directory(t);
  const claims = await Promise.allSettled(Array.from({ length: 8 }, () => ConnectionLease.acquire(dir, "12345:test", signal, () => {})));
  const owners = claims.filter((result): result is PromiseFulfilledResult<ConnectionLease> => result.status === "fulfilled");
  t.after(async () => { for (const owner of owners) await owner.value.release(); });
  assert.equal(owners.length, 1);
  assert.equal(claims.filter(result => result.status === "rejected").length, 7);
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes("12345"));
  assert.equal((await stat(resolve(dir, files[0]))).mode & 0o777, 0o600);
  await owners[0].value.release();
  const next = await ConnectionLease.acquire(dir, "12345:test", signal, () => {});
  await next.release();
});

test("rotated credentials cannot steal the same bot's ownership", async t => {
  const dir = await directory(t);
  const first = await ConnectionLease.acquire(dir, "12345:old-test-secret", signal, () => {});
  t.after(() => first.release());
  await assert.rejects(ConnectionLease.acquire(dir, "12345:new-test-secret", signal, () => {}), /already owned/);
  await first.release();
  const next = await ConnectionLease.acquire(dir, "12345:new-test-secret", signal, () => {});
  await next.release();
});

test("an aborted startup leaves no connection owner", async t => {
  const dir = await directory(t);
  const controller = new AbortController();
  const pending = ConnectionLease.acquire(dir, "12345:test", controller.signal, () => {});
  controller.abort();
  await assert.rejects(pending);
  const next = await ConnectionLease.acquire(dir, "12345:test", signal, () => {});
  await next.release();
});

test("unexpected helper loss notifies the owner and frees the kernel lock", async t => {
  const dir = await directory(t);
  let lost = 0;
  const first = await ConnectionLease.acquire(dir, "12345:test", signal, () => { lost++; });
  t.after(() => first.release());
  (first as any).child.kill("SIGKILL");
  for (let n = 0; !lost && n < 100; n++) await delay(10);
  assert.equal(lost, 1);
  const next = await ConnectionLease.acquire(dir, "12345:test", signal, () => {});
  await next.release();
});

test("a separate Pi-like process owns the connection until it crashes, with no stale-lock deletion", async t => {
  const dir = await directory(t);
  const module = resolve(import.meta.dirname, "../src/connection-lease.ts");
  const code = `import { ConnectionLease } from ${JSON.stringify(module)}; await ConnectionLease.acquire(${JSON.stringify(dir)}, '12345:test', new AbortController().signal, () => {}); process.stdout.write('owned\\n');`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>(done => child.once("close", () => done()));
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error("Child lease timeout")), 5000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("Child exited before acquiring lock")); });
    child.stdout!.once("data", data => { clearTimeout(timeout); assert.match(data.toString(), /owned/); done(); });
  });
  await assert.rejects(ConnectionLease.acquire(dir, "12345:test", signal, () => {}), /already owned/);
  child.kill("SIGKILL");
  await exited;
  let next: ConnectionLease | undefined;
  for (let n = 0; !next && n < 30; n++) {
    try { next = await ConnectionLease.acquire(dir, "12345:test", signal, () => {}); } catch { await delay(20); }
  }
  assert.ok(next, "Parent crash must release the helper's lock without a stale PID file");
  await next.release();
  assert.equal((await readdir(dir)).length, 1, "Lock inode is retained, never deleted while another owner might be acquiring");
});
