import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { readDeliveryLedger } from "../src/delivery-ledger.ts";

const scratch = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 6000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(10); }
}
async function fixture(t: test.TestContext, continuationDepth = 0) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, "cross-sdk-"));
  const agentDir = resolve(root, "agent"); await mkdir(agentDir);
  const old = { PI_OFFLINE: process.env.PI_OFFLINE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TELEGRAM_ENV_FILE: process.env.TELEGRAM_ENV_FILE };
  process.env.PI_OFFLINE = "1"; process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.TELEGRAM_ENV_FILE;
  await writeFile(resolve(root, ".env"), "TELEGRAM_BOT_TOKEN=CROSS-OFFLINE\nTELEGRAM_ALLOWED_ID=123,456\nGROQ_API_KEY=\nELEVENLABS_API_KEY=\nELEVENLABS_VOICE_ID=\nELEVENLABS_MODEL_ID=\n", { mode: 0o600 });
  const fetch = globalThis.fetch;
  const sent: { chat_id: number; text: string }[] = [];
  const errors: string[] = [];
  const inputSources: string[] = [];
  const updates: unknown[] = [];
  const taskIds: string[] = [];
  const reportTasks: string[] = [];
  const releaseWorkers: (() => void)[] = [];
  let wake: (() => void) | undefined;
  let polls = 0, workerCalls = 0, foregroundGate = 0;
  let releaseWorker: (() => void) | undefined, releaseForeground: (() => void) | undefined;
  let slowHook = false, releaseInput: (() => void) | undefined;
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
  const fake = (pi: ExtensionAPI) => {
    pi.on("input", async event => {
      inputSources.push(event.source);
      if (event.text.includes("slow authenticated correction")) {
        slowHook = true; await new Promise<void>(done => { releaseInput = done; });
      }
      if (event.text.includes("handled synthetic input")) return { action: "handled" };
      if (event.text.includes("transformed synthetic input")) return { action: "transform", text: "Different transformed input" };
    });
    pi.on("message_start", event => {
      if (event.message.role === "custom" && event.message.customType === "background-notice") {
        const id = JSON.stringify(event.message.content).match(/bg-[a-f0-9]{12}/)?.[0];
        if (id) reportTasks.push(id);
      }
    });
    pi.on("message_end", event => {
      if (event.message.role === "toolResult" && event.message.toolName === "background_dispatch") {
        const id = (event.message.details as { task?: { id: string } })?.task?.id; if (id) taskIds.push(id);
      }
    });
    pi.registerTool({ name: "synthetic_gate", label: "Gate", description: "Synthetic concurrency gate", annotations: { readOnlyHint: true }, parameters: Type.Object({}),
      async execute(_id, _args, signal) {
        foregroundGate++;
        await new Promise<void>(done => { releaseForeground = done; signal?.addEventListener("abort", () => done(), { once: true }); });
        return { content: [{ type: "text", text: "Synthetic gate released" }], details: undefined };
      },
    });
    pi.registerProvider(provider, { apiKey: "INERT", baseUrl: model.baseUrl, api: model.api, models: [model], streamSimple(m, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.filter(item => item.role !== "system").at(-1)!;
      const text = last.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(c => c.type === "text").map(c => c.text).join("\n")) : "";
      const isWorker = options?.sessionId?.startsWith("background-");
      let tool: Pick<ToolCall, "name" | "arguments"> | undefined;
      let result = "Verified synthetic workflow.";
      if (isWorker) { workerCalls++; result = "Synthetic worker completed and verified."; }
      else if (text.includes("Background task") && text.includes("settled with status")) {
        tool = { name: "background_tasks", arguments: { action: "result", id: text.match(/bg-[a-f0-9]{12}/)![0] } };
      } else if (text.includes("Delegate synthetic")) {
        tool = { name: "background_dispatch", arguments: { title: "Synthetic task", task: "Complete this synthetic task only.", mode: "manual", access: "read", eta_seconds: 120, eta_max_seconds: 180, estimate_reason: "Synthetic gate used to verify asynchronous delivery." } };
      } else if (text.includes("Hold synthetic")) tool = { name: "synthetic_gate", arguments: {} };
      else if (last.role === "toolResult" && last.toolName === "background_dispatch") result = continuationDepth && reportTasks.length ? `Report verified for ${reportTasks.at(-1)}` : "Task accepted. Return control.";
      else if (last.role === "toolResult" && last.toolName === "background_tasks") {
        if (taskIds.length <= continuationDepth) tool = { name: "background_dispatch", arguments: { title: "Synthetic continuation", task: "Complete only this authorized synthetic continuation.", mode: "manual", access: "read", eta_seconds: 120, estimate_reason: "Synthetic delayed continuation verifies report routing." } };
        else result = continuationDepth ? `Report verified for ${reportTasks.at(-1)}` : "Task report verified.";
      }
      const stopReason = text.includes("failed synthetic final") ? "error" : text.includes("cancelled synthetic final") ? "aborted" : tool ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason,
        content: tool ? [{ type: "toolCall", id: `cross-${Date.now()}`, ...tool }] : [{ type: "text", text: result }],
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        ...(stopReason === "error" || stopReason === "aborted" ? { errorMessage: "Synthetic failure" } : {}),
      };
      void (async () => {
        if (isWorker) await new Promise<void>(done => { releaseWorker = done; releaseWorkers.push(done); options?.signal?.addEventListener("abort", () => done(), { once: true }); });
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
        else stream.push({ type: "done", reason: stopReason, message });
        stream.end();
      })();
      return stream;
    } });
  };
  const settings = SettingsManager.inMemory({ packages: [], defaultTools: ["synthetic_gate", "background_dispatch", "background_tasks", "telegram_send"], defaultProvider: provider, defaultModel: model.id, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", enableAnalytics: false, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: ["pi-telegram", "pi-background-tasks"].map(name => resolve(import.meta.dirname, `../../${name}/index.ts`)), extensionFactories: [fake] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), model, thinkingLevel: "off" });
  t.after(async () => {
    releaseInput?.(); releaseForeground?.(); releaseWorkers.forEach(done => done());
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await session.abort(); session.dispose();
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "rpc", onError: event => errors.push(event.error) });
  await until(() => polls > 0, "transport startup");
  let update = 0;
  const feed = (text: string, chat = 123) => {
    updates.push({ update_id: ++update, message: { message_id: update, date: 1791000000, from: { id: chat }, chat: { id: chat, type: "private" }, text } }); wake?.();
  };
  const flush = async () => { await session.waitForIdle(); await delay(30); };
  return { session, root, feed, sent, flush, errors, inputSources, taskIds, reportTasks,
    ledger: (task: string) => readDeliveryLedger(resolve(agentDir, "pi-telegram", "diagnostics"), { task, limit: 200 }),
    get workerCalls() { return workerCalls; }, get foregroundGate() { return foregroundGate; }, get slowHook() { return slowHook; },
    releaseWorker: (index?: number) => index === undefined ? releaseWorker?.() : releaseWorkers[index]?.(), releaseForeground: () => releaseForeground?.(), releaseInput: () => releaseInput?.() };
}

test("actual two-package host keeps authenticated async steering reply ownership without a learning engine", async t => {
  const f = await fixture(t);
  f.feed("Synthetic initial request");
  await until(() => f.sent.length === 1, "authenticated reply"); await f.flush();
  const original = f.session.messages.find(m => m.role === "user")!;
  const replay = typeof original.content === "string" ? original.content : original.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  await f.session.sendUserMessage(replay, { deliverAs: "followUp" }); await f.flush();
  assert.equal(f.sent.length, 1, "same-text generic extension replay cannot own a Telegram reply");
  f.feed("Hold synthetic initial request");
  await until(() => f.foregroundGate === 1, "foreground gate");
  f.feed("Please use slow authenticated correction for this synthetic request");
  await until(() => f.slowHook, "slow input hook");
  f.releaseInput(); await until(() => f.session.getSteeringMessages().length === 1, "authenticated steering");
  f.releaseForeground(); await until(() => f.session.isIdle && f.sent.length === 2, "steered settlement"); await f.flush();
  assert.ok(f.inputSources.every(source => source === "extension")); assert.deepEqual(f.errors, []);
});

test("actual task-linked idle report survives original settlement, waits for intervening Telegram/local work and revokes on navigation", async t => {
  const f = await fixture(t);
  f.feed("Delegate synthetic task and remember this reusable workflow.");
  await until(() => f.sent.some(m => m.text === "Task accepted. Return control.") && f.workerCalls === 1, "dispatch acknowledgement"); await f.flush();
  assert.equal(f.taskIds.length, 1);
  f.feed("Hold synthetic intervening chat request", 456);
  await until(() => f.foregroundGate === 1, "intervening request");
  f.releaseWorker(); await delay(150);
  assert.equal(f.sent.some(m => m.text === "Task report verified."), false, "report cannot merge into another chat's turn");
  f.releaseForeground();
  await until(() => f.sent.some(m => m.text === "Task report verified."), "idle background report"); await f.flush();
  const reports = f.sent.filter(m => m.text === "Task report verified."); assert.equal(reports.length, 1); assert.equal(reports[0].chat_id, 123);
  await f.session.sendCustomMessage({ customType: "background-notice", content: "Unrelated notice without owner", display: false }, { triggerTurn: true, deliverAs: "followUp" }); await f.flush();
  assert.equal(f.sent.filter(m => m.text === "Task report verified.").length, 1);
  f.feed("Delegate synthetic second task.");
  await until(() => f.workerCalls === 2 && f.taskIds.length === 2 && f.session.isIdle, "second dispatch");
  const beforeLocal = f.sent.length;
  const local = f.session.prompt("Hold synthetic local request");
  await until(() => f.foregroundGate === 2, "local request");
  f.releaseWorker(); await delay(150);
  assert.equal(f.sent.length, beforeLocal, "local work must not consume task report ownership");
  f.releaseForeground(); await local;
  await until(() => f.sent.filter(m => m.text === "Task report verified.").length === 2, "report after local request");
  assert.equal(f.sent.at(-1)!.chat_id, 123); await f.flush();
  f.feed("Delegate synthetic navigation task.");
  await until(() => f.workerCalls === 3 && f.taskIds.length === 3 && f.session.isIdle, "navigation dispatch");
  await f.session.extensionRunner.emit({ type: "session_before_tree", signal: new AbortController().signal, preparation: { targetId: "synthetic", oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false } });
  f.releaseWorker(); await delay(250); await f.flush();
  assert.equal(f.sent.filter(m => m.text === "Task report verified.").length, 2, "navigation revokes dispatch owner");
  assert.deepEqual(f.errors, []);
});

test("actual SDK parent report dispatches child and grandchild with independent once-only Telegram routing after normal settlement", async t => {
  const f = await fixture(t, 2);
  f.feed("Delegate synthetic parent task");
  await until(() => f.taskIds.length === 1 && f.workerCalls === 1 && f.session.isIdle, "parent dispatch"); await f.flush();
  f.releaseWorker(0);
  await until(() => f.taskIds.length === 2 && f.workerCalls === 2 && f.sent.some(s => s.text === `Report verified for ${f.taskIds[0]}`), "parent report dispatches child"); await f.flush();
  assert.deepEqual(f.reportTasks, [f.taskIds[0]]);
  // A fresh different-chat request cannot redirect the already captured child.
  f.feed("Hold synthetic unrelated chat", 456);
  await until(() => f.foregroundGate === 1, "unrelated foreground");
  f.releaseWorker(1); await delay(150);
  assert.equal(f.reportTasks.length, 1, "child report waits, never merges into another chat");
  f.releaseForeground();
  await until(() => f.taskIds.length === 3 && f.workerCalls === 3 && f.sent.some(s => s.text === `Report verified for ${f.taskIds[1]}`), "child report dispatches grandchild"); await f.flush();
  f.releaseWorker(2);
  await until(() => f.sent.some(s => s.text === `Report verified for ${f.taskIds[2]}`), "grandchild owned report"); await f.flush();
  await delay(200);
  assert.deepEqual(f.reportTasks, f.taskIds);
  for (const id of f.taskIds) {
    const finals = f.sent.filter(s => s.text === `Report verified for ${id}`);
    assert.equal(finals.length, 1); assert.equal(finals[0].chat_id, 123);
    const records = (await f.ledger(id)).records;
    assert.equal(records.filter(r => r.phase === "task_captured").length, 1);
    const notice = records.find(r => r.phase === "notice_queued" && r.kind === "settled")!;
    assert.ok(notice);
    for (const phase of ["report_submitted", "report_started", "generated", "settled", "send_attempt", "api_attempt", "api_ack", "sent"]) {
      assert.equal(records.filter(r => r.notice === notice.notice && r.reply === notice.reply && r.phase === phase).length, 1, `${phase} correlates to its own report`);
    }
    const sent = records.find(r => r.notice === notice.notice && r.phase === "sent")!;
    assert.equal(sent.outcome, "acknowledged");
    assert.equal(records.find(r => r.phase === "api_ack")!.delivery, sent.delivery);
    assert.ok(!JSON.stringify(records).includes("Report verified"));
    assert.ok(!JSON.stringify(records).includes("chat_id"));
  }
  // Continuation capture is correlated to the actual parent report, not a fabricated human turn.
  for (let i = 1; i < f.taskIds.length; i++) {
    const capture = (await f.ledger(f.taskIds[i])).records.find(r => r.phase === "task_captured")!;
    const parent = (await f.ledger(f.taskIds[i - 1])).records.find(r => r.phase === "report_started")!;
    assert.equal(capture.reply, parent.reply); assert.equal(capture.notice, parent.notice);
  }
  assert.equal(f.sent.filter(s => s.chat_id === 456).length, 1);
  assert.deepEqual(f.errors, []);
});

test("actual SDK navigation after report-owned child capture suppresses the child notice without generic fallback or replay", async t => {
  const f = await fixture(t, 1);
  f.feed("Delegate synthetic parent task");
  await until(() => f.workerCalls === 1 && f.session.isIdle, "parent"); f.releaseWorker(0);
  await until(() => f.taskIds.length === 2 && f.workerCalls === 2 && f.session.isIdle, "captured child"); await f.flush();
  await f.session.extensionRunner.emit({ type: "session_before_tree", signal: new AbortController().signal, preparation: { targetId: "synthetic", oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false } });
  f.releaseWorker(1); await delay(250); await f.flush();
  assert.deepEqual(f.reportTasks, [f.taskIds[0]]);
  assert.equal(f.sent.filter(s => s.text === `Report verified for ${f.taskIds[1]}`).length, 0);
  const records = (await f.ledger(f.taskIds[1])).records;
  assert.equal(records.filter(r => r.phase === "task_captured").length, 1);
  assert.equal(records.filter(r => r.phase === "notice_suppressed" && r.reason === "route_expired").length, 1);
  assert.equal(records.filter(r => r.phase === "report_submitted").length, 0);
  assert.deepEqual(f.errors, []);
});

test("actual queued identical authenticated steering consumes each submission once without duplicate replies", async t => {
  const f = await fixture(t);
  f.feed("Hold synthetic initial request");
  await until(() => f.foregroundGate === 1, "steering gate");
  const correction = "Use the identical authenticated correction";
  f.feed(correction); f.feed(correction);
  await until(() => f.session.getSteeringMessages().length === 2, "identical pending steering");
  f.releaseForeground(); await until(() => f.session.isIdle && f.sent.length === 1, "steering settlement"); await f.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.chat_id, 123);
  assert.deepEqual(f.errors, []);
});
