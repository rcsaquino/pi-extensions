import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync, crc32 } from "node:zlib";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type, type Api, type AssistantMessage, type ImageContent, type Model, type TextContent } from "@earendil-works/pi-ai";
import { TelegramBridge } from "../src/bridge.ts";
import type { TgMessage } from "../src/api.ts";

const workspace = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
await mkdir(workspace, { recursive: true });
// Solid-color PNG built entirely from synthetic bytes, no patient or external fixture.
function png(width: number, height: number): Buffer {
  const chunk = (type: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(data));
    return Buffer.concat([length, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
async function until(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > 10_000) assert.fail("Image SDK fixture timed out"); await delay(5); }
}

test("real SDK image normalization preserves admitted reply ownership, queues, steering and foreign-input cancellation", async t => {
  const root = await mkdtemp(resolve(workspace, "telegram-image-sdk-"));
  const agentDir = resolve(root, "agent"); await mkdir(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail("Unexpected network call: image SDK tests have no live transport/provider"); };
  const sent: { chat_id: number; text: string }[] = [];
  const consumed: { text: string; images: number }[] = [];
  const errors: string[] = [];
  let release: (() => void) | undefined;
  let held = false;
  let holdNext = false;
  let bridge!: TelegramBridge;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  type Harness = { running: boolean; connected: boolean; listen(): void; receive(message: TgMessage): Promise<void>; processQueue(): Promise<void>;
    queue: { content?: (TextContent | ImageContent)[] }[] };
  let harness!: Harness;
  const provider = "telegram-image-offline";
  const model: Model<Api> = { id: "inert", name: "Inert image model", provider, api: "telegram-image-fake", baseUrl: "http://127.0.0.1",
    reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  const settings = SettingsManager.inMemory({ packages: [], defaultTools: ["image_gate"], retry: { enabled: false }, compaction: { enabled: false },
    cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true, extensionFactories: [pi => {
      pi.on("session_start", (_event, ctx: ExtensionContext) => {
        bridge = new TelegramBridge(pi, ctx, { token: "INERT-IMAGE-FIXTURE", allowed: new Set(["123", "456"]), dataDir: resolve(root, "downloads") }, async (url, init) => {
          const method = String(url).split("/").at(-1);
          assert.ok(method === "sendMessage" || method === "sendChatAction", "No poller or live HTTP is allowed");
          if (method === "sendMessage") sent.push(JSON.parse(init!.body as string));
          return Response.json({ ok: true, result: { message_id: sent.length } });
        });
        // Inert transport: no start(), connection lease, cursor, poller or live configuration.
        harness = bridge as unknown as Harness; harness.running = harness.connected = true; harness.listen();
      });
      pi.on("input", event => bridge.input(event));
      pi.on("before_agent_start", event => { bridge.beforeStart(event.prompt, event.images); });
      pi.on("agent_start", () => bridge.agentStart());
      pi.on("message_start", event => {
        bridge.userStart(event.message);
        if (event.message.role === "user") {
          const content = event.message.content;
          consumed.push({ text: typeof content === "string" ? content : content.filter(b => b.type === "text").map(b => b.text).join("\n"),
            images: Array.isArray(content) ? content.filter(b => b.type === "image").length : 0 });
        }
      });
      pi.on("message_end", event => bridge.assistantEnd(event.message));
      pi.on("agent_before_settle", event => bridge.boundary(event.outcome));
      pi.on("agent_settled", () => bridge.settled());
      pi.registerTool({ name: "image_gate", label: "Gate", description: "Synthetic gate", parameters: Type.Object({}), async execute() {
        held = true; await new Promise<void>(done => { release = done; });
        return { content: [{ type: "text", text: "Synthetic result" }], details: undefined };
      } });
      pi.registerProvider(provider, { baseUrl: model.baseUrl, apiKey: "INERT-KEY", api: model.api, models: [model], streamSimple(m) {
        const stream = createAssistantMessageEventStream();
        const tool = holdNext; holdNext = false;
        const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
          stopReason: tool ? "toolUse" : "stop", content: tool ? [{ type: "toolCall", id: "image-gate", name: "image_gate", arguments: {} }]
            : [{ type: "text", text: "Synthetic completed final." }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(); });
        return stream;
      } });
    }] });
  t.after(async () => {
    release?.(); await bridge?.stop(); if (session) { await session.abort(); session.dispose(); }
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root), model }));
  await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error.error) });
  await mkdir(resolve(root, "downloads"), { recursive: true });
  // prepare() normally writes to a bot-hashed download directory; download is inert here.
  const directory = (bridge as unknown as { directory: string }).directory; await mkdir(directory, { recursive: true });
  const image = png(1928, 2560);
  const feed = async (id: number, text: string, chat = 123, photo = true, bytes = image) => {
    bridge.api.download = async () => ({ data: bytes, filename: "synthetic.png" });
    await harness.receive({ message_id: id, date: 1_791_000_000, from: { id: chat }, chat: { id: chat, type: "private" },
      ...(photo ? { caption: text, photo: [{ file_id: "synthetic" }] } : { text }) });
    await harness.processQueue();
  };
  await t.test("1928x2560 initial image really appends SDK dimension hint and sends exactly once", async () => {
    await feed(1, "Synthetic resized request"); await until(() => sent.length === 1); await session!.waitForIdle();
    assert.match(consumed[0].text, /\[Image: original 1928x2560, displayed at 1506x2000\. Multiply coordinates by 1\.28/);
    assert.equal(consumed[0].images, 1); assert.deepEqual(sent, [{ chat_id: 123, text: "Synthetic completed final." }]);
  });
  await t.test("trusted omission hint with no image still sends exactly once", async () => {
    await feed(2, "Synthetic invalid image", 123, true, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await until(() => sent.length === 2); await session!.waitForIdle();
    assert.match(consumed[1].text, /\[Image omitted:/); assert.equal(consumed[1].images, 0);
  });
  await t.test("trusted conversion hint on SDK native prompt path still sends exactly once", async () => {
    await harness.receive({ message_id: 3, date: 1_791_000_000, from: { id: 123 }, chat: { id: 123, type: "private" }, text: "Synthetic conversion" });
    harness.queue[0].content = [{ type: "text", text: "Synthetic conversion" }, { type: "image", data: png(8, 8).toString("base64"), mimeType: "image/bmp" }];
    await harness.processQueue(); await until(() => sent.length === 3); await session!.waitForIdle();
    assert.match(consumed[2].text, /\[Image converted from image\/bmp to image\/png\.\]/); assert.equal(consumed[2].images, 1);
  });
  await t.test("image steering supersedes consumed final and other-chat queued image stays FIFO", async () => {
    held = false; holdNext = true; await feed(4, "Hold initial image"); await until(() => held);
    await feed(5, "Other chat queued image", 456); await feed(6, "Owner image correction");
    await until(() => session!.getSteeringMessages().length === 1);
    assert.equal(session!.getFollowUpMessages().length, 0); assert.equal(sent.length, 3);
    release?.(); await until(() => sent.length === 4); await session!.waitForIdle();
    await harness.processQueue(); await until(() => sent.length === 5); await session!.waitForIdle();
    assert.deepEqual(sent.slice(3).map(item => item.chat_id), [123, 456]);
    assert.ok(consumed.at(-1)!.text.includes("[Image: original"), "queued other-chat initial prompt must normalize");
  });
  await t.test("same-text local input cancels image owner; local and generic follow-ups cannot capture chat", async () => {
    held = false; holdNext = true; await feed(7, "Hold for local input"); await until(() => held);
    const sameText = consumed.at(-1)!.text;
    await session!.steer(sameText, undefined, { source: "interactive" }); release?.(); await session!.waitForIdle();
    assert.equal(sent.length, 5, "neither old image final nor same-text local final may be delivered");
    await session!.prompt(sameText, { source: "extension" }); assert.equal(sent.length, 5);
    await feed(8, "Text-only authenticated follow-up", 123, false); await until(() => sent.length === 6); await session!.waitForIdle();
    assert.equal(sent.at(-1)!.chat_id, 123);
  });
  await t.test("unauthenticated photo cannot reach preparation or SDK", async () => {
    const count = consumed.length; await feed(9, "Foreign", 777); assert.equal(consumed.length, count); assert.equal(sent.length, 6);
  });
  assert.deepEqual(errors, []);
});
