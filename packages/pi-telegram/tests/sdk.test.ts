import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type, type Api, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stamp } from "../src/config.ts";

const workspace = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
await mkdir(workspace, { recursive: true });
async function until(predicate: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) assert.fail("SDK acceptance timeout"); await delay(10); }
}

test("actual Pi file loader registers extension without opening resources in the factory", async t => {
  const root = await mkdtemp(resolve(workspace, "telegram-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = resolve(root, "agent");
  await mkdir(agentDir);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const extension = result.extensions.find(item => item.path.endsWith("index.ts"))!;
  assert.ok(extension.tools.has("telegram_send"));
  assert.equal(extension.commands.size, 0);
  assert.ok(extension.flags.has("telegram-off"));
  assert.equal(extension.handlers.has("message_update"), false);
  assert.equal(extension.handlers.has("tool_execution_start"), false);
  assert.ok(extension.handlers.has("agent_settled"));
  await assert.rejects(stat(resolve(root, "artifacts")), { code: "ENOENT" });
});

test("actual Pi SDK consumes Telegram inputs, hides intermediate tool turns, sends only the settled final, and shuts down", async t => {
  const root = await mkdtemp(resolve(workspace, "telegram-sdk-"));
  const agentDir = resolve(root, "agent");
  await mkdir(agentDir);
  await writeFile(resolve(root, ".env"), "TELEGRAM_BOT_TOKEN=OFFLINE-TEST-TOKEN\nTELEGRAM_ALLOWED_ID=123\nGROQ_API_KEY=OFFLINE-GROQ\nELEVENLABS_API_KEY=OFFLINE-ELEVEN\nELEVENLABS_VOICE_ID=fixture-voice\nELEVENLABS_MODEL_ID=eleven_v4\n", { mode: 0o600 });
  await writeFile(resolve(root, "attachment.txt"), "Test");
  const originalFetch = globalThis.fetch;
  const previousOffline = process.env.PI_OFFLINE;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousEnvFile = process.env.TELEGRAM_ENV_FILE;
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.TELEGRAM_ENV_FILE;
  const sent: { chat_id: number; text: string }[] = [];
  const methods: string[] = [];
  const speechScripts: string[] = [];
  const errors: string[] = [];
  let pending: unknown[] = [];
  let wake: (() => void) | undefined;
  let first = true;
  let pollsAborted = 0;
  let toolExecutions = 0;
  let telegramContextSeen = false;
  let incomingTranscript = "A normal spoken request.";
  let blockNextTool = false;
  let toolBlocked = false;
  let releaseTool: (() => void) | undefined;
  let revisedContextSeen = false;
  let inputBlocked = false;
  let releaseInput: (() => void) | undefined;
  const success = (result: unknown) => Response.json({ ok: true, result });
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://api.groq.com/openai/v1/audio/transcriptions") {
      assert.equal((init!.body as FormData).get("model"), "whisper-large-v3-turbo");
      return Response.json({ text: incomingTranscript });
    }
    if (String(url).startsWith("https://api.telegram.org/file/botOFFLINE-TEST-TOKEN/")) {
      return new Response(Buffer.from("OggS---OpusHead input audio"));
    }
    if (String(url).startsWith("https://api.elevenlabs.io/v1/text-to-speech/fixture-voice?")) {
      const request = JSON.parse(init!.body as string);
      assert.equal(request.model_id, "eleven_v4");
      speechScripts.push(request.text);
      return new Response(Buffer.from("OggS---OpusHead offline audio"));
    }
    assert.ok(String(url).startsWith("https://api.telegram.org/botOFFLINE-TEST-TOKEN/"), "No real network or credentials are permitted in this test");
    const method = String(url).split("/").pop()!;
    methods.push(method);
    const args = init!.body instanceof FormData ? init!.body : JSON.parse(init!.body as string);
    if (["sendVoice", "sendDocument"].includes(method)) { assert.equal((args as FormData).get("caption"), null); return success({}); }
    if (method === "getMe") return success({ id: 999 });
    if (method === "getWebhookInfo") return success({ url: "" });
    if (method === "getFile") return success({ file_path: "voice.oga" });
    if (method === "sendMessage") { sent.push(args); return success({}); }
    if (method === "getUpdates") {
      if (first) { first = false; return success([]); }
      if (!pending.length) await new Promise<void>((done, reject) => {
        const abort = () => { pollsAborted++; wake = undefined; reject(new Error("aborted")); };
        wake = () => { init!.signal?.removeEventListener("abort", abort); wake = undefined; done(); };
        init!.signal?.addEventListener("abort", abort, { once: true });
        if (init!.signal?.aborted) abort();
      });
      const updates = pending; pending = []; return success(updates);
    }
    assert.ok(["sendChatAction", "deleteMyCommands"].includes(method));
    return success(true);
  };
  const provider = "telegram-offline-fixture";
  const model: Model<Api> = { id: "test", name: "Offline fixture", provider, api: "telegram-fake-api", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  const fake = (pi: ExtensionAPI) => {
    pi.on("input", async event => {
      if (event.text.includes("Slow hook: Use the revised instructions")) {
        inputBlocked = true;
        await new Promise<void>(done => { releaseInput = done; });
      }
    });
    pi.registerProvider(provider, { baseUrl: model.baseUrl, apiKey: "INERT-TEST-KEY", api: model.api, models: [model],
      streamSimple(m, context) {
        telegramContextSeen = JSON.stringify(context.messages).includes("current request arrived via Telegram");
        assert.ok(telegramContextSeen, "Telegram transport context must reach the model without an extra user label");
        const guidance = JSON.stringify(context.messages);
        assert.ok(guidance.includes("Send voice messages only when the user explicitly asks"));
        assert.ok(!guidance.includes("Prefer replying with telegram_send speech"));
        const stream = createAssistantMessageEventStream();
        const last = context.messages.filter(item => item.role !== "system").at(-1)!;
        const user = JSON.stringify(context.messages.filter(item => item.role === "user").at(-1));
        const voice = user.includes("Voice please");
        const file = user.includes("File only please");
        const silent = user.includes("Stay silent please");
        const revised = user.includes("Use the revised instructions");
        if (revised) revisedContextSeen = true;
        const tool = last.role === "user" && !silent;
        const toolCall: Pick<ToolCall, "name" | "arguments"> = voice ? { name: "telegram_send", arguments: { speech: "[warm, composed voice] Just my voice, sir." } }
          : file ? { name: "telegram_send", arguments: { path: "attachment.txt" } } : { name: "verify_fixture", arguments: {} };
        const message: AssistantMessage = {
          role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
          content: tool ? [{ type: "text", text: "Do not forward this progress." }, { type: "toolCall", id: `verify-${Date.now()}`, ...toolCall }]
            : [{ type: "thinking", thinking: "Never forward this thinking." }, { type: "text", text: file || silent ? "" : revised ? "Revised final reply." : "Verified final reply." }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
          stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
          stream.end();
        });
        return stream;
      },
    });
    pi.registerTool({ name: "verify_fixture", label: "Verify", description: "Offline fixture", parameters: Type.Object({}),
      async execute(_id, _args, signal) {
        toolExecutions++;
        if (blockNextTool) {
          blockNextTool = false;
          toolBlocked = true;
          await new Promise<void>(done => {
            releaseTool = done;
            signal?.addEventListener("abort", () => done(), { once: true });
          });
        }
        return { content: [{ type: "text", text: "Never forward this tool result." }], details: undefined };
      },
    });
  };
  const settings = SettingsManager.inMemory({ packages: [], defaultTools: ["verify_fixture", "telegram_send"], defaultProvider: provider, defaultModel: model.id,
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")], extensionFactories: [fake] });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  t.after(async () => {
    releaseTool?.();
    releaseInput?.();
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await session.abort(); session.dispose(); }
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({ PI_OFFLINE: previousOffline, PI_CODING_AGENT_DIR: previousAgentDir, TELEGRAM_ENV_FILE: previousEnvFile })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root), model }));
  await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error.error) });
  await until(() => methods.filter(method => method === "getUpdates").length >= 2);
  await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  assert.equal(methods.filter(method => method === "getMe").length, 1);
  assert.equal(pollsAborted, 0);
  pending.push({ update_id: 1, message: { message_id: 1, date: 1_791_000_000, from: { id: 123 }, chat: { id: 123, type: "private" }, text: "Please verify" } });
  wake?.();
  await until(() => sent.length === 1);
  await session.waitForIdle();
  assert.equal(toolExecutions, 1);
  assert.equal(sent[0].chat_id, 123);
  assert.equal(sent[0].text, "Verified final reply.");
  const user = session.messages.find(item => item.role === "user")!;
  assert.ok(JSON.stringify(user).includes(stamp("Please verify", new Date(1_791_000_000_000))));
  assert.ok(!JSON.stringify(user).includes("Telegram user"));
  assert.ok(telegramContextSeen);
  assert.deepEqual(errors, []);
  assert.ok(methods.includes("deleteMyCommands"));
  const feed = (id: number, text: string) => {
    pending.push({ update_id: id, message: { message_id: id, date: 1_791_000_000, from: { id: 123 }, chat: { id: 123, type: "private" }, text } });
    wake?.();
  };
  feed(2, "Voice please");
  await until(() => methods.includes("sendVoice"));
  await session.waitForIdle();
  await delay(80);
  assert.equal(sent.length, 1, "speech tool termination must not generate a false missing-final warning or chat afterward");
  assert.deepEqual(speechScripts, ["[warm, composed voice] Just my voice, sir."]);
  assert.equal(methods.filter(method => method === "sendVoice").length, 1);
  feed(3, "File only please");
  await until(() => methods.includes("sendDocument"));
  await session.waitForIdle();
  await delay(80);
  assert.equal(sent.length, 1, "attachment-only empty finals are successful and silent");
  feed(4, "Stay silent please");
  await until(() => session!.messages.filter(item => item.role === "user").length === 4);
  await session.waitForIdle();
  await delay(80);
  assert.equal(sent.length, 1, "intentional empty final with no delivery is not an error");
  const feedVoice = (id: number, transcript: string) => {
    incomingTranscript = transcript;
    pending.push({ update_id: id, message: { message_id: id, date: 1_791_000_000, from: { id: 123 }, chat: { id: 123, type: "private" }, voice: { file_id: "voice", mime_type: "audio/ogg" } } });
    wake?.();
  };
  feedVoice(5, "A normal spoken request.");
  await until(() => sent.length === 2);
  await session.waitForIdle();
  assert.equal(sent[1].text, "Verified final reply.");
  assert.equal(methods.filter(method => method === "sendVoice").length, 1, "Voice input alone must not trigger speech");
  assert.equal(speechScripts.length, 1, "Normal voice input must not call ElevenLabs");
  feedVoice(6, "Voice please");
  await until(() => methods.filter(method => method === "sendVoice").length === 2);
  await session.waitForIdle();
  await delay(80);
  assert.equal(sent.length, 2, "An explicit transcribed voice request remains voice-only");
  assert.equal(speechScripts.length, 2);
  assert.deepEqual(errors, []);

  // A real mid-tool correction must enter Pi's steering queue, not its follow-up queue.
  blockNextTool = true;
  feed(7, "Hold for my correction");
  await until(() => toolBlocked);
  assert.equal(session.isIdle, false);
  feed(8, "Use the revised instructions");
  await until(() => session!.getSteeringMessages().length === 1);
  assert.equal(session.getFollowUpMessages().length, 0);
  assert.equal(sent.length, 2, "the active task must not settle before consuming the correction");
  releaseTool?.();
  await until(() => sent.length === 3);
  await session.waitForIdle();
  assert.equal(revisedContextSeen, true);
  assert.equal(sent[2].text, "Revised final reply.");
  assert.equal(session.messages.filter(item => item.role === "user").length, 8);
  assert.equal(session.getSteeringMessages().length, 0);
  assert.equal(session.getFollowUpMessages().length, 0);
  assert.deepEqual(errors, []);

  // Input hooks can outlive the original run; the late new run must keep its reply owner.
  blockNextTool = true;
  toolBlocked = false;
  feed(9, "Hold for a slow input hook");
  await until(() => toolBlocked);
  feed(10, "Slow hook: Use the revised instructions");
  await until(() => inputBlocked);
  releaseTool?.();
  await until(() => sent.length === 4);
  await session.waitForIdle();
  assert.equal(sent[3].text, "Verified final reply.");
  releaseInput?.();
  await until(() => sent.length === 5);
  await session.waitForIdle();
  assert.equal(sent[4].text, "Revised final reply.");
  assert.equal(session.messages.filter(item => item.role === "user").length, 10);
  assert.deepEqual(errors, []);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.ok(pollsAborted >= 1);
  const count = methods.length;
  await delay(300);
  assert.equal(methods.length, count, "shutdown must stop polling and typing");
});
