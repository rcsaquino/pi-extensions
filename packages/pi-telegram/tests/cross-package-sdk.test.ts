import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type, type Api, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readDeliveryLedger } from "../src/delivery-ledger.ts";

const scratch = process.env.TELEGRAM_TEST_DIR || resolve(process.env.TMPDIR || "/tmp", "pi-telegram-tests");
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 6000;
  while (!predicate()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(10); }
}

/** Two extensions in one real host: telegram plus an unrelated notice producer. No ownership event. */
async function fixture(t: test.TestContext) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, "cross-sdk-"));
  const agentDir = resolve(root, "agent"); await mkdir(agentDir);
  const old = { PI_OFFLINE: process.env.PI_OFFLINE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TELEGRAM_ENV_FILE: process.env.TELEGRAM_ENV_FILE };
  process.env.PI_OFFLINE = "1"; process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.TELEGRAM_ENV_FILE;
  await writeFile(resolve(root, ".env"), "TELEGRAM_BOT_TOKEN=CROSS-OFFLINE\nTELEGRAM_ALLOWED_ID=123\nELEVENLABS_API_KEY=\nELEVENLABS_VOICE_ID=\nELEVENLABS_MODEL_ID=\n", { mode: 0o600 });
  const fetch = globalThis.fetch;
  const sent: { chat_id: number; text: string }[] = [];
  const errors: string[] = [];
  const updates: unknown[] = [];
  let wake: (() => void) | undefined, polls = 0, notices = 0;
  const ok = (result: unknown) => Response.json({ ok: true, result });
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://api.telegram.org/botCROSS-OFFLINE/"), "Only synthetic transport permitted");
    const method = String(url).split("/").pop()!;
    const args = JSON.parse(init!.body as string);
    if (method === "getMe") return ok({ id: 999 });
    if (method === "getWebhookInfo") return ok({ url: "" });
    if (method === "sendMessage") { sent.push(args); return ok({}); }
    if (method === "getUpdates") {
      polls++;
      if (!updates.length) await new Promise<void>((done, reject) => {
        const abort = () => { wake = undefined; reject(new Error("synthetic abort")); };
        wake = () => { init!.signal?.removeEventListener("abort", abort); wake = undefined; done(); };
        init!.signal?.addEventListener("abort", abort, { once: true });
        if (init!.signal?.aborted) abort();
      });
      return ok(updates.splice(0));
    }
    assert.ok(["deleteMyCommands", "sendChatAction"].includes(method)); return ok(true);
  };
  const provider = "cross-package-synthetic";
  const model: Model<Api> = { id: "test", name: "Synthetic only", provider, api: "cross-package-api", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 };
  const producer = (pi: ExtensionAPI) => {
    pi.registerTool({ name: "synthetic_notice", label: "Notice", description: "Synthetic notice producer", parameters: Type.Object({}),
      async execute() {
        notices++;
        pi.sendMessage({ customType: "subagent-notice", content: "[Subagent settled]\nStatus: done\n---\nSynthetic worker report.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
        return { content: [{ type: "text", text: "Notice queued" }], details: undefined };
      },
    });
    pi.registerProvider(provider, { apiKey: "INERT", baseUrl: model.baseUrl, api: model.api, models: [model], streamSimple(m, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.filter(item => item.role !== "system").at(-1)!;
      const fromNotice = JSON.stringify(last).includes("Subagent settled");
      let tool: Pick<ToolCall, "name" | "arguments"> | undefined;
      if (last.role === "user" && !fromNotice) tool = { name: "synthetic_notice", arguments: {} };
      const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
        content: tool ? [{ type: "toolCall", id: `cross-${Date.now()}`, ...tool }] : [{ type: "text", text: fromNotice ? "Synthetic notice acknowledged." : "Synthetic foreground final." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    } });
  };
  const settings = SettingsManager.inMemory({ packages: [], defaultTools: ["synthetic_notice"], defaultProvider: provider, defaultModel: model.id,
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", enableAnalytics: false, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")], extensionFactories: [producer] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), model, thinkingLevel: "off" });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await session.abort(); session.dispose();
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "rpc", onError: event => errors.push(event.error) });
  await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  await until(() => polls > 0, "transport startup");
  return {
    session, sent, errors, get notices() { return notices; },
    feed(text: string) {
      updates.push({ update_id: 1, message: { message_id: 1, date: 1791000000, from: { id: 123 }, chat: { id: 123, type: "private" }, text } }); wake?.();
    },
    ledger: () => readDeliveryLedger(resolve(agentDir, "pi-telegram", "diagnostics"), { limit: 200 }),
  };
}

test("two extensions coexist: the foreground replies and the unrelated extension's notice is mirrored", async t => {
  const f = await fixture(t);
  f.feed("Please produce a synthetic notice");
  await until(() => f.notices === 1, "notice produced");
  await until(() => f.sent.length >= 1, "settled final");
  await f.session.waitForIdle();
  await delay(60);
  // A notice injected mid-run joins that settlement; the final answer is the only mirrored message.
  assert.deepEqual(f.sent.map(message => [message.chat_id, message.text]), [[123, "Synthetic notice acknowledged."]]);
  assert.deepEqual(f.errors, []);
});
