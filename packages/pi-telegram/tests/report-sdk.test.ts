import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type, type Api, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import telegram from "../index.ts";

const workspace = process.env.TELEGRAM_TEST_DIR || resolve(process.env.TMPDIR || "/tmp", "pi-telegram-tests");
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 6000;
  while (!predicate()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(10); }
}

/** Real host events and session; one synthetic provider and one offline Telegram transport. */
async function fixture(t: test.TestContext) {
  await mkdir(workspace, { recursive: true });
  const root = await mkdtemp(resolve(workspace, "mirror-sdk-"));
  const agentDir = resolve(root, "agent"); await mkdir(agentDir);
  await writeFile(resolve(root, ".env"), "TELEGRAM_BOT_TOKEN=MIRROR-OFFLINE\nTELEGRAM_ALLOWED_ID=123\nELEVENLABS_API_KEY=\nELEVENLABS_VOICE_ID=\nELEVENLABS_MODEL_ID=\n", { mode: 0o600 });
  await writeFile(resolve(root, "artifact.txt"), "Synthetic requested artifact");
  const previous = { PI_OFFLINE: process.env.PI_OFFLINE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TELEGRAM_ENV_FILE: process.env.TELEGRAM_ENV_FILE };
  process.env.PI_OFFLINE = "1"; process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.TELEGRAM_ENV_FILE;
  const originalFetch = globalThis.fetch;
  const sent: { chat_id: number; text: string }[] = [];
  const uploads: { chat: string; bytes: string }[] = [];
  const errors: string[] = [];
  let pending: unknown[] = [];
  let wake: (() => void) | undefined;
  let first = true;
  const success = (result: unknown) => Response.json({ ok: true, result });
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://api.telegram.org/botMIRROR-OFFLINE/"), "No real network or credentials permitted");
    const method = String(url).split("/").pop()!;
    if (method === "sendDocument") {
      assert.ok(init!.body instanceof FormData);
      const form = init!.body;
      assert.equal(form.get("caption"), null);
      uploads.push({ chat: String(form.get("chat_id")), bytes: await (form.get("document") as File).text() });
      return success({});
    }
    const args = JSON.parse(init!.body as string);
    if (method === "getMe") return success({ id: 999 });
    if (method === "getWebhookInfo") return success({ url: "" });
    if (method === "sendMessage") { sent.push(args); return success({}); }
    if (method === "getUpdates") {
      if (first) { first = false; return success([]); }
      if (!pending.length) await new Promise<void>((done, reject) => {
        const abort = () => { wake = undefined; reject(new Error("Synthetic poll abort")); };
        wake = () => { init!.signal?.removeEventListener("abort", abort); wake = undefined; done(); };
        init!.signal?.addEventListener("abort", abort, { once: true });
        if (init!.signal?.aborted) abort();
      });
      const updates = pending; pending = []; return success(updates);
    }
    assert.ok(["deleteMyCommands", "sendChatAction"].includes(method)); return success(true);
  };
  const provider = "mirror-sdk-synthetic";
  const model: Model<Api> = { id: "test", name: "Synthetic only", provider, api: "mirror-sdk-api", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
  const fake = (pi: ExtensionAPI) => {
    pi.registerProvider(provider, { baseUrl: model.baseUrl, apiKey: "INERT", api: model.api, models: [model], streamSimple(m, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.filter(item => item.role !== "system").at(-1)!;
      const content = JSON.stringify(last);
      const fromTelegram = content.includes("Telegram request") || content.includes("Please verify");
      const fromNotice = content.includes("Subagent settled");
      const local = content.includes("Local TUI question");
      const artifact = content.includes("Mirror the artifact");
      let visible = "Synthetic final.";
      let tool: Pick<ToolCall, "name" | "arguments"> | undefined;
      if (last.role === "toolResult" && last.toolName === "telegram_send") visible = "";
      else if (artifact) tool = { name: "telegram_send", arguments: { path: "artifact.txt" } };
      else if (fromTelegram) visible = "Telegram final.";
      else if (fromNotice) visible = "Mirrored notice final.";
      else if (local) visible = "Mirrored local final.";
      const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
        stopReason: tool ? "toolUse" : "stop",
        content: tool ? [{ type: "toolCall", id: `mirror-${crypto.randomUUID()}`, ...tool }] : [{ type: "text", text: visible }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    } });
  };
  const settings = SettingsManager.inMemory({ packages: [], defaultTools: ["telegram_send"], defaultProvider: provider, defaultModel: model.id,
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", enableAnalytics: false, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true, extensionFactories: [fake, telegram] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), model });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await session.abort(); session.dispose();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "rpc", onError: event => errors.push(event.error) });
  await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  await until(() => sent.length === 0 && errors.length === 0, "transport startup");
  return { session, root, sent, uploads, errors,
    feed: (text: string) => { pending.push({ update_id: 1, message: { message_id: 1, date: 1_791_000_000, from: { id: 123 }, chat: { id: 123, type: "private" }, text } }); wake?.(); } };
}

test("an inbound Telegram turn replies once to its chat", async t => {
  const f = await fixture(t);
  f.feed("Please verify the synthetic path");
  await until(() => f.sent.length === 1, "telegram reply");
  await f.session.waitForIdle();
  assert.deepEqual(f.sent, [{ chat_id: 123, text: "Telegram final." }]);
  assert.deepEqual(f.errors, []);
});

test("a settled custom notice with no Telegram origin is mirrored to the bound chat", async t => {
  const f = await fixture(t);
  f.session.sendCustomMessage({ customType: "subagent-notice", content: "[Subagent settled]\nStatus: done", display: false }, { triggerTurn: true, deliverAs: "followUp" });
  await until(() => f.sent.length === 1, "mirrored notice");
  await f.session.waitForIdle();
  assert.deepEqual(f.sent, [{ chat_id: 123, text: "Mirrored notice final." }]);
  assert.deepEqual(f.errors, []);
});

test("a local TUI turn is mirrored to the bound chat", async t => {
  const f = await fixture(t);
  await f.session.prompt("Local TUI question");
  await f.session.waitForIdle();
  await until(() => f.sent.length === 1, "mirrored local final");
  assert.deepEqual(f.sent, [{ chat_id: 123, text: "Mirrored local final." }]);
  assert.deepEqual(f.errors, []);
});

test("a mirrored custom turn can deliver a captionless attachment and stays silent afterward", async t => {
  const f = await fixture(t);
  f.session.sendCustomMessage({ customType: "subagent-notice", content: "Mirror the artifact", display: false }, { triggerTurn: true, deliverAs: "followUp" });
  await until(() => f.uploads.length === 1, "mirrored upload");
  await f.session.waitForIdle();
  assert.equal(f.uploads[0].chat, "123");
  assert.equal(f.uploads[0].bytes, "Synthetic requested artifact");
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.errors, []);
});
