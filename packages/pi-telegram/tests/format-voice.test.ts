import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { TelegramApi, audioUpload, type OutgoingFile } from "../src/api.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { formattedChunks, telegramFormat } from "../src/format.ts";
import { isOpus, joinSpeech, speechChunks } from "../src/voice.ts";

const workspace = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
await mkdir(workspace, { recursive: true });
const config: Config = { token: "TEST-TOKEN", allowed: new Set(["123"]), groqKey: "TEST-GROQ", elevenKey: "TEST-ELEVEN", voiceId: "chosen-voice", modelId: "eleven_v4", dataDir: workspace };
const signal = new AbortController().signal;
const ok = (result: unknown) => Response.json({ ok: true, result });

test("one agent-relative Telegram home is independent of cwd; state is separate from downloads", async () => {
  const env = { PI_CODING_AGENT_DIR: resolve(workspace, "isolated-agent"), TELEGRAM_BOT_TOKEN: "fixture-token", TELEGRAM_ALLOWED_ID: "123" };
  const first = await loadConfig(resolve(workspace, "project-a"), env);
  const second = await loadConfig(resolve(workspace, "project-b"), env);
  for (const key of ["dataDir", "stateDir", "lockDir", "tmpDir"] as const) assert.equal(first[key], second[key]);
  assert.equal(first.stateDir, resolve(env.PI_CODING_AGENT_DIR, "pi-telegram", "state"));
  assert.equal(first.dataDir, resolve(env.PI_CODING_AGENT_DIR, "pi-telegram", "downloads"));
});

test("Markdown becomes native bold/italic/code/link entities, with correct emoji offsets", () => {
  const result = telegramFormat("😀 **bold** and *soft* with `x_y` and [link](https://example.com).");
  assert.equal(result.text, "😀 bold and soft with x_y and link.");
  assert.deepEqual(result.entities.find(entity => entity.type === "bold"), { type: "bold", offset: 3, length: 4 });
  assert.equal(result.entities.find(entity => entity.type === "text_link")!.url, "https://example.com");
  assert.ok(!result.text.includes("**") && !result.text.includes("`"));
});

test("headings, lists, tables and fenced code are Telegram-readable", () => {
  const result = telegramFormat("# Result\n\n- First\n- Second\n\n| Name | Value |\n|---|---|\n| A | 42 |\n\n```js\nconst x = '<&>';\n```");
  assert.match(result.text, /^Result\n\n• First\n• Second/);
  assert.match(result.text, /Name: A\nValue: 42/);
  assert.match(result.text, /const x = '<&>';/);
  assert.equal(result.entities.find(entity => entity.type === "pre")!.language, "js");
});

test("raw HTML and unsafe link schemes cannot become Telegram markup or executable links", () => {
  const result = telegramFormat("<b>literal</b> and [unsafe](javascript:alert) and [safe](https://example.com?q=a&b=c)");
  assert.match(result.text, /<b>literal<\/b>/);
  assert.equal(result.entities.filter(entity => entity.type === "text_link").length, 1);
  assert.equal(result.entities.find(entity => entity.type === "text_link")!.url, "https://example.com?q=a&b=c");
});

test("formatting is preserved across long chunks without splitting emoji or invalidating offsets", () => {
  const result = telegramFormat(`**${"hello 😀 ".repeat(1600)}**`);
  const chunks = formattedChunks(result);
  assert.equal(chunks.map(chunk => chunk.text).join(""), result.text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 4096 && !/[\uD800-\uDBFF]$/.test(chunk.text));
    assert.ok(chunk.entities.every(entity => entity.offset >= 0 && entity.offset + entity.length <= chunk.text.length));
  }
});

test("Telegram text API gets entities, never a fragile parse_mode", async () => {
  const sent: any[] = [];
  const api = new TelegramApi(config, async (_url, init) => { sent.push(JSON.parse(init!.body as string)); return ok({}); });
  await api.sendText(123, "**Done** with `file.txt`.", signal);
  assert.equal(sent[0].text, "Done with file.txt.");
  assert.equal(sent[0].parse_mode, undefined);
  assert.deepEqual(sent[0].entities.map((entity: any) => entity.type), ["bold", "code"]);
});

test("multiple photos/videos are one captionless sendMediaGroup operation", async () => {
  const sent: { url: string; form: FormData }[] = [];
  const api = new TelegramApi(config, async (url, init) => { sent.push({ url: String(url), form: init!.body as FormData }); return ok([]); });
  const files: OutgoingFile[] = [{ data: Buffer.from("photo"), filename: "one.jpg", kind: "photo" }, { data: Buffer.from("video"), filename: "two.mp4", kind: "video" }];
  await api.sendGroup(123, files, signal);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].url.endsWith("/sendMediaGroup"));
  const media = JSON.parse(String(sent[0].form.get("media")));
  assert.deepEqual(media, [{ type: "photo", media: "attach://file0" }, { type: "video", media: "attach://file1" }]);
  assert.equal(sent[0].form.get("caption"), null);
  assert.ok(sent[0].form.get("file0") instanceof File);
});

test("albums validate all files before sending, including credentials, size and type restrictions", async () => {
  const api = new TelegramApi(config, async () => { assert.fail("Invalid albums must not touch the network"); });
  const photo: OutgoingFile = { data: Buffer.from("photo"), filename: "p.jpg", kind: "photo" };
  const document: OutgoingFile = { data: Buffer.from("doc"), filename: "d.txt", kind: "document" };
  await assert.rejects(api.sendGroup(123, [photo, document], signal), /cannot mix/);
  await assert.rejects(api.sendGroup(123, [photo, { ...photo, kind: "voice" }], signal), /voice notes/);
  await assert.rejects(api.sendGroup(123, Array.from({ length: 11 }, () => photo), signal), /2–10/);
  await assert.rejects(api.sendGroup(123, [photo, { ...photo, data: Buffer.from(config.groqKey!) }], signal), /credentials/);
});

test(".oga and OGG .opus uploads use a supported .ogg extension and audio/ogg MIME without conversion", () => {
  const data = Buffer.from("OggS---OpusHead audio");
  for (const name of ["voice.oga", "voice.opus", "voice.bin"]) assert.deepEqual(audioUpload(data, name), { filename: "voice.ogg", mime: "audio/ogg" });
  assert.throws(() => audioUpload(Buffer.from("unknown"), "unknown.bin"), /Unsupported/);
});

test("v4 adds restrained default audio guidance and preserves intentional expressive tags", () => {
  assert.deepEqual(speechChunks("Hello, sir.", "eleven_v4"), ["[warm, composed voice] Hello, sir."]);
  assert.deepEqual(speechChunks("[curious] Is this working? [pause] Yes.", "eleven_v4"), ["[curious] Is this working? [pause] Yes."]);
  assert.deepEqual(speechChunks("Hello.", "other-configured-model"), ["Hello."]);
  assert.ok(speechChunks('Hello <break time="1s" /> sir.', "eleven_v4")[0].includes("[pause]"));
});

test("v4 chunking never splits tags or emoji and carries opening delivery into later chunks", () => {
  const chunks = speechChunks(`[warm, composed voice] ${"A sentence with 😀. ".repeat(250)}[whispers] Quiet now.`, "eleven_v4", 120);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 120);
    assert.ok(chunk.startsWith("[warm, composed voice]"));
    assert.equal((chunk.match(/\[/g) || []).length, (chunk.match(/\]/g) || []).length);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
  }
});

test("v4 generation sends tags to exactly the configured model without unsupported controls", async () => {
  const requests: any[] = [];
  const api = new TelegramApi(config, async (_url, init) => { requests.push(JSON.parse(init!.body as string)); return new Response(Buffer.from("OggS---OpusHead data")); });
  await api.generateSpeech("Hello, sir.", signal);
  assert.deepEqual(requests, [{ text: "[warm, composed voice] Hello, sir.", model_id: "eleven_v4" }]);
  assert.equal(Object.hasOwn(requests[0], "voice_settings"), false);
});

test("long speech generations are combined into one valid native OGG/Opus file, scratch data removed", async t => {
  const dir = await mkdtemp(resolve(workspace, "telegram-speech-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sample = resolve(dir, "tone.ogg");
  await new Promise<void>((done, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=400:duration=0.1", "-c:a", "libopus", sample], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", code => code === 0 ? done() : reject(new Error("Unable to generate offline audio fixture")));
  });
  const tone = await readFile(sample);
  const combined = await joinSpeech([tone, tone], resolve(dir, "tmp"), signal);
  assert.ok(isOpus(combined));
  assert.deepEqual(await readdir(resolve(dir, "tmp")), []);
  const sent: string[] = [];
  const api = new TelegramApi({ ...config, tmpDir: resolve(dir, "tmp") }, async (url) => {
    sent.push(String(url).includes("elevenlabs.io") ? "generate" : String(url).split("/").pop()!);
    return String(url).includes("elevenlabs.io") ? new Response(new Uint8Array(tone)) : ok({});
  });
  await api.speak(123, "A long spoken sentence. ".repeat(180), signal);
  assert.ok(sent.filter(method => method === "generate").length > 1);
  assert.equal(sent.filter(method => method === "sendVoice").length, 1);
  assert.ok(!sent.includes("sendMessage"));
});

test("nested Markdown code never overlaps forbidden Telegram formatting entities", () => {
  const result = telegramFormat("**Bold with `code` inside** and [a `code` link](https://example.com)");
  for (const code of result.entities.filter(entity => entity.type === "code")) {
    assert.ok(result.entities.filter(entity => entity !== code).every(entity => entity.offset >= code.offset + code.length || entity.offset + entity.length <= code.offset));
  }
  assert.equal(result.text, "Bold with code inside and a code link");
});

test("very dense Markdown degrades only styling, not text, at Telegram's entity limit", () => {
  const formatted = telegramFormat("**bold** ".repeat(200));
  const chunks = formattedChunks(formatted);
  assert.equal(chunks.map(chunk => chunk.text).join(""), formatted.text);
  assert.ok(chunks.every(chunk => chunk.entities.length <= 100));
});
