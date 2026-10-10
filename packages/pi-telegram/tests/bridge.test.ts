import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { TelegramBridge } from "../src/bridge.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { type Fetch, type TgMessage, type TgUpdate } from "../src/api.ts";
import { DeliveryRefusal, stamp, type Config } from "../src/config.ts";
import { readDeliveryLedger } from "../src/delivery-ledger.ts";
import { references } from "./reply-context-fixture.ts";

const workspace = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
await mkdir(workspace, { recursive: true });
const config: Config = { token: "TEST-BOT-TOKEN", allowed: new Set(["123", "456"]), groqKey: "TEST-GROQ", elevenKey: "TEST-ELEVEN", voiceId: "voice-id", modelId: "exact-model-id", dataDir: workspace };
const ok = (result: unknown) => Response.json({ ok: true, result });
const message = (id = 1, text = "Hello", user = 123): TgMessage => ({ message_id: id, date: 1_791_000_000, chat: { id: user, type: "private" }, from: { id: user }, text });

async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) assert.fail("Timed out waiting for mocked bridge state");
    await delay(10);
  }
}

class Server {
  calls: { method: string; args: any }[] = [];
  updates: TgUpdate[][] = [];
  wake?: () => void;
  first = true;
  hook = "";
  fatal?: number;
  nextId = 1;
  file = Buffer.from([255, 216, 255, 0, 1, 2]);
  transcript = "A spoken request.";
  abortedPolls = 0;
  feed(msg: TgMessage, updateId = this.nextId++): void {
    this.updates.push([{ update_id: updateId, message: msg }]);
    this.wake?.();
  }
  fetch: Fetch = async (url, init) => {
    const method = String(url).split("/").pop()!;
    const args = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(init.body as string) : {};
    this.calls.push({ method, args });
    if (String(url).includes("api.groq.com")) return Response.json({ text: this.transcript });
    if (String(url).includes("api.elevenlabs.io")) return new Response(Buffer.from("OggS---OpusHead audio"));
    if (String(url).includes("/file/bot")) return new Response(new Uint8Array(this.file));
    if (this.fatal) return Response.json({ ok: false, error_code: this.fatal, description: "mock failure" });
    if (method === "getMe") return ok({ id: 999, username: "mock_bot" });
    if (method === "getWebhookInfo") return ok({ url: this.hook });
    if (method === "getFile") return ok({ file_path: args.file_id + ".ogg" });
    if (method === "getUpdates") {
      if (this.first) { this.first = false; return ok([]); }
      if (!this.updates.length) {
        await new Promise<void>((done, reject) => {
          const abort = () => { this.abortedPolls++; this.wake = undefined; reject(new Error("aborted")); };
          this.wake = () => { init?.signal?.removeEventListener("abort", abort); this.wake = undefined; done(); };
          init?.signal?.addEventListener("abort", abort, { once: true });
          if (init?.signal?.aborted) abort();
        });
      }
      return ok(this.updates.shift() || []);
    }
    return ok({ message_id: 200 });
  };
  texts(): { chat_id: number; text: string }[] { return this.calls.filter(call => call.method === "sendMessage").map(call => call.args); }
}

async function fixture(t: test.TestContext, options: { server?: Server; consume?: boolean; consumeReports?: boolean; mode?: string; lockDir?: string; start?: boolean } = {}) {
  const dir = await mkdtemp(resolve(workspace, "telegram-bridge-"));
  const server = options.server || new Server();
  const submissions: (TextContent | ImageContent)[][] = [];
  const deliveries: string[] = [];
  const consumers: (() => void)[] = [];
  const statuses: string[] = [];
  const notices: string[] = [];
  let idle = true;
  let aborts = 0;
  let sessionId = "fixture";
  let bridge: TelegramBridge;
  const ctx = {
    cwd: dir, mode: options.mode || "tui", hasUI: true,
    isIdle: () => idle, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId },
    abort: () => { aborts++; },
    ui: { setStatus: (_key: string, value: string) => statuses.push(value), notify: (value: string) => notices.push(value), theme: { fg: (_color: string, value: string) => value } },
  } as unknown as ExtensionContext;
  const events = createEventBus();
  const reports: any[] = [];
  const pi = { events, sendMessage: (msg: any) => {
    reports.push(msg); idle = false;
    if (options.consumeReports !== false) bridge.userStart({ role: "custom", ...msg });
  }, sendUserMessage: (content: (TextContent | ImageContent)[], opts: any) => {
    assert.equal(opts.expandPromptTemplates, false);
    deliveries.push(opts.deliverAs);
    submissions.push(content);
    const text = content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const images = content.filter(b => b.type === "image");
    bridge.input({ type: "input", source: "extension", text, images });
    const consume = AsyncResource.bind(() => {
      bridge.beforeStart(text, images);
      bridge.agentStart();
      idle = false;
      bridge.userStart({ role: "user", content });
    });
    consumers.push(consume);
    if (options.consume !== false) consume();
  } } as unknown as ExtensionAPI;
  bridge = new TelegramBridge(pi, ctx, { ...config, allowed: new Set(config.allowed), dataDir: resolve(dir, "downloads"), stateDir: resolve(dir, "state"), tmpDir: resolve(dir, "tmp"), lockDir: options.lockDir }, server.fetch);
  t.after(async () => { await bridge.stop(); await rm(dir, { recursive: true, force: true }); });
  if (options.start !== false) await bridge.start();
  return {
    dir, server, bridge, submissions, deliveries, statuses, notices, events, reports,
    consume: (index: number) => consumers[index](),
    setIdle: (value: boolean) => { idle = value; }, getAborts: () => aborts,
    setSessionId: (value: string) => { sessionId = value; },
    startReport: (index = reports.length - 1) => bridge.userStart({ role: "custom", ...reports[index] }),
    finish: async (text = "Final reply.", stopReason = "stop") => {
      bridge.assistantEnd({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text }], stopReason });
      idle = true;
      await bridge.settled();
    },
  };
}

// Top-level tests in this file are serial, and node:test isolates test files in separate processes.
// TestContext mocks restore every console method after all cleanup hooks, even on assertion failure.
function captureConsole(t: test.TestContext, throwing = false) {
  return (["log", "info", "debug", "warn", "error"] as const).map(method => t.mock.method(console, method, () => {
    if (throwing) throw new Error("PRIVATE terminal");
  }));
}

function assertConsoleSilent(mocks: ReturnType<typeof captureConsole>): void {
  for (const mock of mocks) assert.equal(mock.mock.callCount(), 0, "delivery metadata must not write to the terminal");
}

test("successful delivery and cancellation keep redacted ledger records without console or notification traces", { concurrency: false }, async t => {
  const terminal = captureConsole(t);
  const h = await fixture(t);
  h.server.feed({ ...message(1, "Private synthetic request body"),
    reply_to_message: { ...message(10, `PRIVATE quoted body ${config.token} ${config.groqKey} ${config.elevenKey}`), from: { id: 999, is_bot: true } } });
  await until(() => h.submissions.length === 1);
  assert.ok((h.submissions[0][0] as TextContent).text.includes("<telegram_reply_context>"));
  await h.finish("Private synthetic final body");
  h.server.feed(message(2, "Another private synthetic body"));
  await until(() => h.submissions.length === 2);
  h.bridge.input({ type: "input", source: "interactive", text: (h.submissions[1][0] as TextContent).text });
  await h.finish("Must not leak");
  await h.bridge.stop();
  const records = await ledgerRecords(h);
  const replies = records.filter(record => record.operation === "reply");
  assert.deepEqual(replies.map(item => item.phase), ["generated", "settled", "send_attempt", "api_attempt", "api_ack", "sent", "cancelled", "suppressed"]);
  assert.ok(records.some(record => record.operation === "incoming" && record.method === "getUpdates" && record.phase === "api_failed" && record.code === "TG_TRANSPORT_CANCELLED"), "shutdown retains poll cancellation metadata");
  const sent = records.filter(record => record.operation === "reply" && record.phase !== "cancelled" && record.phase !== "suppressed");
  const cancelled = records.filter(record => record.reason === "foreign_input");
  assert.ok(sent.every(record => record.reply === sent[0].reply));
  assert.equal(cancelled.length, 2);
  assert.ok(cancelled.every(record => record.reply === cancelled[0].reply && record.outcome === "suppressed"));
  assert.notEqual(sent[0].reply, cancelled[0].reply);
  const delivery = sent.filter(record => record.phase !== "generated");
  assert.ok(delivery.every(record => record.delivery === delivery[0].delivery));
  assert.equal(sent.find(record => record.phase === "sent")?.outcome, "acknowledged");
  for (const record of replies) {
    assert.ok(Object.keys(record).every(key => ["v", "at", "event", "writer", "sequence", "reply", "delivery", "revision", "operation", "outcome", "phase", "reason", "method", "attempt", "chunk", "chunks"].includes(key)));
    assert.match(record.reply!, /^[0-9a-f-]{36}$/);
  }
  for (const privateValue of ["Private synthetic", "Another private", "Must not leak", "PRIVATE quoted body", config.token, config.groqKey!, config.elevenKey!, h.dir]) {
    assert.ok(!JSON.stringify(records).includes(privateValue));
  }
  assert.equal(h.server.texts().length, 1, "cancelled final must not send");
  assert.deepEqual(h.notices, [], "routine traces must not become UI notifications");
  assertConsoleSilent(terminal);
});

test("authenticate before replying, downloading, STT or Pi dispatch; reject groups and bots", async t => {
  const h = await fixture(t);
  await until(() => h.bridge.status === "connected");
  const blocked = [message(1, "secret", 777), { ...message(2), chat: { id: -1, type: "group" } }, { ...message(3), from: { id: 123, is_bot: true } }, { ...message(4), from: undefined }];
  for (const msg of blocked) h.server.feed({ ...msg, voice: { file_id: "never-download" } });
  await delay(350);
  assert.equal(h.submissions.length, 0);
  assert.equal(h.server.texts().length, 0);
  assert.ok(!h.server.calls.some(call => call.method === "getFile"));
});

test("inbound text has only a leading second-only host-local sent timestamp; plain final only after settlement", async t => {
  const h = await fixture(t);
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  const text = (h.submissions[0][0] as TextContent).text;
  assert.equal(text, stamp("Hello", new Date(message().date * 1000)));
  const iso = text.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\] Hello$/)?.[1];
  assert.ok(iso);
  assert.equal(Date.parse(iso), message().date * 1000);
  assert.ok(!text.includes("Telegram user"));
  h.bridge.assistantEnd({ role: "assistant", content: [{ type: "text", text: "Working..." }, { type: "toolCall", name: "bash" }], stopReason: "toolUse" });
  h.bridge.assistantEnd({ role: "toolResult", content: [{ type: "text", text: "tool output" }] });
  assert.equal(h.server.texts().length, 0);
  await h.finish();
  assert.equal(h.server.texts().length, 1);
  assert.equal(h.server.texts()[0].text, "Final reply.");
  assert.ok(!h.server.texts()[0].text.includes("private"));
});

test("automatic retries/continuations replace intermediate replies without duplicate sends", async t => {
  const h = await fixture(t);
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  h.bridge.assistantEnd({ role: "assistant", content: [{ type: "text", text: "intermediate" }], stopReason: "stop" });
  h.bridge.assistantEnd({ role: "assistant", content: [{ type: "text", text: "provider failed" }], stopReason: "error" });
  assert.equal(h.server.texts().length, 0);
  await h.finish("Recovered final.");
  assert.equal(h.server.texts().length, 1);
  assert.ok(h.server.texts()[0].text.startsWith("Recovered final."));
});

test("queued users keep FIFO order and finals stay pinned to their originating chat", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "first", 123));
  h.server.feed(message(2, "second", 456));
  await until(() => h.submissions.length === 1);
  await delay(300);
  assert.equal(h.submissions.length, 1);
  await h.finish("For first user.");
  await until(() => h.submissions.length === 2);
  await h.finish("For second user.");
  assert.deepEqual(h.server.texts().map(item => item.chat_id), [123, 456]);
});

test("same-chat follow-ups steer the active run without waiting for settlement", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Initial task"));
  await until(() => h.submissions.length === 1);
  h.server.feed(message(2, "Actually, use this correction"));
  h.server.feed(message(3, "And keep it brief"));
  await until(() => h.submissions.length === 3);
  assert.deepEqual(h.deliveries, ["followUp", "steer", "steer"]);
  assert.match((h.submissions[1][0] as TextContent).text, /Actually, use this correction/);
  assert.match((h.submissions[2][0] as TextContent).text, /And keep it brief/);
  assert.equal(h.server.texts().length, 0);
  await h.finish("Corrected final.");
  assert.deepEqual(h.server.texts().map(item => [item.chat_id, item.text]), [[123, "Corrected final."]]);
});

test("a queued different chat cannot block or capture the current owner's steering", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Initial task", 123));
  await until(() => h.submissions.length === 1);
  h.server.feed(message(2, "Other user's task", 456));
  h.server.feed(message(3, "Owner's correction", 123));
  await until(() => h.submissions.length === 2);
  assert.equal(h.deliveries[1], "steer");
  assert.match((h.submissions[1][0] as TextContent).text, /Owner's correction/);
  await h.finish("Corrected for owner.");
  await until(() => h.submissions.length === 3);
  assert.match((h.submissions[2][0] as TextContent).text, /Other user's task/);
  await h.finish("For other user.");
  assert.deepEqual(h.server.texts().map(item => item.chat_id), [123, 456]);
});

test("steering albums retain debounce, native images, and one prompt", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Initial task"));
  await until(() => h.submissions.length === 1);
  h.server.feed({ ...message(2, ""), text: undefined, caption: "Use these", media_group_id: "steering-album", photo: [{ file_id: "one" }] });
  await delay(150);
  h.server.feed({ ...message(3, ""), text: undefined, media_group_id: "steering-album", photo: [{ file_id: "two" }] });
  await until(() => h.submissions.length === 2);
  assert.equal(h.deliveries[1], "steer");
  assert.equal(h.submissions[1].filter(block => block.type === "image").length, 2);
  assert.equal((h.submissions[1][0] as TextContent).text.split("[Attachment/s]\n")[1].split("\n").length, 2);
  await h.finish("Updated with both images.");
  await delay(200);
  assert.equal(h.submissions.length, 2);
  assert.equal(h.server.texts().length, 1);
});

test("voice follow-ups are transcribed and steered without automatic speech", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Initial task"));
  await until(() => h.submissions.length === 1);
  h.server.file = Buffer.from("voice audio");
  h.server.transcript = "Use the revised instructions.";
  h.server.feed({ ...message(2), text: undefined, voice: { file_id: "voice", mime_type: "audio/ogg" } });
  await until(() => h.submissions.length === 2);
  assert.equal(h.deliveries[1], "steer");
  assert.match((h.submissions[1][0] as TextContent).text, /\[Transcription\]\nUse the revised instructions\./);
  await h.finish("Revised text reply.");
  assert.equal(h.server.texts()[0].text, "Revised text reply.");
  assert.equal(h.server.calls.filter(call => call.method === "sendVoice").length, 0);
});

test("a run settling during a steering download dispatches the prepared input once afterward", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Initial task"));
  await until(() => h.submissions.length === 1);
  const download = h.bridge.api.download.bind(h.bridge.api);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let downloading = false;
  h.bridge.api.download = async (...args) => {
    downloading = true;
    await new Promise<void>((done, reject) => {
      const abort = () => reject(args[1].reason);
      args[1].addEventListener("abort", abort, { once: true });
      gate.then(() => { args[1].removeEventListener("abort", abort); done(); });
    });
    return download(...args);
  };
  t.after(() => release());
  h.server.feed({ ...message(2), text: undefined, document: { file_id: "doc", file_name: "correction.txt" } });
  await until(() => downloading);
  await h.finish("Original completed.");
  release();
  await until(() => h.submissions.length === 2);
  assert.equal(h.deliveries[1], "followUp");
  assert.match((h.submissions[1][0] as TextContent).text, /correction\.txt/);
  assert.equal(h.server.calls.filter(call => call.method === "getFile").length, 1);
  await h.finish("Correction completed.");
  assert.equal(h.server.texts().length, 2);
});

test("failed steering preparation reports safely without cancelling the original task", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Initial task"));
  await until(() => h.submissions.length === 1);
  h.bridge.api.download = async () => { throw new Error("private provider failure"); };
  h.server.feed({ ...message(2), text: undefined, document: { file_id: "doc" } });
  await until(() => h.server.texts().length === 1);
  assert.ok(!h.server.texts()[0].text.includes("private provider failure"));
  assert.equal(h.submissions.length, 1);
  await h.finish("Original still completed.");
  assert.equal(h.server.texts().at(-1)!.text, "Original still completed.");
});

test("steering clears an earlier final and voice-only state only when consumed", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Voice please"));
  await until(() => h.submissions.length === 1);
  await h.bridge.send({ speech: "[warm, composed voice] First reply." });
  h.bridge.assistantEnd({ role: "assistant", content: [{ type: "text", text: "Stale final" }], stopReason: "stop" });
  h.server.feed(message(2, "Now answer the correction in text"));
  await until(() => h.submissions.length === 2);
  h.setIdle(true);
  await h.bridge.settled();
  assert.equal(h.server.texts().length, 0, "an earlier final must not leak after consumed steering");
  h.server.feed(message(3, "Another task"));
  await until(() => h.submissions.length === 3);
  await h.finish("Fresh text reply.");
  assert.equal(h.server.texts()[0].text, "Fresh text reply.");
});

test("a text correction after an explicit voice send can produce its own text final", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Voice please"));
  await until(() => h.submissions.length === 1);
  await h.bridge.send({ speech: "[warm, composed voice] First reply." });
  h.server.feed(message(2, "Now answer in text"));
  await until(() => h.submissions.length === 2);
  await h.finish("Corrected text.");
  assert.equal(h.server.calls.filter(call => call.method === "sendVoice").length, 1);
  assert.equal(h.server.texts()[0].text, "Corrected text.");
});

test("unconsumed steering retains the earlier final and the late correction's reply owner", async t => {
  const h = await fixture(t, { consume: false });
  h.server.feed(message(1, "Initial task"));
  await until(() => h.submissions.length === 1);
  h.consume(0);
  h.setIdle(false);
  h.server.feed(message(2, "Delayed correction"));
  await until(() => h.submissions.length === 2);
  assert.ok(h.bridge.isTelegramPrompt((h.submissions[1][0] as TextContent).text));
  await h.finish("Initial completed before input hook.");
  assert.equal(h.server.texts()[0].text, "Initial completed before input hook.");
  h.consume(1);
  h.setIdle(false);
  await h.finish("Late corrected final.");
  assert.deepEqual(h.server.texts().map(item => [item.chat_id, item.text]), [[123, "Initial completed before input hook."], [123, "Late corrected final."]]);
});

test("shutdown cancels steering preparation without dispatching or losing the owner lock", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Initial task"));
  await until(() => h.submissions.length === 1);
  let downloading = false;
  h.bridge.api.download = async (_file, signal) => {
    downloading = true;
    await delay(60_000, undefined, { signal });
    throw new Error("test download should be cancelled");
  };
  h.server.feed({ ...message(2), text: undefined, document: { file_id: "doc" } });
  await until(() => downloading);
  await h.bridge.stop();
  assert.equal(h.submissions.length, 1);
  assert.equal(h.server.texts().length, 0);
  assert.equal(h.bridge.ownsConnection, false);
});

test("local TUI runs are not forwarded and requests wait for idle", async t => {
  const h = await fixture(t);
  h.setIdle(false);
  h.server.feed(message());
  h.bridge.userStart({ role: "user", content: "local terminal input" });
  await h.finish("Local reply.");
  assert.equal(h.server.texts().length, 0);
  await until(() => h.submissions.length === 1);
  await h.finish("Telegram reply.");
  assert.equal(h.server.texts().length, 1);
});

test("unconsumed extension input never captures local assistant replies", async t => {
  const h = await fixture(t, { consume: false });
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  h.bridge.userStart({ role: "user", content: "different local input" });
  await h.finish("Private local reply.");
  assert.equal(h.server.texts().length, 0);
});

test("typing is sent immediately and refreshed while agent is busy, then stops", async t => {
  const h = await fixture(t);
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  await delay(4100);
  assert.ok(h.server.calls.filter(call => call.method === "sendChatAction").length >= 2);
  assert.ok(h.server.calls.filter(call => call.method === "sendChatAction").every(call => call.args.action === "typing"));
  await h.finish();
  await h.bridge.stop();
  const count = h.server.calls.length;
  await delay(300);
  assert.equal(h.server.calls.length, count);
  assert.ok(h.server.abortedPolls >= 1);
});

test("TUI shows actual connected/disconnected state; RPC avoids terminal-only status calls", async t => {
  const h = await fixture(t);
  await until(() => h.bridge.status === "connected");
  assert.ok(h.statuses.some(status => status === "Telegram ● connected"));
  await h.bridge.stop();
  assert.equal(h.statuses.at(-1), "Telegram ○ disconnected");
  const rpc = await fixture(t, { mode: "rpc" });
  await until(() => rpc.bridge.status === "connected");
  assert.equal(rpc.statuses.length, 0);
});

test("photos are saved privately and supplied as native image content", async t => {
  const h = await fixture(t);
  h.server.feed({ ...message(), text: undefined, caption: "Describe this", photo: [{ file_id: "small", file_size: 2 }, { file_id: "large", file_size: 6 }] });
  await until(() => h.submissions.length === 1);
  assert.equal(h.server.calls.find(call => call.method === "getFile")!.args.file_id, "large");
  const image = h.submissions[0].find(block => block.type === "image") as ImageContent;
  assert.equal(image.mimeType, "image/jpeg");
  assert.deepEqual(Buffer.from(image.data, "base64"), h.server.file);
  const text = (h.submissions[0][0] as TextContent).text;
  assert.match(text, /Describe this/);
  assert.match(text, /\[Attachment\/s\]\n/);
  const path = text.split("[Attachment/s]\n")[1];
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("documents and videos are saved and forwarded as paths, not fictitious video blocks", async t => {
  const h = await fixture(t);
  h.server.file = Buffer.from("fake mp4 bytes");
  h.server.feed({ ...message(), text: undefined, video: { file_id: "vid", file_name: "../../clip.mp4" } });
  await until(() => h.submissions.length === 1);
  assert.equal(h.submissions[0].length, 1);
  assert.match((h.submissions[0][0] as TextContent).text, /\[Attachment\/s\]\n.*clip\.mp4/);
  await h.finish();
  h.server.feed({ ...message(2), text: undefined, document: { file_id: "doc", file_name: "report.pdf" } });
  await until(() => h.submissions.length === 2);
  assert.match((h.submissions[1][0] as TextContent).text, /report\.pdf/);
});

test("voice input is transcribed through Groq but defaults to text without TTS", async t => {
  const h = await fixture(t);
  h.server.file = Buffer.from("voice audio");
  h.server.feed({ ...message(), text: undefined, voice: { file_id: "voice", mime_type: "audio/ogg" } });
  await until(() => h.submissions.length === 1);
  assert.match((h.submissions[0][0] as TextContent).text, /\[Transcription\]\nA spoken request\./);
  await h.finish("Text final.");
  assert.equal(h.server.texts().length, 1);
  assert.equal(h.server.texts()[0].text, "Text final.");
  assert.equal(h.server.calls.filter(call => call.method === "sendVoice").length, 0);
  assert.ok(!h.server.calls.some(call => call.method.startsWith(config.voiceId!)));
});

test("audio attachments also default to text without TTS", async t => {
  const h = await fixture(t);
  h.server.file = Buffer.from("audio bytes");
  h.server.feed({ ...message(), text: undefined, audio: { file_id: "audio", file_name: "audio.ogg" } });
  await until(() => h.submissions.length === 1);
  assert.match((h.submissions[0][0] as TextContent).text, /\[Transcription\]\nA spoken request\./);
  await h.finish("Audio answered in text.");
  assert.equal(h.server.texts()[0].text, "Audio answered in text.");
  assert.equal(h.server.calls.filter(call => call.method === "sendVoice").length, 0);
  assert.ok(!h.server.calls.some(call => call.method.startsWith(config.voiceId!)));
});

test("an explicit spoken voice request can use the speech tool and stays voice-only", async t => {
  const h = await fixture(t);
  h.server.file = Buffer.from("voice audio");
  h.server.transcript = "Please send a voice reply.";
  h.server.feed({ ...message(), text: undefined, voice: { file_id: "voice", mime_type: "audio/ogg" } });
  await until(() => h.submissions.length === 1);
  assert.match((h.submissions[0][0] as TextContent).text, /Please send a voice reply\./);
  await h.bridge.send({ speech: "[warm, composed voice] Your requested voice reply." });
  await h.finish("Sent, sir.");
  const sent = h.server.calls.filter(call => call.method === "sendVoice");
  assert.equal(sent.length, 1);
  assert.equal((sent[0].args.get("voice") as File).type, "audio/ogg");
  assert.equal(h.server.texts().length, 0);
});

test("all former Telegram slash commands are ordinary Pi input, not transport controls", async t => {
  const h = await fixture(t);
  for (const [index, command] of ["/start", "/help", "/voice off", "/voice on", "/stop", "/telegram disconnect"].entries()) {
    h.server.feed(message(index + 1, command));
    await until(() => h.submissions.length === index + 1);
    assert.ok((h.submissions[index][0] as TextContent).text.endsWith(command));
    await h.finish("");
  }
  assert.equal(h.server.texts().length, 0);
  assert.equal(h.getAborts(), 0);
  assert.equal(h.server.calls.filter(call => call.method === "sendVoice").length, 0);
});

test("outgoing file and explicit speech tools are routed only to the active request", async t => {
  const h = await fixture(t);
  await until(() => h.bridge.status === "connected");
  await assert.rejects(h.bridge.send({ speech: "No active user" }), /TG_NO_CONTEXT/);
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  await writeFile(resolve(h.dir, "report.txt"), "report");
  await h.bridge.send({ path: "report.txt" });
  const document = h.server.calls.find(call => call.method === "sendDocument")!;
  assert.equal(document.args.get("chat_id"), "123");
  assert.equal((document.args.get("document") as File).name, "report.txt");
  await assert.rejects(h.bridge.send({ path: "report.txt", speech: "conflict" }), /exactly one/);
  assert.equal(document.args.get("caption"), null);
  await h.bridge.send({ speech: "Explicit spoken reply." });
  await h.finish("Sent, sir.");
  assert.equal(h.server.calls.filter(call => call.method === "sendVoice").length, 1);
  assert.equal(h.server.texts().length, 0);
});

test("successful empty finals and attachment-only replies are silent, not false failures", async t => {
  const h = await fixture(t);
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  await h.finish("");
  assert.equal(h.server.texts().length, 0);
  h.server.feed(message(2));
  await until(() => h.submissions.length === 2);
  await writeFile(resolve(h.dir, "attachment.txt"), "test");
  await h.bridge.send({ path: "attachment.txt" });
  await h.finish("");
  assert.equal(h.server.texts().length, 0);
  assert.equal(h.server.calls.filter(call => call.method === "sendDocument").length, 1);
});

test("cursor survives reconnects and already accepted updates are not replayed", async t => {
  const h = await fixture(t);
  h.server.feed(message(), 100);
  await until(() => h.submissions.length === 1);
  await h.finish();
  await h.bridge.stop();
  const hash = (await readdir(resolve(h.dir, "state")))[0];
  const saved = JSON.parse(await readFile(resolve(h.dir, "state", hash, "cursor.json"), "utf8"));
  assert.equal(saved.offset, 101);
  h.server.first = true;
  await h.bridge.start();
  h.server.feed(message(), 100);
  await delay(350);
  assert.equal(h.submissions.length, 1);
  const polls = h.server.calls.filter(call => call.method === "getUpdates");
  assert.equal(polls.at(-1)!.args.offset, 101);
});

test("401/409 conflicts stop polling rather than fighting the existing bridge", async t => {
  for (const code of [401, 409]) {
    const server = new Server();
    server.fatal = code;
    const h = await fixture(t, { server });
    await until(() => h.notices.length === 1);
    const count = server.calls.length;
    await delay(100);
    assert.equal(server.calls.length, count);
    assert.match(h.bridge.status, /^disconnected/);
  }
});

test("active webhooks are not removed or overridden", async t => {
  const server = new Server();
  server.hook = "https://existing.example/webhook";
  const h = await fixture(t, { server });
  await until(() => h.notices.length === 1);
  assert.ok(!server.calls.some(call => ["deleteWebhook", "getUpdates"].includes(call.method)));
});

test("first instance owns the bot across different data directories; no losing-instance API calls", async t => {
  const lockDir = await mkdtemp(resolve(workspace, "telegram-shared-owner-"));
  t.after(() => rm(lockDir, { recursive: true, force: true }));
  const first = await fixture(t, { lockDir });
  await until(() => first.bridge.status === "connected");
  const second = await fixture(t, { lockDir, start: false });
  await assert.rejects(second.bridge.start(), /already owned/);
  assert.equal(second.server.calls.length, 0);
  assert.equal(first.server.abortedPolls, 0);
  assert.equal(first.bridge.status, "connected");
  await first.bridge.stop();
  await second.bridge.start();
  await until(() => second.bridge.status === "connected");
});

test("repeated and concurrent starts preserve the original poller and queued requests", async t => {
  const h = await fixture(t, { start: false });
  await Promise.all(Array.from({ length: 5 }, () => h.bridge.start()));
  await until(() => h.bridge.status === "connected");
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  await h.bridge.start();
  assert.equal(h.server.calls.filter(call => call.method === "getMe").length, 1);
  assert.equal(h.server.abortedPolls, 0);
  await h.finish("Original owner's reply.");
  assert.equal(h.server.texts()[0].text, "Original owner's reply.");
});

test("transient network loss retains ownership and reconnects without a competing poller", async t => {
  const lockDir = await mkdtemp(resolve(workspace, "telegram-network-owner-"));
  t.after(() => rm(lockDir, { recursive: true, force: true }));
  const server = new Server();
  const fetch = server.fetch;
  let failed = false;
  server.fetch = async (url, init) => {
    if (!failed && String(url).endsWith("/getUpdates")) { failed = true; throw new Error("offline fixture network interruption"); }
    return fetch(url, init);
  };
  const first = await fixture(t, { server, lockDir });
  await until(() => first.bridge.status.includes("TG_TRANSPORT_FAILED"));
  assert.equal(first.bridge.ownsConnection, true);
  await first.bridge.start();
  const second = await fixture(t, { lockDir, start: false });
  await assert.rejects(second.bridge.start(), /already owned/);
  assert.equal(second.server.calls.length, 0);
  await until(() => first.bridge.status === "connected");
  assert.equal(server.calls.filter(call => call.method === "getMe").length, 1);
});

test("fatal Telegram rejection drains resources and releases the owner lock", async t => {
  const lockDir = await mkdtemp(resolve(workspace, "telegram-fatal-owner-"));
  t.after(() => rm(lockDir, { recursive: true, force: true }));
  const server = new Server();
  server.fatal = 401;
  const first = await fixture(t, { server, lockDir });
  await until(() => first.notices.length === 1);
  await first.bridge.stop();
  const second = await fixture(t, { lockDir });
  await until(() => second.bridge.status === "connected");
});

test("failed cursor initialization also releases ownership", async t => {
  const lockDir = await mkdtemp(resolve(workspace, "telegram-cursor-owner-"));
  t.after(() => rm(lockDir, { recursive: true, force: true }));
  const first = await fixture(t, { lockDir, start: false });
  const botDir = resolve(first.dir, "downloads", createHash("sha256").update(config.token).digest("hex").slice(0, 16));
  await mkdir(botDir, { recursive: true });
  await writeFile(resolve(botDir, "cursor.json"), "corrupt");
  await assert.rejects(first.bridge.start(), /cursor is unreadable/);
  assert.equal(first.server.calls.length, 0);
  const second = await fixture(t, { lockDir });
  await until(() => second.bridge.status === "connected");
});

test("aborted or errored assistant messages cannot be forwarded as final answers", async t => {
  const h = await fixture(t);
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  await h.finish("raw provider error", "error");
  assert.equal(h.server.texts().length, 1);
  assert.ok(!h.server.texts()[0].text.includes("raw provider error"));
  assert.match(h.server.texts()[0].text, /could not complete/);
});

test("incoming albums across separate polls retain the earliest sent second, one ordered prompt and all native image blocks", async t => {
  const h = await fixture(t);
  const earliest = message().date - 30;
  h.server.feed({ ...message(10), text: undefined, caption: "Describe both", media_group_id: "album-a", photo: [{ file_id: "first" }] });
  await delay(150);
  h.server.feed({ ...message(11), date: earliest, text: undefined, media_group_id: "album-a", photo: [{ file_id: "second" }] });
  await until(() => h.submissions.length === 1);
  const text = (h.submissions[0][0] as TextContent).text;
  const paths = text.split("[Attachment/s]\n")[1].split("\n");
  assert.equal(paths.length, 2);
  assert.ok(paths[0].includes("10-") && paths[1].includes("11-"));
  assert.equal(h.submissions[0].filter(block => block.type === "image").length, 2);
  assert.equal((text.match(/\[Attachment\/s\]/g) || []).length, 1);
  const iso = text.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\] Describe both/)?.[1];
  assert.ok(iso);
  assert.equal(Date.parse(iso), earliest * 1000);
  assert.ok(!text.includes("saved at:") && !text.includes("Telegram photo"));
  await h.finish("Both cats.");
  await delay(250);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.server.texts().length, 1);
});

test("reply-bearing albums keep deduplicated XML before the earliest current timestamp and native attachments", async t => {
  const h = await fixture(t);
  const earliest = message().date - 45;
  const reply_to_message = { ...message(200, "A prior answer & detail"), from: { id: 999, is_bot: true, first_name: "Eve" } };
  h.server.feed({ ...message(10), text: undefined, caption: "Describe both", media_group_id: "reply-album", photo: [{ file_id: "first" }], reply_to_message });
  await delay(150);
  h.server.feed({ ...message(11), date: earliest, text: undefined, media_group_id: "reply-album", photo: [{ file_id: "second" }], reply_to_message });
  await until(() => h.submissions.length === 1);
  const text = (h.submissions[0][0] as TextContent).text;
  const refs = references(text); assert.equal(refs.length, 1); assert.equal(refs[0].sender, "Eve");
  assert.equal(refs[0].body, "A prior answer & detail");
  const current = text.slice(refs[0].xml.length + 2);
  assert.ok(current.startsWith(stamp("Describe both", new Date(earliest * 1000))));
  assert.ok(text.startsWith("<telegram_reply_context>\n")); assert.ok(!text.includes("[Current Telegram request]"));
  assert.equal(current.split("[Attachment/s]\n")[1].split("\n").length, 2);
  assert.equal(h.submissions[0].filter(block => block.type === "image").length, 2);
  assert.deepEqual(h.server.calls.filter(call => call.method === "getFile").map(call => call.args.file_id), ["first", "second"]);
  await h.finish(); assert.equal(h.server.texts().length, 1);
});

test("same album ID from different users cannot merge attachments or reply targets", async t => {
  const h = await fixture(t);
  h.server.feed({ ...message(1, "", 123), text: undefined, media_group_id: "same-album", document: { file_id: "one", file_name: "one.txt" } });
  h.server.feed({ ...message(2, "", 456), text: undefined, media_group_id: "same-album", document: { file_id: "two", file_name: "two.txt" } });
  await until(() => h.submissions.length === 1);
  assert.ok((h.submissions[0][0] as TextContent).text.includes("one.txt"));
  assert.ok(!(h.submissions[0][0] as TextContent).text.includes("two.txt"));
  await h.finish("First.");
  await until(() => h.submissions.length === 2);
  await h.finish("Second.");
  assert.deepEqual(h.server.texts().map(item => item.chat_id), [123, 456]);
});

test("multiple outgoing attachment paths use one captionless album and can finish silently", async t => {
  const h = await fixture(t);
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  await writeFile(resolve(h.dir, "one.jpg"), h.server.file);
  await writeFile(resolve(h.dir, "two.jpg"), h.server.file);
  await h.bridge.send({ paths: ["one.jpg", "two.jpg"] });
  const group = h.server.calls.filter(call => call.method === "sendMediaGroup");
  assert.equal(group.length, 1);
  const media = JSON.parse(group[0].args.get("media"));
  assert.equal(media.length, 2);
  assert.ok(media.every((item: any) => item.caption === undefined));
  assert.equal(group[0].args.get("chat_id"), "123");
  await h.finish("");
  assert.equal(h.server.texts().length, 0);
});

test("downloaded attachments may be returned from the dedicated non-cwd downloads directory", async t => {
  const h = await fixture(t);
  h.server.feed({ ...message(), text: undefined, document: { file_id: "doc", file_name: "received.txt" } });
  await until(() => h.submissions.length === 1);
  const path = (h.submissions[0][0] as TextContent).text.split("[Attachment/s]\n")[1];
  await h.bridge.send({ path, kind: "document" });
  await h.finish("");
  assert.equal(h.server.calls.filter(call => call.method === "sendDocument").length, 1);
  assert.equal(h.server.texts().length, 0);
});

test("legacy cursor is migrated to persistent state only under ownership, retaining the newest offset", async t => {
  const h = await fixture(t, { start: false });
  const bot = createHash("sha256").update(config.token).digest("hex").slice(0, 16);
  const downloads = resolve(h.dir, "downloads", bot);
  const state = resolve(h.dir, "state", bot);
  await mkdir(downloads, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(resolve(downloads, "cursor.json"), '{"offset":101}');
  await writeFile(resolve(state, "cursor.json"), '{"offset":90}');
  await h.bridge.start();
  await until(() => h.bridge.status === "connected");
  assert.equal(JSON.parse(await readFile(resolve(state, "cursor.json"), "utf8")).offset, 101);
  await assert.rejects(stat(resolve(downloads, "cursor.json")), { code: "ENOENT" });
  assert.equal(h.server.calls.find(call => call.method === "getUpdates")!.args.offset, 101);
});

test("successful voice tools with an empty final remain voice-only; actual cancellation still reports an error", async t => {
  const h = await fixture(t);
  h.server.feed(message());
  await until(() => h.submissions.length === 1);
  await h.bridge.send({ speech: "[warm, composed voice] Just my voice." });
  await h.finish("");
  assert.equal(h.server.texts().length, 0);
  assert.equal(h.server.calls.filter(call => call.method === "sendVoice").length, 1);
  h.server.feed(message(2));
  await until(() => h.submissions.length === 2);
  h.bridge.boundary("aborted");
  await h.bridge.settled();
  assert.equal(h.server.texts().at(-1)!.text, "Pi request was cancelled.");
});

test("transport command menus are cleared only by the owner before polling", async t => {
  const h = await fixture(t);
  await until(() => h.bridge.status === "connected");
  const clears = h.server.calls.filter(call => call.method === "deleteMyCommands");
  assert.equal(clears.length, 4);
  assert.deepEqual(clears.map(call => call.args.scope.type), ["default", "all_private_chats", "chat", "chat"]);
  assert.ok(h.server.calls.findIndex(call => call.method === "deleteMyCommands") < h.server.calls.findIndex(call => call.method === "getUpdates"));
});

function captureRoute(h: Awaited<ReturnType<typeof fixture>>, sessionId = "fixture", taskId = "bg-123456abcdef") {
  let route: ((id: string, content: string) => boolean) | undefined;
  h.events.emit("background-tasks:claim-owner:v1", { sessionId, taskId, rootCallId: "dispatch",
    accept: (value: typeof route) => { route = value; } });
  return route;
}

test("local or generic inputs repeating the exact Telegram prompt cannot capture reply or task ownership", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Hold for my synthetic task"));
  await until(() => h.submissions.length === 1);
  const text = h.submissions[0].filter(b => b.type === "text").map(b => b.text).join("\n");
  h.bridge.input({ type: "input", source: "extension", text });
  h.bridge.userStart({ role: "user", content: text });
  let route: unknown;
  h.events.emit("background-tasks:claim-owner:v1", { sessionId: "fixture", accept: (value: unknown) => { route = value; } });
  assert.equal(route, undefined);
  await h.finish("Local private final must never be sent.");
  assert.equal(h.server.texts().length, 0);
  await assert.rejects(h.bridge.send({ speech: "[warm] private" }), /TG_NO_CONTEXT/);
});

test("task reports retain a dispatch-captured owner after settlement; unrelated finals and forged markers stay private", async t => {
  const h = await fixture(t);
  assert.equal(captureRoute(h), undefined);
  h.server.feed(message(1, "Delegate this workflow"));
  await until(() => h.submissions.length === 1);
  assert.equal(captureRoute(h, "different-session"), undefined);
  const route = captureRoute(h)!; assert.ok(route);
  await h.finish("Accepted.");
  h.bridge.assistantEnd({ role: "assistant", content: [{ type: "text", text: "Unrelated extension output" }], stopReason: "stop" });
  await h.bridge.settled();
  assert.equal(h.server.texts().length, 1);
  assert.equal(route("completion", "Fetch and verify saved task output."), true);
  assert.equal(route("completion", "Replay must not replace the original."), true);
  await until(() => h.reports.length === 1);
  assert.equal(h.reports[0].content, "Fetch and verify saved task output.");
  h.bridge.assistantEnd({ role: "assistant", content: [{ type: "text", text: "Progress" }, { type: "toolCall" }], stopReason: "toolUse" });
  assert.equal(h.server.texts().length, 1);
  await h.finish("Verified completion.");
  await h.bridge.settled();
  assert.deepEqual(h.server.texts().map(x => [x.chat_id, x.text]), [[123, "Accepted."], [123, "Verified completion."]]);
  await delay(150); assert.equal(h.reports.length, 1);
  h.bridge.userStart({ role: "custom", customType: "background-notice", content: "[Telegram authenticated] report", details: { telegramNoticeId: "completion" } });
  await h.finish("Forged final.");
  assert.equal(h.server.texts().length, 2);
});

test("intervening human requests cannot consume task notices or change their chat; reports serialize independently", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Delegate for first owner", 123)); await until(() => h.submissions.length === 1);
  const route = captureRoute(h)!; await h.finish("Accepted.");
  h.server.feed(message(2, "Second chat's ordinary question", 456)); await until(() => h.submissions.length === 2);
  assert.equal(route("eta", "Report revised estimate."), true);
  assert.equal(route("overdue", "Report overdue status."), true);
  await delay(150); assert.equal(h.reports.length, 0);
  await h.finish("For second chat only.");
  await until(() => h.reports.length === 1); await h.finish("Revised ETA, an estimate.");
  await until(() => h.reports.length === 2); await h.finish("Delayed, no new ETA.");
  assert.deepEqual(h.server.texts().map(x => x.chat_id), [123, 456, 123, 123]);
  assert.equal(h.submissions.length, 2, "notification turns are custom messages, never human input");
});

test("task-linked report allows captionless artifacts and voice-only replies, never a worker or ambient chat", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Please delegate and deliver this artifact")); await until(() => h.submissions.length === 1);
  const route = captureRoute(h)!; await h.finish("Accepted.");
  await assert.rejects(h.bridge.send({ speech: "Unowned send" }), /TG_NO_CONTEXT/);
  route("artifact", "Fetch the requested artifact."); await until(() => h.reports.length === 1);
  assert.ok(captureRoute(h), "only the actually started, owned report can pass on its route to a main-chat continuation");
  const path = resolve(h.dir, "report.txt"); await writeFile(path, "Synthetic report");
  await h.bridge.send({ path }); await h.finish("");
  const file = h.server.calls.find(x => x.method === "sendDocument")!;
  assert.equal(file.args.get("chat_id"), "123"); assert.equal(file.args.get("caption"), null);
  route("voice", "Report the explicitly requested speech."); await until(() => h.reports.length === 2);
  await h.bridge.send({ speech: "[warm, composed voice] Verified." }); await h.finish("Do not forward this acknowledgment.");
  assert.equal(h.server.texts().length, 1);
  assert.equal(h.server.calls.filter(x => x.method === "sendVoice").length, 1);
});

test("navigation, shutdown and an intervening local user revoke task report delivery safely", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Delegate")); await until(() => h.submissions.length === 1);
  const route = captureRoute(h)!; await h.finish("Accepted.");
  route("first", "Completion."); await until(() => h.reports.length === 1);
  h.bridge.userStart({ role: "user", content: "Local TUI steering, not a Telegram request" });
  await assert.rejects(h.bridge.send({ speech: "Must not send" }), /TG_CONTEXT_CANCELLED/);
  await h.finish("Local user's final must stay local."); assert.equal(h.server.texts().length, 1);
  route("second", "Later status."); h.bridge.invalidate();
  assert.equal(route("third", "Stale status."), false);
  await delay(150); assert.equal(h.reports.length, 1);
  await h.bridge.stop(); assert.equal(route("fourth", "Shutdown status."), false);
});

async function ownedReport(t: test.TestContext, pending = false) {
  const h = await fixture(t, { consumeReports: !pending });
  h.server.feed(message(1, "Delegate an authorized task")); await until(() => h.submissions.length === 1);
  const parent = captureRoute(h)!; assert.ok(parent); await h.finish("Accepted.");
  assert.equal(parent("parent:settled", "Verify the saved parent report."), true);
  await until(() => h.reports.length === 1);
  return h;
}

test("report continuation capture requires actual start, current ownership and an unsettled successful window", async t => {
  await t.test("pending custom notice and pre-start hook confer no route", async t => {
    const h = await ownedReport(t, true);
    assert.equal(h.bridge.beforeStart(h.reports[0].content), true);
    assert.equal(captureRoute(h), undefined);
    h.startReport(); assert.ok(captureRoute(h)); await h.finish("Parent verified.");
    assert.equal(captureRoute(h), undefined, "settled report is no ambient target");
  });
  await t.test("unowned report object", async t => {
    const h = await ownedReport(t);
    (h.bridge as unknown as { foregroundOwner?: unknown }).foregroundOwner = undefined;
    assert.equal(captureRoute(h), undefined);
  });
  for (const outcome of ["aborted", "error"] as const) await t.test(`closed ${outcome} boundary`, async t => {
    const h = await ownedReport(t); h.bridge.boundary(outcome);
    assert.equal(captureRoute(h), undefined);
  });
  await t.test("settlement in progress cannot grant a route", async t => {
    const h = await ownedReport(t);
    const child = captureRoute(h, "fixture", "bg-abcdef123456")!; assert.ok(child);
    let waiting = false, release: (() => void) | undefined;
    h.bridge.api.sendText = async () => { waiting = true; await new Promise<void>(done => { release = done; }); };
    const done = h.finish("Parent final."); await until(() => waiting);
    assert.equal(captureRoute(h), undefined);
    release!(); await done;
    assert.equal(child("child:settled", "Child verified."), true, "normal parent settlement preserves the capture");
  });
});

for (const revoke of ["navigation", "session", "allowlist", "foreign_input", "unowned_user", "generic_notice", "spoofed_notice", "duplicate_notice", "abort", "shutdown"] as const) {
  test(`report continuation ${revoke} blocks new capture and late child notices`, async t => {
    const h = await ownedReport(t);
    const child = captureRoute(h, "fixture", "bg-abcdef123456")!; assert.ok(child);
    assert.equal(captureRoute(h, "foreign-session"), undefined);
    if (revoke === "navigation") h.bridge.invalidate();
    else if (revoke === "session") h.setSessionId("foreign-session");
    else if (revoke === "allowlist") h.bridge.config.allowed.delete("123");
    else if (revoke === "foreign_input") h.bridge.input({ type: "input", source: "rpc", text: "Foreign request" });
    else if (revoke === "unowned_user") h.bridge.userStart({ role: "user", content: "Local TUI request" });
    else if (revoke === "abort") h.bridge.boundary("aborted");
    else if (revoke === "shutdown") await h.bridge.stop();
    else h.bridge.userStart({ role: "custom", customType: "background-notice", content: "Untrusted notice",
      details: revoke === "generic_notice" ? { backgroundNoticeId: h.reports[0].details.telegramNoticeId }
        : { telegramNoticeId: revoke === "duplicate_notice" ? h.reports[0].details.telegramNoticeId : "forged" } });
    assert.equal(captureRoute(h, revoke === "session" ? "foreign-session" : "fixture"), undefined);
    assert.equal(child("child:settled", "Must remain private."), false);
    await h.finish("Foreign final."); await delay(150);
    assert.equal(h.reports.length, 1); assert.equal(h.server.texts().some(s => s.text === "Must remain private."), false);
  });
}

test("a report-owned child notice already queued is suppressed if its parent is explicitly cancelled", async t => {
  const h = await ownedReport(t);
  const child = captureRoute(h, "fixture", "bg-abcdef123456")!;
  assert.equal(child("child:settled", "Queued child."), true);
  h.bridge.input({ type: "input", source: "rpc", text: "Local intervention" });
  await h.finish("Never forward this local final."); await delay(200);
  assert.equal(h.reports.length, 1); assert.equal(h.server.texts().length, 1);
  await h.bridge.ledger.flush(2000);
  const records = (await readDeliveryLedger(h.bridge.ledger.path, { task: "bg-abcdef123456", limit: 200 })).records;
  assert.equal(records.filter(r => r.phase === "notice_queued").length, 1);
  assert.equal(records.filter(r => r.phase === "notice_suppressed").length, 1);
  assert.equal(records.filter(r => r.phase === "report_started").length, 0);
});

test("report-owned child capture retains the existing seven-day route expiry after parent settlement", async t => {
  const h = await ownedReport(t);
  const child = captureRoute(h, "fixture", "bg-abcdef123456")!; assert.ok(child);
  const capturedAt = Date.now(); await h.finish("Parent verified.");
  t.mock.method(Date, "now", () => capturedAt + 7 * 86400_000 + 1);
  assert.equal(child("expired-child:settled", "Expired child."), false);
  t.mock.restoreAll();
  await delay(150); assert.equal(h.reports.length, 1);
});

test("generic TUI background notices and stale IDs never become Telegram task owners", async t => {
  const h = await fixture(t);
  for (const details of [{ backgroundNoticeId: "generic" }, { telegramNoticeId: "forged" }, undefined]) {
    h.bridge.userStart({ role: "custom", customType: "background-notice", content: "TUI-only report", details });
    assert.equal(captureRoute(h), undefined);
    await h.finish("Unowned final.");
  }
  assert.equal(h.server.texts().length, 0);
});

test("concurrent settlements and ambiguous report sends never replay a successfully attempted final", async t => {
  const h = await fixture(t);
  h.server.feed(message(1, "Delegate")); await until(() => h.submissions.length === 1);
  const route = captureRoute(h)!; await h.finish("Accepted.");
  route("once", "Completion."); await until(() => h.reports.length === 1);
  h.bridge.assistantEnd({ role: "assistant", content: [{ type: "text", text: "One final." }], stopReason: "stop" });
  h.setIdle(true);
  await Promise.all([h.bridge.settled(), h.bridge.settled(), h.bridge.settled()]);
  assert.equal(h.server.texts().filter(x => x.text === "One final.").length, 1);
  route("failure", "Next status."); await until(() => h.reports.length === 2);
  const sendText = h.bridge.api.sendText.bind(h.bridge.api);
  let attempts = 0;
  h.bridge.api.sendText = async (chat, text, signal) => {
    if (text === "Ambiguous final.") { attempts++; throw new Error("Ambiguous offline send"); }
    return sendText(chat, text, signal);
  };
  await h.finish("Ambiguous final.");
  await h.bridge.settled(); route("failure", "Replay."); await delay(150);
  assert.equal(attempts, 1); assert.equal(h.reports.length, 2);
});

test("every delivery guard returns a closed safe local reason before any upload", async t => {
  const refused = async (h: Awaited<ReturnType<typeof fixture>>, code: string, signal?: AbortSignal) => {
    const before = h.server.calls.filter(c => c.method.startsWith("send") && c.method !== "sendChatAction").length;
    await assert.rejects(h.bridge.send({ path: "nonexistent-private-file" }, signal), error => {
      assert.ok(error instanceof DeliveryRefusal);
      assert.equal(error.code, code);
      assert.match(error.message, /refused locally/);
      assert.match(error.message, /No upload initiated by this refusal/);
      assert.ok(error.message.length < 450);
      for (const privateValue of [config.token, config.groqKey!, config.elevenKey!, h.dir, "123", "456", "nonexistent-private-file"]) assert.ok(!error.message.includes(privateValue));
      assert.deepEqual(Object.keys(error.state).sort(), ["cancelled", "connected", "context", "owned", "running", "settling", "started"]);
      return true;
    });
    assert.equal(h.server.calls.filter(c => c.method.startsWith("send") && c.method !== "sendChatAction").length, before);
  };
  await t.test("stopped", async t => { const h = await fixture(t, { start: false }); await refused(h, "TG_BRIDGE_STOPPED"); });
  await t.test("disconnected versus absent context", async t => {
    const h = await fixture(t); await until(() => h.bridge.status === "connected");
    await refused(h, "TG_NO_CONTEXT");
    // Adversarial invariant fault, not positive ownership fabrication.
    (h.bridge as unknown as { connected: boolean }).connected = false;
    await refused(h, "TG_BRIDGE_DISCONNECTED");
  });
  await t.test("submitted but not consumed", async t => {
    const h = await fixture(t, { consume: false }); h.server.feed(message()); await until(() => h.submissions.length === 1);
    await refused(h, "TG_CONTEXT_NOT_STARTED");
  });
  await t.test("interruption cancels context", async t => {
    const h = await fixture(t); h.server.feed(message()); await until(() => h.submissions.length === 1);
    h.bridge.input({ type: "input", source: "interactive", text: "Unrelated local input" });
    await refused(h, "TG_CONTEXT_CANCELLED");
  });
  await t.test("settlement closes upload window", async t => {
    const h = await fixture(t); h.server.feed(message()); await until(() => h.submissions.length === 1);
    let sending = false, release: (() => void) | undefined;
    h.bridge.api.sendText = async () => { sending = true; await new Promise<void>(done => { release = done; }); };
    const done = h.finish(); await until(() => sending);
    await refused(h, "TG_CONTEXT_SETTLING"); release!(); await done;
    await refused(h, "TG_NO_CONTEXT");
  });
  await t.test("wrong foreground owner", async t => {
    const h = await fixture(t); h.server.feed(message()); await until(() => h.submissions.length === 1);
    (h.bridge as unknown as { foregroundOwner?: unknown }).foregroundOwner = undefined;
    await refused(h, "TG_CONTEXT_NOT_OWNER");
  });
  await t.test("captured session and allowlist revalidated", async t => {
    const h = await fixture(t); h.server.feed(message()); await until(() => h.submissions.length === 1);
    const state = h.bridge as unknown as { active: { sessionId: string } };
    state.active.sessionId = "different"; await refused(h, "TG_SESSION_CHANGED");
    state.active.sessionId = "fixture";
    h.bridge.config.allowed = new Set(); await refused(h, "TG_RECIPIENT_NOT_ALLOWED");
  });
  await t.test("tool-call cancellation", async t => {
    const h = await fixture(t); h.server.feed(message()); await until(() => h.submissions.length === 1);
    const controller = new AbortController(); controller.abort(); await refused(h, "TG_CALL_CANCELLED", controller.signal);
  });
});

test("a serial attachment wait revalidates its captured context and never sends to the next user", async t => {
  const h = await fixture(t); h.server.feed(message()); await until(() => h.submissions.length === 1);
  await writeFile(resolve(h.dir, "one.txt"), "Synthetic one"); await writeFile(resolve(h.dir, "two.txt"), "Synthetic two");
  const sendGroup = h.bridge.api.sendGroup.bind(h.bridge.api);
  let reached = false, release: (() => void) | undefined;
  h.bridge.api.sendGroup = async (...args) => {
    await sendGroup(...args); reached = true;
    await new Promise<void>(done => { release = done; });
  };
  const first = h.bridge.send({ path: "one.txt" }); await until(() => reached);
  const second = h.bridge.send({ path: "two.txt" });
  // Simulate a late caller holding the old turn while the actual settled owner is removed.
  await h.finish("");
  h.server.feed(message(2, "Next user's request", 456)); await until(() => h.submissions.length === 2);
  const rejected = assert.rejects(second, error => error instanceof DeliveryRefusal && error.code === "TG_CONTEXT_REPLACED");
  release!(); await first; await rejected;
  const uploads = h.server.calls.filter(c => c.method === "sendDocument");
  assert.equal(uploads.length, 1); assert.equal(uploads[0].args.get("chat_id"), "123");
  await h.finish("");
});

test("an ambiguous attachment attempt does not consume or reassign report ownership and only an explicit valid retry uploads again", async t => {
  const server = new Server(); const fetch = server.fetch;
  let attempts = 0;
  server.fetch = async (url, init) => {
    if (String(url).endsWith("/sendDocument") && ++attempts === 1) throw new Error("Synthetic accepted-but-unacknowledged upload");
    return fetch(url, init);
  };
  const h = await fixture(t, { server }); h.server.feed(message()); await until(() => h.submissions.length === 1);
  const route = captureRoute(h)!; await h.finish("Accepted.");
  route("attachment", "Retrieve the saved report."); await until(() => h.reports.length === 1);
  await writeFile(resolve(h.dir, "report.txt"), "Synthetic report");
  await assert.rejects(h.bridge.send({ path: "report.txt" }), /TG_TRANSPORT_FAILED.*Delivery outcome unknown/);
  assert.equal(attempts, 1); assert.equal(h.bridge.status, "connected");
  await delay(150); assert.equal(attempts, 1); assert.equal(h.reports.length, 1);
  await h.bridge.send({ path: "report.txt" });
  assert.equal(attempts, 2);
  const uploaded = h.server.calls.find(c => c.method === "sendDocument")!;
  assert.equal(uploaded.args.get("chat_id"), "123"); assert.equal(uploaded.args.get("caption"), null);
  await h.finish("");
});

async function ledgerRecords(h: Awaited<ReturnType<typeof fixture>>) {
  await until(() => h.bridge.ledger.pendingWrites === 0);
  return (await readDeliveryLedger(h.bridge.ledger.path, { limit: 200 })).records;
}

test("durable final failure and its separately acknowledged warning share reply but never delivery identity or console traces", { concurrency: false }, async t => {
  const terminal = captureConsole(t);
  const server = new Server(), original = server.fetch;
  let sends = 0;
  server.fetch = async (url, init) => {
    const response = await original(url, init);
    if (String(url).endsWith("/sendMessage") && ++sends === 1) throw new Error(`PRIVATE synthetic provider body https://api.telegram.org/bot${config.token}/sendMessage ${config.groqKey} ${config.elevenKey}`, { cause: { code: "UND_ERR_SOCKET" } });
    return response;
  };
  const h = await fixture(t, { server }); h.server.feed(message()); await until(() => h.submissions.length === 1);
  await h.finish("PRIVATE generated final");
  const records = await ledgerRecords(h);
  const failed = records.find(r => r.phase === "send_failed" && r.operation === "reply")!;
  const warning = records.find(r => r.phase === "sent" && r.operation === "warning")!;
  assert.equal(failed.outcome, "unknown"); assert.equal(failed.cause, "UND_ERR_SOCKET");
  assert.equal(warning.outcome, "acknowledged"); assert.equal(warning.reply, failed.reply); assert.equal(warning.parent, failed.delivery);
  assert.notEqual(warning.delivery, failed.delivery);
  assert.ok(records.some(r => r.phase === "generated" && r.reply === failed.reply && r.outcome === "not_applicable"));
  assert.ok(!records.some(r => r.phase === "sent" && r.operation === "reply"));
  assert.equal(sends, 2, "one uncertain original and one warning, never an original replay");
  assert.deepEqual(records.filter(r => r.operation === "reply").map(r => r.phase), ["generated", "settled", "send_attempt", "api_attempt", "api_failed", "send_failed"]);
  assert.deepEqual(records.filter(r => r.operation === "warning").map(r => r.phase), ["send_attempt", "api_attempt", "api_ack", "sent"]);
  assert.equal(h.notices.length, 1, "real delivery failure still reaches the UI");
  assert.match(h.notices[0], /TG_TRANSPORT_FAILED.*Delivery outcome unknown/);
  assert.match(h.server.texts()[1].text, /TG_TRANSPORT_FAILED.*Delivery outcome unknown/);
  for (const privateValue of ["PRIVATE", "synthetic provider body", "https://api.telegram.org", config.token, config.groqKey!, config.elevenKey!, h.dir]) {
    assert.ok(!JSON.stringify({ records, notices: h.notices, warning: h.server.texts()[1].text }).includes(privateValue));
  }
  await h.bridge.stop();
  assertConsoleSilent(terminal);
});

test("attachment and voice acknowledgment correlate with their reply; voice-only and foreign input suppression never imply API receipt", async t => {
  const h = await fixture(t); h.server.feed(message()); await until(() => h.submissions.length === 1);
  await writeFile(resolve(h.dir, "private.txt"), "PRIVATE artifact");
  await h.bridge.send({ path: "private.txt" });
  await h.bridge.send({ speech: "[warm] PRIVATE requested voice" }); await h.finish("Do not forward after voice");
  const records = await ledgerRecords(h);
  const attachment = records.find(r => r.phase === "sent" && r.operation === "attachment")!;
  const voice = records.find(r => r.phase === "sent" && r.operation === "voice")!;
  assert.equal(attachment.reply, voice.reply);
  assert.ok(records.some(r => r.phase === "suppressed" && r.reason === "voice_only" && r.reply === voice.reply));
  assert.ok(!records.some(r => r.phase === "api_ack" && r.operation === "reply"));
  h.server.feed(message(2)); await until(() => h.submissions.length === 2);
  h.bridge.input({ type: "input", source: "interactive", text: "PRIVATE unrelated input" }); await h.finish("Never send");
  const cancelled = (await ledgerRecords(h)).filter(r => r.reason === "foreign_input");
  assert.ok(cancelled.some(r => r.phase === "cancelled")); assert.ok(cancelled.some(r => r.phase === "suppressed"));
  assert.ok(cancelled.every(r => r.outcome === "suppressed"));
  assert.ok(!JSON.stringify(await ledgerRecords(h)).includes("PRIVATE"));
});

test("unavailable ledger and throwing console methods cannot suppress final transport or leak traces", { concurrency: false }, async t => {
  const terminal = captureConsole(t, true);
  const h = await fixture(t); h.server.feed(message()); await until(() => h.submissions.length === 1);
  assert.equal((await readDeliveryLedger(h.bridge.ledger.path)).state, "missing");
  await writeFile(h.bridge.ledger.path, "PRIVATE blocker", { mode: 0o600 });
  await h.finish("Final still delivered");
  assert.equal(h.server.texts().length, 1); assert.equal(h.server.texts()[0].text, "Final still delivered");
  await until(() => h.bridge.ledger.pendingWrites === 0); assert.ok(h.bridge.ledger.dropped > 0);
  assert.equal((await readDeliveryLedger(h.bridge.ledger.path)).state, "unavailable");
  assert.equal(await readFile(h.bridge.ledger.path, "utf8"), "PRIVATE blocker");
  await h.bridge.stop();
  assertConsoleSilent(terminal);
});

test("throwing or rejecting ledger observers cannot alter successful delivery or cancellation", { concurrency: false }, async t => {
  const terminal = captureConsole(t);
  const h = await fixture(t);
  t.mock.method(h.bridge.ledger, "append", () => { throw new Error("PRIVATE observer"); });
  h.server.feed(message()); await until(() => h.submissions.length === 1);
  await h.finish("Final despite throwing ledger");
  t.mock.method(h.bridge.ledger, "append", () => Promise.reject(new Error("PRIVATE persistence")));
  h.server.feed(message(2)); await until(() => h.submissions.length === 2);
  await h.finish("Final despite rejecting ledger");
  h.server.feed(message(3)); await until(() => h.submissions.length === 3);
  h.bridge.input({ type: "input", source: "interactive", text: "PRIVATE interruption" });
  await h.finish("Must not send");
  assert.deepEqual(h.server.texts().map(item => item.text), ["Final despite throwing ledger", "Final despite rejecting ledger"]);
  assert.deepEqual(h.notices, []);
  await h.bridge.stop();
  assertConsoleSilent(terminal);
});
