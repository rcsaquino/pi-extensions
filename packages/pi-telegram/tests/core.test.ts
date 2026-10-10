import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { ApiError, DOWNLOAD_LIMIT, TelegramApi, imageMime, outboundFile, readLimited, safeFilename, type Fetch } from "../src/api.ts";
import { type Config, SafeError, loadConfig, parseAllowed, redact, safeError, splitText, stamp } from "../src/config.ts";

const workspace = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
await mkdir(workspace, { recursive: true });
const config: Config = { token: "TEST-BOT-SECRET", allowed: new Set(["123"]), groqKey: "TEST-GROQ-SECRET", elevenKey: "TEST-ELEVEN-SECRET", voiceId: "chosen-voice", modelId: "configured-model", dataDir: workspace };
const signal = new AbortController().signal;
const ok = (result: unknown) => Response.json({ ok: true, result });

test("allowlist accepts single, delimited and JSON IDs", () => {
  for (const value of ["123,456", "123 456", "123;456", '[123,"456"]']) assert.deepEqual([...parseAllowed(value)], ["123", "456"]);
  assert.deepEqual([...parseAllowed("123")], ["123"]);
});

test("allowlist fails closed for empty, wildcards, malformed and unsafe IDs", () => {
  for (const value of ["", "*", "123,bad", "0", "-1", "[]", "[1,]", "[true]", "9007199254740999", "null"]) assert.throws(() => parseAllowed(value), SafeError);
});

test(".env takes precedence, supports quotes and does not mutate process.env", async () => {
  const dir = await mkdtemp(resolve(workspace, "telegram-config-"));
  try {
    await writeFile(resolve(dir, ".env"), 'TELEGRAM_BOT_TOKEN="file-token"\nTELEGRAM_ALLOWED_ID="123,456"\nGROQ_API_KEY=\nELEVENLABS_MODEL_ID=configured-v4\n');
    const before = process.env.TELEGRAM_BOT_TOKEN;
    const cfg = await loadConfig(dir, { PI_CODING_AGENT_DIR: resolve(dir, "agent"), TELEGRAM_BOT_TOKEN: "stale-token", TELEGRAM_ALLOWED_ID: "789", GROQ_API_KEY: "stale-key" });
    assert.equal(cfg.token, "file-token");
    assert.equal(cfg.groqKey, undefined);
    assert.equal(cfg.modelId, "configured-v4");
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("agent .env is used without reading configuration from the generated-data home", async () => {
  const dir = await mkdtemp(resolve(workspace, "telegram-layout-"));
  const agent = resolve(dir, "agent");
  try {
    await mkdir(resolve(agent, "pi-telegram"), { recursive: true });
    await writeFile(resolve(agent, ".env"), 'TELEGRAM_BOT_TOKEN=agent-token\nTELEGRAM_ALLOWED_ID=123\nGROQ_API_KEY=agent-groq\n');
    await writeFile(resolve(agent, "pi-telegram", ".env"), 'TELEGRAM_BOT_TOKEN=wrong-data-home-token\nTELEGRAM_ALLOWED_ID=456\n');
    const cfg = await loadConfig(dir, { PI_CODING_AGENT_DIR: agent, TELEGRAM_BOT_TOKEN: "stale-token", TELEGRAM_ALLOWED_ID: "789" });
    assert.equal(cfg.token, "agent-token");
    assert.equal(cfg.groqKey, "agent-groq");
    assert.deepEqual([...cfg.allowed], ["123"]);
    assert.equal(cfg.dataDir, resolve(agent, "pi-telegram", "downloads"));
    assert.equal(cfg.stateDir, resolve(agent, "pi-telegram", "state"));
    assert.equal(cfg.lockDir, resolve(agent, "pi-telegram", "locks"));
    assert.equal(cfg.tmpDir, resolve(agent, "pi-telegram", "tmp"));
    await writeFile(resolve(dir, ".env"), 'TELEGRAM_BOT_TOKEN=cwd-token\nTELEGRAM_ALLOWED_ID=456\n');
    assert.equal((await loadConfig(dir, { PI_CODING_AGENT_DIR: agent })).token, "cwd-token");
    await writeFile(resolve(dir, "explicit.env"), 'TELEGRAM_BOT_TOKEN=explicit-token\nTELEGRAM_ALLOWED_ID=789\n');
    assert.equal((await loadConfig(dir, { PI_CODING_AGENT_DIR: agent, TELEGRAM_ENV_FILE: "explicit.env" })).token, "explicit-token");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("explicit .env path fails closed if missing", async () => {
  await assert.rejects(loadConfig(workspace, { TELEGRAM_ENV_FILE: "missing-telegram-test.env", TELEGRAM_BOT_TOKEN: "fallback", TELEGRAM_ALLOWED_ID: "123" }), SafeError);
});

test("errors and redaction never include network URLs or configured keys", () => {
  assert.equal(safeError(new Error(`network URL contains ${config.token}`)).includes(config.token), false);
  const text = redact(`${config.token} ${config.groqKey} ${config.elevenKey}`, config);
  assert.equal(text, "[REDACTED] [REDACTED] [REDACTED]");
});

test("incoming timestamps are one leading second-only ISO 8601 field in the host timezone", () => {
  const previous = process.env.TZ;
  try {
    for (const [zone, date, expected] of [
      ["Asia/Manila", "2026-10-02T12:34:56Z", "2026-10-02T20:34:56+08:00"],
      ["UTC", "2026-10-02T12:34:56Z", "2026-10-02T12:34:56+00:00"],
      ["Asia/Kathmandu", "2026-10-02T12:34:56Z", "2026-10-02T18:19:56+05:45"],
      ["America/New_York", "2026-07-02T12:34:56Z", "2026-07-02T08:34:56-04:00"],
      ["America/New_York", "2026-01-02T12:34:56Z", "2026-01-02T07:34:56-05:00"],
      ["UTC", "2026-10-02T12:34:56.987Z", "2026-10-02T12:34:56+00:00"],
      ["Asia/Kathmandu", "2026-10-02T12:34:56.999Z", "2026-10-02T18:19:56+05:45"],
      ["America/St_Johns", "2026-01-02T00:04:05.999Z", "2026-01-01T20:34:05-03:30"],
      ["Asia/Manila", "2026-12-31T23:59:59.999Z", "2027-01-01T07:59:59+08:00"],
    ]) {
      process.env.TZ = zone;
      assert.equal(stamp("hello", new Date(date)), `[${expected}] hello`);
      assert.equal(stamp("multi\nline 😀  ", new Date(date)), `[${expected}] multi\nline 😀  `);
      assert.equal(stamp("", new Date(date)), `[${expected}] `);
      assert.equal(Date.parse(expected), Math.floor(Date.parse(date) / 1000) * 1000);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("chunking is lossless, length bounded and does not split surrogate pairs", () => {
  for (const text of ["x".repeat(9000), "a".repeat(20) + " " + "b".repeat(100), "hello 😀 ".repeat(1200)]) {
    const parts = splitText(text, 21);
    assert.equal(parts.join(""), text);
    assert.ok(parts.every(part => part.length <= 21));
    assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/.test(part)));
    assert.ok(parts.every(part => !/^[\uDC00-\uDFFF]/.test(part)));
  }
});

test("text delivery splits at Telegram limits without metadata on any chunk", async () => {
  const sent: Record<string, string>[] = [];
  const api = new TelegramApi(config, async (_url, init) => { sent.push(JSON.parse(init!.body as string)); return ok({}); });
  await api.sendText(123, "😀 ".repeat(4000) + config.token, signal);
  assert.ok(sent.length > 1);
  assert.ok(sent.every(item => item.text.length <= 4096 && !/\[\d{4}-/.test(item.text) && !item.text.includes(config.token)));
  assert.equal(sent.map(item => item.text).join(""), "😀 ".repeat(4000) + "[REDACTED]");
});

test("all media kinds use native multipart methods and never attach captions", async () => {
  const calls: { method: string; form: FormData }[] = [];
  const api = new TelegramApi(config, async (url, init) => { calls.push({ method: String(url).split("/").pop()!, form: init!.body as FormData }); return ok({}); });
  for (const kind of ["document", "photo", "video", "voice"] as const) await api.sendMedia(123, kind, Buffer.from("data"), `${kind}.bin`, signal);
  assert.deepEqual(calls.map(call => call.method), ["sendDocument", "sendPhoto", "sendVideo", "sendVoice"]);
  for (const { form, method } of calls) {
    assert.equal(form.get("chat_id"), "123");
    assert.equal(form.get("caption"), null);
    assert.ok(form.get(method.slice(4).toLowerCase()) instanceof Blob);
  }
});

test("file delivery does not synthesize a filename caption or an extra chat", async () => {
  const bodies: FormData[] = [];
  const api = new TelegramApi(config, async (_url, init) => { bodies.push(init!.body as FormData); return ok({}); });
  await api.sendMedia(123, "document", Buffer.from("data"), "file.bin", signal);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].get("caption"), null);
});

test("credential-bearing file bytes are not forwarded", async () => {
  const api = new TelegramApi(config, async () => { assert.fail("network must not be called"); });
  await assert.rejects(api.sendMedia(123, "document", Buffer.from(`data ${config.groqKey}`), "normal.txt", signal), /credentials/);
});

test("advertised and streaming download size limits are enforced", async () => {
  await assert.rejects(readLimited(new Response("x", { headers: { "content-length": "999" } }), 10), /size limit/);
  await assert.rejects(readLimited(new Response("01234567890"), 10), /size limit/);
  const api = new TelegramApi(config, async () => { assert.fail("oversized files must be rejected before network access"); });
  await assert.rejects(api.download({ file_id: "file", file_size: DOWNLOAD_LIMIT + 1 }, signal), /20 MB/);
});

test("download errors do not expose bot URLs", async () => {
  const api = new TelegramApi(config, async () => { throw new Error(`bad URL ${config.token}`); });
  await assert.rejects(api.download({ file_id: "file" }, signal), error => !String(error).includes(config.token));
});

test("Groq receives actual audio multipart and configured key; transcript is redacted", async () => {
  const api = new TelegramApi(config, async (url, init) => {
    assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
    assert.equal((init!.headers as Record<string, string>).authorization, `Bearer ${config.groqKey}`);
    const form = init!.body as FormData;
    assert.equal(form.get("model"), "whisper-large-v3-turbo");
    assert.equal((form.get("file") as File).name, "voice.ogg");
    assert.equal((form.get("file") as File).type, "audio/ogg");
    assert.equal(await (form.get("file") as Blob).text(), "audio bytes");
    return Response.json({ text: `hello ${config.token}` });
  });
  assert.equal(await api.transcribe(Buffer.from("audio bytes"), "voice.oga", signal), "hello [REDACTED]");
});

test("missing Groq key and empty transcript produce useful safe errors", async () => {
  await assert.rejects(new TelegramApi({ ...config, groqKey: undefined }).transcribe(Buffer.from("x"), "voice.ogg", signal), /GROQ_API_KEY/);
  await assert.rejects(new TelegramApi(config, async () => Response.json({ text: "" })).transcribe(Buffer.from("x"), "voice.ogg", signal), /no usable text/);
});

test("ElevenLabs uses exact configured model and voice, returning native OGG/Opus", async () => {
  const calls: string[] = [];
  const api = new TelegramApi(config, async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("elevenlabs.io")) {
      assert.match(String(url), /chosen-voice\?output_format=opus_48000_64$/);
      assert.equal(JSON.parse(init!.body as string).model_id, config.modelId);
      assert.equal((init!.headers as Record<string, string>)["xi-api-key"], config.elevenKey);
      return new Response(Buffer.from("OggS header OpusHead audio"));
    }
    const form = init!.body as FormData;
    assert.equal((form.get("voice") as File).name, "reply.ogg");
    assert.equal((form.get("voice") as File).type, "audio/ogg");
    assert.equal(form.get("caption"), null);
    return ok({});
  });
  await api.speak(123, "Hello.", signal);
  assert.equal(calls.length, 2);
});

test("TTS errors do not downgrade the model or silently send incorrect formats", async () => {
  let count = 0;
  const badApi = new TelegramApi(config, async () => { count++; return new Response("no", { status: 400 }); });
  await assert.rejects(badApi.speak(123, "Hello.", signal), /configured model was not changed/);
  assert.equal(count, 1);
  await assert.rejects(new TelegramApi(config, async () => new Response("not ogg")).speak(123, "Hello.", signal), /no format or model fallback/);
});

test("API errors never expose Telegram description, including secrets", async () => {
  const api = new TelegramApi(config, async () => Response.json({ ok: false, error_code: 409, description: config.token }));
  await assert.rejects(api.call("getUpdates", {}, signal), error => error instanceof ApiError && error.code === 409 && !error.message.includes(config.token));
});

test("ambiguous outgoing network failures are precise, unknown, secret-free and not retried", async () => {
  let count = 0;
  const api = new TelegramApi(config, async () => { count++; throw new Error(`network down ${config.token} https://private.example/path`); });
  await assert.rejects(api.sendText(123, "hello", signal), error => {
    assert.match((error as Error).message, /TG_TRANSPORT_FAILED/);
    assert.match((error as Error).message, /Delivery outcome unknown/);
    assert.ok(!(error as Error).message.includes(config.token));
    assert.ok(!(error as Error).message.includes("https:"));
    assert.ok(!(error as Error).message.includes("deadline elapsed"));
    return true;
  });
  assert.equal(count, 1);
});

test("outgoing deadline, cancellation and unreadable acknowledgements do not invent delivery outcomes", async () => {
  const abortedFetch: Fetch = async (_url, init) => new Promise((_done, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("Synthetic lost acknowledgement")), { once: true });
  });
  const api = new TelegramApi(config, abortedFetch);
  await assert.rejects(api.call("sendDocument", new FormData(), signal, 10), /TG_TRANSPORT_TIMEOUT.*Delivery outcome unknown/);
  const controller = new AbortController();
  const sent = api.call("sendDocument", new FormData(), controller.signal, 1000);
  controller.abort();
  await assert.rejects(sent, /TG_TRANSPORT_CANCELLED.*Delivery outcome unknown/);
  let attempts = 0;
  const malformed = new TelegramApi(config, async () => { attempts++; return new Response("Invalid acknowledgement"); });
  await assert.rejects(malformed.call("sendDocument", new FormData(), signal), /TG_TRANSPORT_RESPONSE.*Delivery outcome unknown/);
  assert.equal(attempts, 1);
});

test("an explicit 429 retry revalidates delivery authority rather than replaying revoked uploads", async () => {
  let calls = 0, checks = 0;
  const api = new TelegramApi(config, async () => { calls++; return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0.001 } }); });
  await assert.rejects(api.sendMedia(123, "document", Buffer.from("Synthetic"), "artifact.txt", signal, () => {
    if (++checks > 1) throw new SafeError("Synthetic authority revoked");
  }), /authority revoked/);
  assert.equal(calls, 1); assert.equal(checks, 2);
});

test("filename sanitization cannot escape the download directory", () => {
  for (const name of ["../../etc/passwd", "..\\..\\evil.txt", "\nsecret\u0000.txt", ".env", ""]) {
    assert.ok(!safeFilename(name).includes("/") && !safeFilename(name).includes("\\") && !safeFilename(name).startsWith("."));
  }
  assert.equal(safeFilename("case report.pdf"), "case report.pdf");
});

test("image types are determined by bytes, not hostile MIME labels", () => {
  assert.equal(imageMime(Buffer.from([255, 216, 255, 0])), "image/jpeg");
  assert.equal(imageMime(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.equal(imageMime(Buffer.from("not an image")), undefined);
});

test("outbound files stay inside cwd and secret paths are denied, including symlinks", async () => {
  const dir = await mkdtemp(resolve(workspace, "telegram-files-"));
  const outside = await mkdtemp(resolve(workspace, "telegram-outside-"));
  try {
    await mkdir(resolve(dir, "nested"));
    await writeFile(resolve(dir, "nested", "report.txt"), "report");
    await writeFile(resolve(dir, ".env"), "secret");
    await writeFile(resolve(outside, "outside.txt"), "outside");
    await symlink(resolve(outside, "outside.txt"), resolve(dir, "escape.txt"));
    assert.equal((await outboundFile(dir, "nested/report.txt")).kind, "document");
    await assert.rejects(outboundFile(dir, ".env"), /secret file/);
    await assert.rejects(outboundFile(dir, "escape.txt"), /working directory/);
    await assert.rejects(outboundFile(dir, resolve(outside, "outside.txt")), /working directory/);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
