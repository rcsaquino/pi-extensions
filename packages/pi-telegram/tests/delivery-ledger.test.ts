import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, chown, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import { ApiError, TelegramApi, type Fetch } from "../src/api.ts";
import { TransportFailure, type Config } from "../src/config.ts";
import { DeliveryLedger, LEDGER_RECORD_BYTES, LEDGER_RETENTION_MS, LEDGER_SLOTS, migrateDeliveryLedger, readDeliveryLedger, transportCause, type DeliveryEvent } from "../src/delivery-ledger.ts";

const scratch = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
await mkdir(scratch, { recursive: true });
const event: DeliveryEvent = { phase: "api_attempt", operation: "reply", outcome: "pending", reply: randomUUID(), delivery: randomUUID() };
const ok = (result: unknown = {}) => Response.json({ ok: true, result });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(resolve(scratch, "ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new DeliveryLedger(resolve(root, "diagnostics"));
  const config: Config = { token: "SYNTHETIC-SECRET-TOKEN", allowed: new Set(["123"]), dataDir: root };
  const read = async () => { while (ledger.pendingWrites) await ledger.flush(); return (await readDeliveryLedger(ledger.path, { limit: 200 })).records; };
  return { root, ledger, config, read, api: (fetcher: Fetch) => new TelegramApi(config, fetcher, ledger) };
}

test("cause codes use only bounded own-data allowlist, never messages, getters, cycles or arbitrary codes", () => {
  const secret = "https://api.telegram.org/botSYNTHETIC-SECRET/private";
  const cause = { code: "ECONNRESET", message: secret, stack: secret };
  assert.equal(transportCause(new Error(secret, { cause })), "ECONNRESET");
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED"]) assert.equal(transportCause({ cause: { code } }), code);
  assert.equal(transportCause({ code: secret }), "unknown");
  assert.equal(transportCause({ message: "ENOTFOUND timeout" }), "unknown");
  assert.equal(transportCause(Object.create(cause)), "unknown");
  let reads = 0;
  assert.equal(transportCause({ get code() { reads++; throw new Error(secret); }, get cause() { reads++; return cause; } }), "unknown");
  assert.equal(reads, 0);
  assert.equal(transportCause(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } })), "unknown");
  const cyclic: any = {}; cyclic.cause = cyclic; assert.equal(transportCause(cyclic), "unknown");
  let deep: any = { code: "ECONNRESET" }; for (let n = 0; n < 8; n++) deep = { cause: deep };
  assert.equal(transportCause(deep), "unknown");
});

test("durable API acknowledgments and partial chunks survive a fresh reader without claiming whole delivery", async t => {
  const f = await fixture(t); let calls = 0;
  const api = f.api(async () => { if (++calls === 2) throw new Error(`secret ${f.config.token}`, { cause: { code: "ECONNRESET" } }); return ok(); });
  await assert.rejects(api.sendText(123, "a".repeat(9000), new AbortController().signal, { operation: "reply", reply: event.reply, delivery: event.delivery }), TransportFailure);
  const records = await f.read();
  assert.deepEqual(records.map(r => r.phase), ["send_attempt", "api_attempt", "api_ack", "api_attempt", "api_failed", "send_failed"]);
  assert.equal(records.find(r => r.phase === "api_ack")!.chunk, 1);
  assert.equal(records.find(r => r.phase === "api_failed")!.chunk, 2);
  assert.equal(records.find(r => r.phase === "api_failed")!.chunks, 3);
  assert.equal(records.at(-1)!.outcome, "unknown"); assert.equal(records.at(-1)!.cause, "ECONNRESET");
  assert.ok(records.every(r => r.delivery === event.delivery && r.reply === event.reply));
  assert.equal(calls, 2, "ambiguous chunk is never retried");
  assert.ok(!JSON.stringify(records).includes(f.config.token));
  assert.ok(!records.some(r => r.phase === "sent"));
  const fresh = await readDeliveryLedger(f.ledger.path, { reply: event.reply, limit: 200 });
  assert.deepEqual(fresh.records, records); assert.equal(fresh.auditComplete, false);
});

test("complete multipart/album acknowledgment is one operation without captions or filenames in the ledger", async t => {
  const f = await fixture(t); const forms: FormData[] = [];
  const api = f.api(async (_url, init) => { forms.push(init!.body as FormData); return ok([]); });
  await api.sendGroup(123, [1, 2].map(n => ({ kind: "document", filename: `PRIVATE-${n}.txt`, data: Buffer.from("PRIVATE BODY") })), new AbortController().signal, undefined, { operation: "attachment", reply: event.reply });
  assert.equal(forms.length, 1); assert.equal(forms[0].get("caption"), null);
  const records = await f.read();
  assert.deepEqual(records.map(r => r.phase), ["send_attempt", "api_attempt", "api_ack", "sent"]);
  assert.equal(records.find(r => r.phase === "api_ack")!.album, 2);
  assert.equal(records.at(-1)!.outcome, "acknowledged");
  assert.ok(!JSON.stringify(records).includes("PRIVATE"));
});

for (const scenario of ["cancelled", "timeout", "malformed", "rejection", "incoming"] as const) test(`safe durable ${scenario} classification preserves outward semantics`, async t => {
  const f = await fixture(t); const controller = new AbortController();
  const api = f.api(async (_url, init) => {
    if (scenario === "malformed") return new Response("secret invalid acknowledgement");
    if (scenario === "rejection") return Response.json({ ok: false, error_code: 403, description: f.config.token });
    if (scenario === "timeout") await new Promise<void>(done => { init!.signal!.addEventListener("abort", () => done(), { once: true }); });
    throw new Error(f.config.token, { cause: { code: "ENOTFOUND" } });
  });
  if (scenario === "cancelled") controller.abort();
  await assert.rejects(api.call(scenario === "incoming" ? "getUpdates" : "sendMessage", {}, controller.signal, scenario === "timeout" ? 5 : 100), error => {
    if (scenario === "rejection") return error instanceof ApiError && error.code === 403;
    assert.ok(error instanceof TransportFailure);
    assert.equal(error.code, scenario === "cancelled" ? "TG_TRANSPORT_CANCELLED" : scenario === "timeout" ? "TG_TRANSPORT_TIMEOUT" : scenario === "malformed" ? "TG_TRANSPORT_RESPONSE" : "TG_TRANSPORT_FAILED");
    assert.equal(error.deliveryOutcome, scenario === "incoming" ? "not_applicable" : "unknown");
    assert.ok(!error.message.includes(f.config.token)); return true;
  });
  const records = await f.read(); const last = records.at(-1)!;
  assert.equal(last.phase, scenario === "rejection" ? "api_rejected" : "api_failed");
  assert.equal(last.operation, scenario === "incoming" ? "incoming" : "service");
  assert.equal(last.outcome, scenario === "incoming" ? "not_applicable" : scenario === "rejection" ? "rejected" : "unknown");
  assert.ok(!JSON.stringify(records).includes(f.config.token));
});

test("explicit 429 alone retries with numbered rejected/acknowledged attempts", async t => {
  const f = await fixture(t); let calls = 0;
  const api = f.api(async () => ++calls === 1 ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0.001 } }) : ok());
  await api.sendText(123, "synthetic", new AbortController().signal);
  const records = await f.read();
  assert.deepEqual(records.map(r => r.phase), ["send_attempt", "api_attempt", "api_rejected", "api_attempt", "api_ack", "sent"]);
  assert.equal(records[2].rejection, "rate_limit"); assert.equal(records[3].attempt, 2); assert.equal(calls, 2);
});

test("failure after a 429 backoff revalidation does not upload again or falsify the API rejection", async t => {
  const f = await fixture(t); let validations = 0, calls = 0;
  const api = f.api(async () => { calls++; return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0.001 } }); });
  await assert.rejects(api.call("sendMessage", {}, new AbortController().signal, 100, () => { if (++validations === 2) throw new Error("private refusal"); }));
  assert.equal(calls, 1);
  const records = await f.read(); assert.equal(records.at(-1)!.outcome, "suppressed"); assert.equal(records.at(-1)!.reason, "local_failure");
});

test("unacknowledged attempts remain pending after writer/process loss; no reconstructed success or replay", async t => {
  const f = await fixture(t); await f.ledger.append(event); await f.ledger.flush();
  const records = await f.read();
  assert.equal(records.length, 1); assert.equal(records[0].outcome, "pending"); assert.equal(records[0].phase, "api_attempt");
});

test("strict persistence rejects payloads, hostile getters, arbitrary identifiers and secret-bearing causes", async t => {
  const f = await fixture(t);
  for (const bad of [{ ...event, text: "PRIVATE" }, { ...event, reply: "private-session-id" }, { ...event, cause: f.config.token }, { ...event, get reason() { throw new Error("PRIVATE"); } }]) await f.ledger.append(bad as DeliveryEvent);
  assert.equal(f.ledger.dropped, 4); assert.equal((await f.read()).length, 0);
});

test("corrupt, oversized, symlinked, hardlinked and unsafe-mode slots are never exposed or modified", async t => {
  const f = await fixture(t); await mkdir(f.ledger.path, { mode: 0o700 });
  const outside = resolve(f.root, "outside"); await writeFile(outside, "PRIVATE", { mode: 0o600 });
  await writeFile(resolve(f.ledger.path, "0000.json"), "PRIVATE malformed", { mode: 0o600 });
  await writeFile(resolve(f.ledger.path, "0001.json"), "x".repeat(LEDGER_RECORD_BYTES + 1), { mode: 0o600 });
  await symlink(outside, resolve(f.ledger.path, "0002.json")); await link(outside, resolve(f.ledger.path, "0003.json"));
  await writeFile(resolve(f.ledger.path, "0004.json"), "PRIVATE", { mode: 0o644 });
  const view = await readDeliveryLedger(f.ledger.path); assert.equal(view.skipped, 5); assert.deepEqual(view.records, []);
  await f.ledger.append(event); await f.read();
  assert.equal((await readDeliveryLedger(f.ledger.path)).skipped, 5);
  assert.equal(await readFile(outside, "utf8"), "PRIVATE");
  assert.equal((await stat(outside)).mode & 0o777, 0o600);
});

test("ancestor symlinks and writable directories fail closed without chmod or touching aliased state", async t => {
  const f = await fixture(t); const target = resolve(f.root, "target"); await mkdir(target, { mode: 0o700 });
  const alias = resolve(f.root, "alias"); await symlink(target, alias);
  const ledger = new DeliveryLedger(resolve(alias, "diagnostics")); await ledger.append(event);
  assert.equal(ledger.dropped, 1); assert.deepEqual(await readdir(target), []);
  assert.equal((await readDeliveryLedger(ledger.path)).state, "unavailable");
  await chmod(target, 0o777); const unsafe = new DeliveryLedger(resolve(target, "diagnostics")); await unsafe.append(event);
  assert.equal(unsafe.dropped, 1); assert.equal((await stat(target)).mode & 0o777, 0o777);
});

test("offline slot conversion preserves bounds and expiry without automatic cleanup by a live writer", async t => {
  const f = await fixture(t); await mkdir(f.ledger.path, { mode: 0o700 });
  const old = { ...event, v: 1, at: Date.now() - LEDGER_RETENTION_MS - 10_000, event: randomUUID() };
  const bytes = JSON.stringify(old);
  await Promise.all(Array.from({ length: LEDGER_SLOTS }, async (_, n) => {
    const path = resolve(f.ledger.path, `${n.toString().padStart(4, "0")}.json`);
    await writeFile(path, bytes, { mode: 0o600 }); await utimes(path, new Date(old.at), new Date(old.at));
  }));
  assert.equal((await readDeliveryLedger(f.ledger.path)).records.length, 0);
  await f.ledger.append(event); await f.read(); assert.equal(f.ledger.dropped, 1);
  assert.equal((await readdir(f.ledger.path)).length, LEDGER_SLOTS, "new live writer never cleans old-runtime slots");
  assert.deepEqual(await migrateDeliveryLedger(f.ledger.path, { writersStopped: true }), { retained: 0, removed: LEDGER_SLOTS });
  for (let n = 0; n < 25; n++) await f.ledger.append(event);
  await f.read();
  const names = await readdir(f.ledger.path); assert.deepEqual(names.sort(), ["events.jsonl", "writer.lock"]);
  const view = await readDeliveryLedger(f.ledger.path, { limit: 10 }); assert.equal(view.records.length, 10); assert.equal(view.truncated, true);
  for (const name of names) { const s = await stat(resolve(f.ledger.path, name)); assert.ok(s.size <= LEDGER_SLOTS * LEDGER_RECORD_BYTES); assert.equal(s.mode & 0o777, 0o600); }
  assert.equal((await stat(f.ledger.path)).mode & 0o777, 0o700);
});

test("independent subprocess writers coordinate JSONL appends, with best-effort contention drops", async t => {
  const f = await fixture(t);
  const code = `import { DeliveryLedger } from ${JSON.stringify(resolve(import.meta.dirname, "../src/delivery-ledger.ts"))}; const l = new DeliveryLedger(process.argv[1]); let successful=0; for(let n=0;n<500 && successful<20;n++) { const before=l.dropped; await l.append({phase:'api_attempt',operation:'service',outcome:'pending'}); while(l.pendingWrites) await l.flush(); if(l.dropped===before) successful++; else await new Promise(r=>setTimeout(r,10+Math.random()*20)); } if(successful!==20) process.exitCode=2;`;
  await Promise.all([1, 2, 3].map(() => new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, f.ledger.path], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stderr.on("data", data => { output += data; }); child.on("error", reject);
    child.on("close", status => status === 0 ? done() : reject(new Error(`Synthetic writer ${status}: ${output}`)));
  })));
  const records = await f.read(); assert.equal(records.length, 60); assert.equal(new Set(records.map(r => r.event)).size, 60);
  assert.deepEqual((await readdir(f.ledger.path)).sort(), ["events.jsonl", "writer.lock"]);
});

test("diagnostic persistence failures and throwing observers never change delivery success, errors or retry count", async t => {
  const f = await fixture(t); await writeFile(f.ledger.path, "PRIVATE", { mode: 0o600 });
  let calls = 0;
  const api = f.api(async () => { calls++; return ok(); }); await api.sendText(123, "SYNTHETIC", new AbortController().signal);
  assert.equal(calls, 1); await f.read(); assert.ok(f.ledger.dropped >= 4); assert.equal(await readFile(f.ledger.path, "utf8"), "PRIVATE");
  const broken = { append() { throw new Error("PRIVATE"); } } as unknown as DeliveryLedger;
  const throwing = new TelegramApi(f.config, async () => { calls++; throw new Error("PRIVATE", { cause: { code: "ECONNRESET" } }); }, broken);
  await assert.rejects(throwing.sendText(123, "SYNTHETIC", new AbortController().signal), e => e instanceof TransportFailure && e.causeCode === "ECONNRESET");
  assert.equal(calls, 2);
});

test("malformed success envelopes and secret-bearing API code fields cannot produce a false acknowledgment or raw error", async t => {
  const f = await fixture(t);
  for (const result of [undefined, null]) {
    const api = f.api(async () => Response.json({ ok: true, ...(result === undefined ? {} : { result }) }));
    await assert.rejects(api.call("sendMessage", {}, new AbortController().signal), e => e instanceof TransportFailure && e.code === "TG_TRANSPORT_RESPONSE" && e.deliveryOutcome === "unknown");
  }
  const api = f.api(async () => Response.json({ ok: false, error_code: f.config.token, parameters: { retry_after: f.config.token } }));
  await assert.rejects(api.call("sendMessage", {}, new AbortController().signal), e => e instanceof ApiError && !e.message.includes(f.config.token));
  assert.ok(!(await f.read()).some(r => r.phase === "api_ack"));
});

test("foreign-owned ancestors and final state directories are refused without creating or changing state", async t => {
  const f = await fixture(t);
  if (process.getuid?.() !== 0) { t.skip("Synthetic foreign ownership needs fixture-local chown authority"); return; }
  const foreign = resolve(f.root, "foreign"); await mkdir(foreign, { mode: 0o700 }); await chown(foreign, 65534, 65534);
  const ledger = new DeliveryLedger(resolve(foreign, "diagnostics")); await ledger.append(event);
  assert.equal(ledger.dropped, 1); assert.deepEqual(await readdir(foreign), []);
  assert.equal((await stat(foreign)).uid, 65534);
  const final = new DeliveryLedger(foreign); await final.append(event); assert.equal(final.dropped, 1);
});

test("actual fetch throws with cyclic, hostile or secret-bearing exceptions retain only closed codes end to end", async t => {
  const f = await fixture(t); let getters = 0, calls = 0;
  const cycle: any = { message: f.config.token, code: f.config.token }; cycle.cause = cycle;
  const hostile = { get code() { getters++; throw new Error(f.config.token); }, get message() { getters++; throw new Error(f.config.token); }, get cause() { getters++; throw new Error(f.config.token); } };
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(f.config.token); } });
  for (const exception of [cycle, hostile, proxy, new Error(f.config.token, { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID", message: f.config.token } })]) {
    await assert.rejects(f.api(async () => { calls++; throw exception; }).sendText(123, "PRIVATE reply", new AbortController().signal), e => e instanceof TransportFailure && !e.message.includes(f.config.token));
  }
  const records = await f.read(); assert.equal(calls, 4); assert.equal(getters, 0);
  assert.deepEqual(records.filter(r => r.phase === "api_failed").map(r => r.cause), ["unknown", "unknown", "unknown", "ERR_TLS_CERT_ALTNAME_INVALID"]);
  for (const privateValue of [f.config.token, "PRIVATE", "https:", "stack", "message"]) assert.ok(!JSON.stringify(records).includes(privateValue));
});

test("diagnostic classification of a hostile local refusal preserves the original result and starts no upload", async t => {
  const f = await fixture(t); let calls = 0;
  const refusal = new Proxy({}, { getPrototypeOf() { throw new Error(f.config.token); } });
  await assert.rejects(f.api(async () => { calls++; return ok(); }).call("sendMessage", {}, new AbortController().signal, 100, () => { throw refusal; }), error => error === refusal);
  assert.equal(calls, 0);
  const records = await f.read(); assert.equal(records.at(-1)!.outcome, "suppressed"); assert.ok(!JSON.stringify(records).includes(f.config.token));
});

test("an empty text operation is suppressed, never a fabricated API acknowledgment", async t => {
  const f = await fixture(t); let calls = 0;
  await f.api(async () => { calls++; return ok(); }).sendText(123, "", new AbortController().signal);
  const records = await f.read(); assert.equal(calls, 0); assert.equal(records.length, 1);
  assert.equal(records[0].phase, "suppressed"); assert.equal(records[0].reason, "empty_final"); assert.equal(records[0].outcome, "suppressed");
});

test("stalled logging has a bounded transport wait and queue, not a delivery lock or retry", async t => {
  const f = await fixture(t);
  (f.ledger as any).persist = () => new Promise<void>(() => {});
  let calls = 0;
  const started = Date.now(); await f.api(async () => { calls++; return ok(); }).sendText(123, "SYNTHETIC", new AbortController().signal);
  assert.equal(calls, 1); assert.ok(Date.now() - started < 1500);
  await Promise.all(Array.from({ length: 300 }, () => f.ledger.append(event)));
  assert.equal(f.ledger.pendingWrites, 256); assert.ok(f.ledger.dropped >= 44);
  await f.ledger.flush();
});
