import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DeliveryLedger, LEDGER_BYTES, LEDGER_RECORD_BYTES, LEDGER_RETENTION_MS, LEDGER_SLOTS, migrateDeliveryLedger, readDeliveryLedger, type DeliveryRecord } from "../src/delivery-ledger.ts";

const scratch = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
await mkdir(scratch, { recursive: true });
const source = resolve(import.meta.dirname, "../src/delivery-ledger.ts");
const pending = { phase: "api_attempt", operation: "reply", outcome: "pending" } as const;
const item = (extra: Partial<DeliveryRecord> = {}): DeliveryRecord => ({ v: 1, at: Date.now(), event: randomUUID(), ...pending, ...extra });
const line = (r: DeliveryRecord) => JSON.stringify(r) + "\n";
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(resolve(scratch, "jsonl-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "diagnostics"); await mkdir(path, { mode: 0o700 });
  const ledger = new DeliveryLedger(path), active = resolve(path, "events.jsonl");
  const append = async () => { await ledger.append(pending); while (ledger.pendingWrites) await ledger.flush(); };
  return { root, path, active, ledger, append };
}
function subprocess(code: string, args: string[] = []) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, ...args], {
    cwd: resolve(import.meta.dirname, ".."), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", d => { output += d; }); child.stderr.on("data", d => { output += d; });
  const done = new Promise<string>((yes, no) => { child.on("error", no); child.on("close", status => status === 0 ? yes(output) : no(new Error(`Synthetic process ${status}: ${output}`))); });
  return { child, done };
}
async function inventory(path: string) {
  return Promise.all((await readdir(path)).sort().map(async name => { const s = await lstat(resolve(path, name)); return { name, ino: s.ino, size: s.size, ctime: s.ctimeMs, mode: s.mode }; }));
}

test("JSONL append success has one closed redacted record per line and stable inode without blind rewrites", async t => {
  const f = await fixture(t); await f.append(); const first = await stat(f.active);
  for (let n = 0; n < 10; n++) await f.append();
  const data = await readFile(f.active), lines = data.toString().trimEnd().split("\n");
  assert.equal(lines.length, 11); assert.equal((await stat(f.active)).ino, first.ino); assert.equal(f.ledger.dropped, 0);
  for (const s of lines) { assert.ok(Buffer.byteLength(s + "\n") <= LEDGER_RECORD_BYTES); const r = JSON.parse(s); assert.equal(r.v, 1); assert.equal(r.outcome, "pending"); }
  assert.deepEqual((await readdir(f.path)).sort(), ["events.jsonl", "writer.lock"]);
  assert.ok(!data.includes(Buffer.from("recipient"))); assert.ok(!data.includes(Buffer.from("path")));
});

test("all exact opaque filters, timestamp/writer ordering and latest truncation remain compatible", async t => {
  const f = await fixture(t), reply = randomUUID(), notice = randomUUID(), delivery = randomUUID(), writer = randomUUID(), task = "bg-012345abcdef";
  const at = Date.now(), records = [3, 1, 2].map(sequence => item({ at, writer, sequence, reply, notice, delivery, task }));
  await writeFile(f.active, records.map(line).join("") + line(item({ at: at - 1 })), { mode: 0o600 });
  for (const query of [{ reply }, { notice }, { delivery }, { task }, { reply, notice, delivery, task }]) {
    const view = await readDeliveryLedger(f.path, { ...query, limit: 2 });
    assert.equal(view.state, "ok"); assert.deepEqual(view.records.map(r => r.sequence), [2, 3]); assert.equal(view.truncated, true); assert.equal(view.auditComplete, false);
  }
  for (const query of [{ task: "private" }, { reply: "private" }, { limit: 201 }, { limit: 0 }, { limit: NaN }]) assert.equal((await readDeliveryLedger(f.path, query)).state, "unavailable");
  assert.deepEqual((await readDeliveryLedger(f.path, { delivery: randomUUID() })).records, []);
});

test("partial tail, corrupt middle, oversized line and malformed UTF8 preserve valid earlier metadata and repair only on write", async t => {
  const f = await fixture(t), a = item(), b = item({ at: a.at + 1 });
  const original = Buffer.concat([Buffer.from(line(a) + "PRIVATE not JSON\n" + "x".repeat(1024) + "\n"), Buffer.from([0xff, 10]), Buffer.from(line(b) + '{"unfinished":')]);
  await writeFile(f.active, original, { mode: 0o600 }); const before = await inventory(f.path);
  const view = await readDeliveryLedger(f.path);
  assert.equal(view.state, "ok"); assert.deepEqual(view.records.map(r => r.event), [a.event, b.event]); assert.equal(view.skipped, 4);
  assert.deepEqual(await inventory(f.path), before); assert.deepEqual(await readFile(f.active), original);
  await f.append(); const after = await readDeliveryLedger(f.path);
  assert.equal(f.ledger.dropped, 0); assert.equal(after.skipped, 0); assert.equal(after.records.length, 3);
  assert.ok((await readFile(f.active, "utf8")).endsWith("\n")); assert.ok(!(await readFile(f.active, "utf8")).includes("PRIVATE"));
});

test("a complete JSON object without terminal newline is still uncommitted, never concatenated with an append", async t => {
  const f = await fixture(t), a = item(); await writeFile(f.active, JSON.stringify(a), { mode: 0o600 });
  assert.equal((await readDeliveryLedger(f.path)).skipped, 1); await f.append();
  const view = await readDeliveryLedger(f.path); assert.equal(view.records.length, 1); assert.notEqual(view.records[0].event, a.event); assert.equal(view.skipped, 0);
});

test("record byte ceiling counts multibyte UTF8, not characters, and unknown keys never reach projection", async t => {
  const f = await fixture(t), a = item();
  // Whitespace makes otherwise valid JSON too large in bytes while its character count is below 1024.
  const oversized = JSON.stringify(a).replace('"event"', '"event"') + " ".repeat(LEDGER_RECORD_BYTES);
  const unicode = JSON.stringify({ ...a, text: "🧪".repeat(300) });
  const exact = JSON.stringify(a).padEnd(LEDGER_RECORD_BYTES - 1) + "\n";
  assert.equal(Buffer.byteLength(exact), LEDGER_RECORD_BYTES);
  await writeFile(f.active, oversized + "\n" + unicode + "\n" + exact + line(a), { mode: 0o600 });
  const view = await readDeliveryLedger(f.path); assert.equal(view.skipped, 2); assert.deepEqual(view.records, [a]);
  let getters = 0; await f.ledger.append({ ...pending, get reason() { getters++; return "empty_final" as const; } });
  assert.equal(getters, 0); assert.equal(f.ledger.dropped, 1);
});

test("oversized active file fails closed, stays untouched, and cannot bypass file or record caps", async t => {
  const f = await fixture(t), data = Buffer.concat([Buffer.from(line(item())), Buffer.alloc(LEDGER_BYTES, 32)]);
  await writeFile(f.active, data, { mode: 0o600 }); assert.equal((await readDeliveryLedger(f.path)).state, "unavailable");
  await f.append(); assert.equal(f.ledger.dropped, 1); assert.deepEqual(await readFile(f.active), data);
});

test("2048 retention and seven-day logical expiry compact with reserved headroom, not on each steady-state append", async t => {
  const f = await fixture(t), now = Date.now();
  const seed = Array.from({ length: LEDGER_SLOTS }, (_, n) => item({ at: now - 3000 + n }));
  await writeFile(f.active, seed.map(line).join(""), { mode: 0o600 }); const before = await stat(f.active);
  await f.append(); const compacted = await stat(f.active); assert.notEqual(compacted.ino, before.ino);
  const lines = (await readFile(f.active, "utf8")).trimEnd().split("\n"); assert.equal(lines.length, LEDGER_SLOTS - 256);
  for (let n = 0; n < 12; n++) await f.append(); assert.equal((await stat(f.active)).ino, compacted.ino);
  assert.ok((await stat(f.active)).size <= LEDGER_BYTES); assert.equal(f.ledger.dropped, 0);
  const expired = item({ at: now - LEDGER_RETENTION_MS - 1 }), future = item({ at: now + 120_000 });
  await writeFile(f.active, line(expired) + line(future) + line(seed[0]), { mode: 0o600 });
  assert.deepEqual((await readDeliveryLedger(f.path)).records.map(r => r.event), [seed[0].event]);
  await f.append(); assert.equal((await readFile(f.active, "utf8")).trimEnd().split("\n").length, 2);
});

test("excess valid records within byte cap return a bounded truncated view and compact back inside retention bound", async t => {
  const f = await fixture(t), records = Array.from({ length: LEDGER_SLOTS + 10 }, () => item());
  await writeFile(f.active, records.map(line).join(""), { mode: 0o600 });
  const view = await readDeliveryLedger(f.path, { limit: 200 }); assert.equal(view.records.length, 200); assert.equal(view.truncated, true);
  await f.append(); assert.ok((await readFile(f.active, "utf8")).trimEnd().split("\n").length <= LEDGER_SLOTS);
});

for (const name of ["events.jsonl", "writer.lock", "compact.tmp"]) for (const trap of ["symlink", "hardlink", "mode", "directory", "fifo"]) test(`${name} rejects ${trap} traps without modifying their target`, async t => {
  const f = await fixture(t), outside = resolve(f.root, "outside"), target = resolve(f.path, name);
  await writeFile(outside, "PRIVATE", { mode: 0o600 });
  if (trap === "symlink") await symlink(outside, target);
  if (trap === "hardlink") await link(outside, target);
  if (trap === "mode") await writeFile(target, "PRIVATE", { mode: 0o644 });
  if (trap === "directory") await mkdir(target, { mode: 0o700 });
  if (trap === "fifo") {
    await new Promise<void>((yes, no) => { const c = spawn("/usr/bin/mkfifo", [target], { stdio: "ignore" }); c.on("error", no); c.on("close", n => n === 0 ? yes() : no(new Error())); });
    await chmod(target, 0o600);
  }
  const before = await lstat(target); assert.equal((await readDeliveryLedger(f.path)).state, "unavailable"); await f.append();
  assert.equal(f.ledger.dropped, 1); assert.equal((await lstat(target)).ino, before.ino); assert.equal(await readFile(outside, "utf8"), "PRIVATE"); assert.equal((await stat(outside)).mode & 0o777, 0o600);
});

test("unknown names and out-of-range legacy slots fail closed and are never removed", async t => {
  const f = await fixture(t); await writeFile(resolve(f.path, "2048.json"), "PRIVATE", { mode: 0o600 });
  const before = await inventory(f.path); assert.equal((await readDeliveryLedger(f.path)).state, "unavailable"); await f.append();
  await assert.rejects(migrateDeliveryLedger(f.path, { writersStopped: true })); assert.deepEqual(await inventory(f.path), before);
  await rename(resolve(f.path, "2048.json"), resolve(f.path, "unrelated.txt")); await f.append();
  assert.equal(f.ledger.dropped, 2); assert.equal(await readFile(resolve(f.path, "unrelated.txt"), "utf8"), "PRIVATE");
});

test("missing and unavailable readers never create directories, locks, repairs or temporary files", async t => {
  const f = await fixture(t), absent = resolve(f.root, "missing", "diagnostics");
  assert.equal((await readDeliveryLedger(absent)).state, "missing"); await assert.rejects(stat(resolve(f.root, "missing")));
  await writeFile(f.active, "PRIVATE bad tail", { mode: 0o600 }); await writeFile(resolve(f.path, "compact.tmp"), line(item()), { mode: 0o600 });
  const before = await inventory(f.path); await readDeliveryLedger(f.path); await readDeliveryLedger(f.path);
  assert.deepEqual(await inventory(f.path), before);
});

test("safe crash compaction temp is ignored by readers, discarded under lock by next writer and never replayed", async t => {
  const f = await fixture(t), committed = item(), staged = item();
  await writeFile(f.active, line(committed), { mode: 0o600 }); await writeFile(resolve(f.path, "compact.tmp"), line(staged), { mode: 0o600 });
  assert.deepEqual((await readDeliveryLedger(f.path)).records, [committed]); await f.append();
  const view = await readDeliveryLedger(f.path); assert.equal(view.records.length, 2); assert.ok(!view.records.some(r => r.event === staged.event));
  assert.deepEqual((await readdir(f.path)).sort(), ["events.jsonl", "writer.lock"]);
});

test("kernel lock survives acquiring-helper exit, drops contending diagnostics promptly, and releases after writer SIGKILL", async t => {
  const f = await fixture(t); await f.append();
  const code = `import {open} from 'node:fs/promises'; import {spawn} from 'node:child_process'; const file=await open(process.argv[1],'r'); await new Promise((yes,no)=>{const c=spawn('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',file.fd],env:{}});c.on('close',n=>n===0?yes():no(Error()));}); console.log('held'); setInterval(()=>{},1000);`;
  const held = subprocess(code, [resolve(f.path, "writer.lock")]); held.done.catch(() => {});
  await new Promise<void>((yes, no) => { held.child.stdout.once("data", () => yes()); held.child.once("error", no); held.child.once("exit", () => no(new Error("holder exited early"))); });
  const untouched = await inventory(f.path);
  assert.equal((await readDeliveryLedger(f.path)).records.length, 1, "inspection never acquires the held writer lock");
  assert.deepEqual(await inventory(f.path), untouched);
  const start = performance.now(); await f.ledger.append(pending); assert.ok(performance.now() - start < 250, "50ms caller budget with scheduling tolerance");
  while (f.ledger.pendingWrites) await f.ledger.flush(); assert.equal(f.ledger.dropped, 1);
  const lockInode = (await stat(resolve(f.path, "writer.lock"))).ino;
  held.child.kill("SIGKILL"); await new Promise<void>(yes => held.child.once("close", () => yes()));
  await f.append(); assert.equal(f.ledger.dropped, 1); assert.equal((await stat(resolve(f.path, "writer.lock"))).ino, lockInode);
  assert.equal((await readDeliveryLedger(f.path)).records.length, 2);
});

test("concurrent subprocess writers open active after locking and preserve all committed records through compaction", async t => {
  const f = await fixture(t), group = randomUUID(), at = Date.now() - 10_000;
  await writeFile(f.active, Array.from({ length: LEDGER_SLOTS }, () => line(item({ at }))).join(""), { mode: 0o600 });
  const code = `import {DeliveryLedger} from ${JSON.stringify(source)}; const l=new DeliveryLedger(process.argv[1]);let accepted=0;for(let n=0;n<1000&&accepted<35;n++){const drop=l.dropped;await l.append({...${JSON.stringify(pending)},reply:process.argv[2]});while(l.pendingWrites)await l.flush();if(l.dropped===drop)accepted++;else await new Promise(r=>setTimeout(r,10+Math.random()*30));}if(accepted!==35)throw Error('incomplete fixture');`;
  await Promise.all([1, 2, 3, 4].map(() => subprocess(code, [f.path, group]).done));
  const view = await readDeliveryLedger(f.path, { reply: group, limit: 200 }); assert.equal(view.state, "ok"); assert.equal(view.skipped, 0); assert.equal(view.records.length, 140);
  assert.equal(new Set(view.records.map(r => r.event)).size, 140); assert.equal(new Set(view.records.map(r => r.writer)).size, 4);
  assert.ok((await readFile(f.active, "utf8")).trimEnd().split("\n").length <= LEDGER_SLOTS); assert.ok((await stat(f.active)).size <= LEDGER_BYTES);
  assert.deepEqual((await readdir(f.path)).sort(), ["events.jsonl", "writer.lock"]);
});

test("legacy transition reads/dedup stay read-only and offline conversion preserves exact event IDs and observations", async t => {
  const f = await fixture(t), a = item({ task: "bg-012345abcdef" }), b = item({ at: Date.now() + 1 });
  await writeFile(f.active, line(a), { mode: 0o600 });
  // Key order alone does not turn an identical observation into a conflicting duplicate.
  await writeFile(resolve(f.path, "0000.json"), JSON.stringify(Object.fromEntries(Object.entries(a).reverse())), { mode: 0o600 });
  await writeFile(resolve(f.path, "2047.json"), JSON.stringify(b), { mode: 0o600 });
  const before = await inventory(f.path), view = await readDeliveryLedger(f.path);
  assert.deepEqual(view.records, [a, b]); assert.deepEqual(await inventory(f.path), before);
  await f.append(); assert.equal(f.ledger.dropped, 1); assert.deepEqual(await inventory(f.path), before);
  await assert.rejects(migrateDeliveryLedger(f.path, { writersStopped: false } as any)); assert.deepEqual(await inventory(f.path), before);
  assert.deepEqual(await migrateDeliveryLedger(f.path, { writersStopped: true }), { retained: 2, removed: 2 });
  assert.deepEqual((await readDeliveryLedger(f.path)).records, [a, b]); assert.deepEqual((await readdir(f.path)).sort(), ["events.jsonl", "writer.lock"]);
  assert.deepEqual(await migrateDeliveryLedger(f.path, { writersStopped: true }), { retained: 2, removed: 0 });
});

test("interrupted migration publication plus partial slot cleanup is idempotently finalized by event UUID", async t => {
  const f = await fixture(t), a = item(), b = item();
  // Exact state after atomic publication and one cleanup, before process loss.
  await writeFile(f.active, line(a) + line(b), { mode: 0o600 }); await writeFile(resolve(f.path, "0001.json"), line(b), { mode: 0o600 });
  assert.deepEqual(await migrateDeliveryLedger(f.path, { writersStopped: true }), { retained: 2, removed: 1 });
  assert.deepEqual((await readDeliveryLedger(f.path)).records.map(r => r.event), [a, b].sort((x, y) => x.at - y.at || x.event.localeCompare(y.event)).map(r => r.event));
});

for (const trap of ["corrupt", "symlink", "hardlink", "mode", "oversize"]) test(`migration preflight halts on ${trap} legacy entry before publication or cleanup`, async t => {
  const f = await fixture(t), safe = item(), target = resolve(f.path, "0001.json"), outside = resolve(f.root, "outside");
  await writeFile(resolve(f.path, "0000.json"), line(safe), { mode: 0o600 }); await writeFile(outside, line(item()), { mode: 0o600 });
  if (trap === "corrupt") await writeFile(target, "PRIVATE", { mode: 0o600 });
  if (trap === "symlink") await symlink(outside, target);
  if (trap === "hardlink") await link(outside, target);
  if (trap === "mode") await writeFile(target, line(item()), { mode: 0o644 });
  if (trap === "oversize") await writeFile(target, "x".repeat(LEDGER_RECORD_BYTES + 1), { mode: 0o600 });
  const before = await inventory(f.path); await assert.rejects(migrateDeliveryLedger(f.path, { writersStopped: true })); assert.deepEqual(await inventory(f.path), before);
  assert.equal(await readFile(resolve(f.path, "0000.json"), "utf8"), line(safe));
});

test("descriptor-anchored operations reject ancestor alias and nonprivate final modes without modifying aliases", async t => {
  const f = await fixture(t), alias = resolve(f.root, "alias"); await symlink(f.path, alias);
  const ledger = new DeliveryLedger(alias); await ledger.append(pending); while (ledger.pendingWrites) await ledger.flush();
  assert.equal(ledger.dropped, 1); assert.deepEqual(await readdir(f.path), []); assert.equal((await readDeliveryLedger(alias)).state, "unavailable");
  await chmod(f.path, 0o1700); await f.append(); assert.equal(f.ledger.dropped, 1); assert.equal((await stat(f.path)).mode & 0o7777, 0o1700);
});

for (const kind of ["append", "compact"]) test(`SIGKILL during real ${kind} I/O leaves earlier commits readable and next writer recovers under the same lock`, async t => {
  const f = await fixture(t), committed = item({ at: Date.now() - 1000 });
  await writeFile(f.active, line(committed) + (kind === "compact" ? "bad tail" : ""), { mode: 0o600 });
  const code = `import promises from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; import {DeliveryLedger} from ${JSON.stringify(source)};
    const original=promises.open; promises.open=async (...args)=>{const f=await original(...args);if(String(args[0]).endsWith(${JSON.stringify(kind === "compact" ? "/compact.tmp" : "/events.jsonl")})) {
      const write=f.write.bind(f); ${kind === "compact" ? "f.writeFile" : "f.write"}=async data=>{await write(data.subarray(0,13));await f.sync();console.log('partial');await new Promise(()=>{});};
    } return f;};syncBuiltinESMExports();const ledger=new DeliveryLedger(process.argv[1]);await ledger.append(${JSON.stringify(pending)});while(ledger.pendingWrites)await ledger.flush();`;
  const killed = subprocess(code, [f.path]); killed.done.catch(() => {});
  await new Promise<void>((yes, no) => { killed.child.stdout.once("data", () => yes()); killed.child.once("error", no); killed.child.once("exit", () => no(new Error("writer exited before fixture crash"))); });
  killed.child.kill("SIGKILL"); await new Promise<void>(yes => killed.child.once("close", () => yes()));
  const view = await readDeliveryLedger(f.path); assert.equal(view.state, "ok"); assert.deepEqual(view.records, [committed]);
  const lock = (await stat(resolve(f.path, "writer.lock"))).ino; await f.append();
  const recovered = await readDeliveryLedger(f.path); assert.equal(recovered.skipped, 0); assert.equal(recovered.records.length, 2); assert.equal(recovered.records[0].event, committed.event);
  assert.equal(f.ledger.dropped, 0); assert.equal((await stat(resolve(f.path, "writer.lock"))).ino, lock); assert.ok(!(await readdir(f.path)).includes("compact.tmp"));
});

test("migration refuses conflicting duplicate event identities instead of silently overwriting an observation", async t => {
  const f = await fixture(t), a = item(); await writeFile(f.active, line(a), { mode: 0o600 });
  await writeFile(resolve(f.path, "0000.json"), line({ ...a, outcome: "acknowledged" }), { mode: 0o600 });
  await assert.rejects(migrateDeliveryLedger(f.path, { writersStopped: true }));
  assert.equal(await readFile(f.active, "utf8"), line(a)); assert.equal((await readdir(f.path)).filter(n => /\.json$/.test(n)).length, 1);
});

for (const operation of ["read", "write", "migration"]) test(`ancestor swap at real checked-file boundary cannot redirect ${operation} outside the anchored directory`, async t => {
  const f = await fixture(t), outside = resolve(f.root, "outside"), target = operation === "migration" ? resolve(f.path, "0000.json") : f.active;
  await mkdir(outside, { mode: 0o700 }); const approved = item(), sentinel = "OUTSIDE_PRIVATE_SENTINEL";
  await writeFile(target, line(approved), { mode: 0o600 }); await writeFile(resolve(outside, operation === "migration" ? "0000.json" : "events.jsonl"), sentinel, { mode: 0o600 });
  const identity = await stat(target), originalOpen = promises.open, readBytes: Buffer[] = []; let mutated = false;
  promises.open = (async (...args: Parameters<typeof promises.open>) => {
    const file = await originalOpen(...args), getStat = file.stat.bind(file), read = file.read.bind(file);
    file.stat = (async (...options: Parameters<typeof file.stat>) => {
      const value = await getStat(...options);
      if (!mutated && value.ino === identity.ino && value.dev === identity.dev) {
        mutated = true; await rename(f.path, f.path + "-original"); await symlink(outside, f.path);
      }
      return value;
    }) as typeof file.stat;
    file.read = (async (...options: any[]) => {
      const result = await (read as Function)(...options); readBytes.push(Buffer.from(result.buffer.subarray(0, result.bytesRead))); return result;
    }) as typeof file.read;
    return file;
  }) as typeof promises.open;
  syncBuiltinESMExports();
  try {
    if (operation === "read") assert.equal((await readDeliveryLedger(f.path)).state, "unavailable");
    else if (operation === "write") { await f.append(); assert.equal(f.ledger.dropped, 1); }
    else await assert.rejects(migrateDeliveryLedger(f.path, { writersStopped: true }));
    assert.equal(mutated, true); assert.equal(Buffer.concat(readBytes).includes(Buffer.from(sentinel)), false);
    assert.equal(await readFile(resolve(outside, operation === "migration" ? "0000.json" : "events.jsonl"), "utf8"), sentinel);
    assert.deepEqual(await readdir(outside), [operation === "migration" ? "0000.json" : "events.jsonl"]);
  } finally { promises.open = originalOpen; syncBuiltinESMExports(); }
});

test("replacement of the lock inode after acquisition is detected before append, never treated as continued coordination", async t => {
  const f = await fixture(t); await f.append(); const original = await readFile(f.active), identity = await stat(f.active);
  const originalOpen = promises.open; let replaced = false;
  promises.open = (async (...args: Parameters<typeof promises.open>) => {
    const file = await originalOpen(...args), getStat = file.stat.bind(file);
    file.stat = (async (...options: Parameters<typeof file.stat>) => {
      const value = await getStat(...options);
      if (!replaced && value.ino === identity.ino && value.dev === identity.dev) {
        replaced = true; await rename(resolve(f.path, "writer.lock"), resolve(f.root, "retired-lock"));
        const replacement = await originalOpen(resolve(f.path, "writer.lock"), "wx", 0o600); await replacement.close();
      }
      return value;
    }) as typeof file.stat; return file;
  }) as typeof promises.open; syncBuiltinESMExports();
  try { await f.append(); assert.equal(replaced, true); assert.equal(f.ledger.dropped, 1); assert.deepEqual(await readFile(f.active), original); }
  finally { promises.open = originalOpen; syncBuiltinESMExports(); }
});

test("post-open growth is bounded and unavailable, never silently accepted as an oversized file", async t => {
  const f = await fixture(t); await writeFile(f.active, line(item()), { mode: 0o600 });
  const originalOpen = promises.open, originalWrite = promises.writeFile; let changed = false, bytes = 0;
  promises.open = (async (...args: Parameters<typeof promises.open>) => {
    const file = await originalOpen(...args), getStat = file.stat.bind(file), read = file.read.bind(file);
    if (String(args[0]).endsWith("/events.jsonl")) {
      file.stat = (async (...options: Parameters<typeof file.stat>) => {
        const value = await getStat(...options);
        if (!changed) { changed = true; await originalWrite(f.active, Buffer.alloc(LEDGER_BYTES + 1), { mode: 0o600 }); }
        return value;
      }) as typeof file.stat;
      file.read = (async (...options: any[]) => { const result = await (read as Function)(...options); bytes += result.bytesRead; return result; }) as typeof file.read;
    }
    return file;
  }) as typeof promises.open; syncBuiltinESMExports();
  try { assert.equal((await readDeliveryLedger(f.path)).state, "unavailable"); assert.equal(changed, true); assert.ok(bytes <= LEDGER_BYTES); }
  finally { promises.open = originalOpen; syncBuiltinESMExports(); }
});
