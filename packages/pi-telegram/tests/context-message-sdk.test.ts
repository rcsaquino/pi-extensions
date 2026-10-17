import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { readDeliveryLedger } from "../src/delivery-ledger.ts";

const scratch = process.env.TELEGRAM_TEST_DIR || resolve(process.env.TMPDIR || "/tmp", "pi-telegram-tests");
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(10); }
}

type Mode = "steer" | "followUp" | "append" | "hook";
/** Actual file-loaded bridge, host lifecycle and queues; synthetic providers/HTTP only. */
async function fixture(t: test.TestContext, mode: Mode) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, "context-sdk-"));
  const agentDir = resolve(root, "agent"); await mkdir(agentDir);
  await writeFile(resolve(root, ".env"), "TELEGRAM_BOT_TOKEN=CONTEXT-OFFLINE\nTELEGRAM_ALLOWED_ID=123,456\nELEVENLABS_API_KEY=\n", { mode: 0o600 });
  const previousFetch = globalThis.fetch;
  const previous = { PI_OFFLINE: process.env.PI_OFFLINE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TELEGRAM_ENV_FILE: process.env.TELEGRAM_ENV_FILE };
  process.env.PI_OFFLINE = "1"; process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.TELEGRAM_ENV_FILE;
  const sent: { chat_id: number; text: string }[] = [];
  const trace: string[] = [], errors: string[] = [];
  const updates: unknown[] = [];
  let polls = 0, wake: (() => void) | undefined, starts = 0, settlements = 0, tools = 0;
  let route: ((id: string, content: string, metadata?: { kind: string; status: string }) => boolean) | undefined;
  let piApi: ExtensionAPI;
  let release: (() => void) | undefined, blocked = false, hold = false;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://api.telegram.org/botCONTEXT-OFFLINE/"), "No live network permitted");
    const method = String(url).split("/").pop()!;
    const args = JSON.parse(init!.body as string);
    const ok = (result: unknown) => Response.json({ ok: true, result });
    if (method === "getMe") return ok({ id: 999 });
    if (method === "getWebhookInfo") return ok({ url: "" });
    if (method === "sendMessage") { sent.push(args); return ok({}); }
    if (method === "getUpdates") {
      polls++;
      if (polls === 1) return ok([]);
      if (!updates.length) await new Promise<void>((done, reject) => {
        const abort = () => { wake = undefined; reject(new Error("Synthetic poll abort")); };
        wake = () => { init!.signal?.removeEventListener("abort", abort); wake = undefined; done(); };
        init!.signal?.addEventListener("abort", abort, { once: true });
        if (init!.signal?.aborted) abort();
      });
      return ok(updates.splice(0));
    }
    assert.ok(["deleteMyCommands", "sendChatAction"].includes(method)); return ok(true);
  };
  const provider = "context-message-offline";
  const model: Model<Api> = { id: "fixture", name: "Synthetic", provider, api: "context-message-api", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 };
  const custom = { customType: "web-search-content-ready", content: "Content fetched for 1/1 URLs [synthetic]. Full page content now available.", display: true };
  const fake = (pi: ExtensionAPI) => {
    piApi = pi;
    pi.on("before_agent_start", event => {
      if (mode === "hook") return { message: { ...custom, customType: "synthetic-hook-context" } };
    });
    pi.on("agent_start", () => { starts++; trace.push("agent_start"); });
    pi.on("agent_settled", () => { settlements++; trace.push("agent_settled"); });
    pi.on("message_start", event => { trace.push(`message_start:${event.message.role}${event.message.role === "custom" ? `:${event.message.customType}` : ""}`); });
    pi.registerTool({ name: "context_fixture", label: "Context fixture", description: "Synthetic context producer", parameters: Type.Object({}),
      async execute(_id, _args, signal, _update, ctx) {
        tools++;
        pi.events.emit("background-tasks:claim-owner:v1", { sessionId: ctx.sessionManager.getSessionId(), taskId: "bg-123456abcdef", accept: (value: typeof route) => { route = value; } });
        if (hold) {
          hold = false; blocked = true;
          await new Promise<void>(done => { release = done; signal?.addEventListener("abort", () => done(), { once: true }); });
        }
        if (mode !== "hook") pi.sendMessage(custom, { triggerTurn: mode !== "append", ...(mode === "followUp" ? { deliverAs: "followUp" as const } : {}) });
        return { content: [{ type: "text", text: "Synthetic tool result, not a reply" }], details: undefined };
      },
    });
    pi.registerProvider(provider, { apiKey: "INERT", baseUrl: model.baseUrl, api: model.api, models: [model], streamSimple(m, context) {
      const stream = createAssistantMessageEventStream();
      // Begin once per starting human/report input, even with custom hook context after it.
      const lastTool = context.messages.findLastIndex(message => message.role === "toolResult");
      const input = context.messages.findLastIndex(message => message.role === "user" && /Request synthetic|Report synthetic/.test(JSON.stringify(message.content)));
      const tool = input > lastTool;
      const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
        content: tool ? [{ type: "text", text: "Private intermediate commentary" }, { type: "toolCall", id: `context-${crypto.randomUUID()}`, name: "context_fixture", arguments: {} }] : [{ type: "text", text: "Settled contextual final." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } }); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(); });
      return stream;
    } });
  };
  const settings = SettingsManager.inMemory({ packages: [], defaultTools: ["context_fixture"], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")], extensionFactories: [fake] });
  t.after(async () => {
    release?.();
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await session.abort(); session.dispose(); }
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root), model }));
  await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error.error) });
  await until(() => polls >= 2, "poll started");
  return { session, sent, trace, errors, root, getRoute: () => route, tools: () => tools, starts: () => starts, settlements: () => settlements,
    feed(id: number, chat = 123) { updates.push({ update_id: id, message: { message_id: id, date: 1791000000, from: { id: chat }, chat: { id: chat, type: "private" }, text: "Request synthetic" } }); wake?.(); },
    hold: () => { hold = true; }, blocked: () => blocked, release: () => release?.(),
    customIdle: () => piApi!.sendMessage(custom, { triggerTurn: true }),
    ledger: () => readDeliveryLedger(resolve(agentDir, "pi-telegram/diagnostics"), { limit: 200 }),
  };
}

for (const mode of ["steer", "followUp", "append", "hook"] as const) test(`actual SDK ${mode} custom context preserves human/report ownership and only delivers settled finals`, async t => {
  const f = await fixture(t, mode);
  f.hold(); f.feed(1);
  await until(f.blocked, "tool blocked");
  // Another chat waits and cannot take the human's or later report's reply target.
  f.feed(2, 456); await delay(120); assert.equal(f.sent.length, 0);
  f.release();
  await until(() => f.settlements() >= 2, "both human runs settled");
  await f.session.waitForIdle();
  const finals = f.session.messages.filter(message => message.role === "assistant" && message.stopReason === "stop" && JSON.stringify(message.content).includes("Settled contextual final."));
  assert.ok(finals.length >= 2, "both human runs produced authoritative finals; followUp may also produce an intermediate final");
  assert.ok(f.session.messages.some(message => message.role === "custom" && ["web-search-content-ready", "synthetic-hook-context"].includes(message.customType)), "real host stored the custom context");
  if (mode !== "append") assert.ok(f.trace.some(value => value.startsWith("message_start:custom:")), "queued/hook context emits the extension lifecycle; append-only context need not");
  assert.deepEqual(f.sent.map(message => [message.chat_id, message.text]), [[123, "Settled contextual final."], [456, "Settled contextual final."]], "context notifications must not cancel either reply");
  const route = f.getRoute(); assert.ok(route, "context does not erase authenticated task capture");
  assert.equal(route("completion", "Report synthetic", { kind: "settled", status: "completed" }), true);
  await until(() => f.settlements() >= 3, "owned report settled"); await f.session.waitForIdle();
  assert.deepEqual(f.sent.at(-1), { chat_id: 456, text: "Settled contextual final." });
  assert.equal(f.sent.length, 3);
  assert.equal(f.tools(), 3);
  assert.ok(f.trace.some(value => value.startsWith("message_start:custom:")));
  // Same notification while idle starts an unrelated run, never captures the last chat.
  f.customIdle(); await until(() => f.settlements() >= 4, "unowned idle custom run settled"); await f.session.waitForIdle();
  assert.equal(f.sent.length, 3, "idle custom turns remain TUI-only");
  assert.deepEqual(f.errors, []);
  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  const records = (await f.ledger()).records;
  assert.equal(records.filter(record => record.phase === "sent" && record.operation === "reply").length, 3);
  assert.equal(records.filter(record => record.reason === "custom_interruption").length, 0);
});
