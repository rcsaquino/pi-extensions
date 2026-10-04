import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { SendParams } from "../src/bridge.ts";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "Offline send-result timeout"); await delay(10); }
}

test("telegram_send success results distinguish attachments from voice and preserve SDK follow-up behavior", async t => {
  const scratch = process.env.TELEGRAM_TEST_DIR || resolve(import.meta.dirname, "../temp_files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, "send-result-"));
  const agentDir = resolve(root, "agent"); await mkdir(agentDir);
  await writeFile(resolve(root, ".env"), "TELEGRAM_BOT_TOKEN=SEND-RESULT-OFFLINE\nTELEGRAM_ALLOWED_ID=123\nGROQ_API_KEY=OFFLINE-GROQ\nELEVENLABS_API_KEY=OFFLINE-ELEVEN\nELEVENLABS_VOICE_ID=fixture-voice\nELEVENLABS_MODEL_ID=eleven_v4\n", { mode: 0o600 });
  for (const name of ["report.txt", "second.txt", "photo.jpg", "video.mp4"]) await writeFile(resolve(root, name), "Synthetic attachment");
  await writeFile(resolve(root, "voice.ogg"), "OggS---OpusHead synthetic voice");
  const oldFetch = globalThis.fetch;
  const oldEnv = { PI_OFFLINE: process.env.PI_OFFLINE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TELEGRAM_ENV_FILE: process.env.TELEGRAM_ENV_FILE };
  process.env.PI_OFFLINE = "1"; process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.TELEGRAM_ENV_FILE;
  const uploads: { method: string; body: FormData }[] = [];
  const sent: { chat_id: number; text: string }[] = [];
  const scripts: string[] = [];
  const errors: string[] = [];
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  let polls = 0;
  const ok = (result: unknown) => Response.json({ ok: true, result });
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.elevenlabs.io/v1/text-to-speech/fixture-voice?")) {
      const body = JSON.parse(init!.body as string);
      assert.equal(body.model_id, "eleven_v4"); scripts.push(body.text);
      return new Response(Buffer.from("OggS---OpusHead synthetic speech"));
    }
    assert.ok(String(url).startsWith("https://api.telegram.org/botSEND-RESULT-OFFLINE/"), "Only mock transport is permitted");
    const method = String(url).split("/").pop()!;
    if (["sendDocument", "sendPhoto", "sendVideo", "sendMediaGroup", "sendVoice"].includes(method)) {
      assert.ok(init!.body instanceof FormData);
      const body = init!.body as FormData;
      assert.equal(body.get("chat_id"), "123");
      assert.equal(body.get("caption"), null);
      if (method === "sendMediaGroup") {
        const media = JSON.parse(body.get("media") as string);
        assert.equal(media.length, 2);
        for (const item of media) {
          assert.equal(Object.hasOwn(item, "caption"), false);
          assert.ok(item.media.startsWith("attach://"));
          assert.ok(body.get(item.media.slice("attach://".length)) instanceof Blob);
        }
      } else {
        const field = ({ sendDocument: "document", sendPhoto: "photo", sendVideo: "video", sendVoice: "voice" } as Record<string, string>)[method];
        assert.ok(body.get(field) instanceof Blob);
      }
      uploads.push({ method, body }); return ok({});
    }
    const body = JSON.parse(init!.body as string);
    if (method === "getMe") return ok({ id: 999 });
    if (method === "getWebhookInfo") return ok({ url: "" });
    if (method === "sendMessage") { sent.push(body); return ok({}); }
    if (method === "getUpdates") {
      if (++polls === 1) return ok([]);
      if (!pending.length) await new Promise<void>((done, reject) => {
        const abort = () => { wake = undefined; reject(new Error("synthetic abort")); };
        wake = () => { init!.signal?.removeEventListener("abort", abort); wake = undefined; done(); };
        init!.signal?.addEventListener("abort", abort, { once: true });
        if (init!.signal?.aborted) abort();
      });
      return ok(pending.splice(0));
    }
    assert.ok(["sendChatAction", "deleteMyCommands"].includes(method)); return ok(true);
  };
  const cases: { name: string; params: SendParams; method: string; voice?: boolean; mediaTypes?: string[] }[] = [
    { name: "document", params: { path: "report.txt" }, method: "sendDocument" },
    { name: "photo", params: { path: "photo.jpg", kind: "photo" }, method: "sendPhoto" },
    { name: "video", params: { path: "video.mp4", kind: "video" }, method: "sendVideo" },
    { name: "photo/video album", params: { paths: ["photo.jpg", "video.mp4"] }, method: "sendMediaGroup", mediaTypes: ["photo", "video"] },
    { name: "document album", params: { paths: ["report.txt", "second.txt"], kind: "document" }, method: "sendMediaGroup", mediaTypes: ["document", "document"] },
    { name: "speech", params: { speech: "[warm, composed voice] Synthetic voice-only reply." }, method: "sendVoice", voice: true },
    { name: "explicit voice", params: { path: "voice.ogg", kind: "voice" }, method: "sendVoice", voice: true },
  ];
  let current = cases[0];
  let providerCalls = 0;
  const provider = "send-result-offline";
  const model: Model<Api> = { id: "test", name: "Offline fixture", provider, api: "send-result-api", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  const fake = (pi: ExtensionAPI) => pi.registerProvider(provider, { baseUrl: model.baseUrl, apiKey: "INERT", api: model.api, models: [model],
    streamSimple(m, context) {
      providerCalls++;
      const tool = context.messages.filter(item => item.role !== "system").at(-1)!.role === "user";
      const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
        content: tool ? [{ type: "toolCall", id: `send-${providerCalls}`, name: "telegram_send", arguments: { ...current.params } }]
          : [{ type: "text", text: `Explanation after ${current.name}.` }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } }); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(); });
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({ packages: [], defaultTools: ["telegram_send"], defaultProvider: provider, defaultModel: model.id,
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")], extensionFactories: [fake] });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  t.after(async () => {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await session.abort(); session.dispose(); }
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  // Observe the real tool result before Pi consumes terminate; do not replace delivery or guards.
  const definition = loader.getExtensions().extensions.find(item => item.tools.has("telegram_send"))!.tools.get("telegram_send")!.definition;
  const execute = definition.execute;
  const results: Awaited<ReturnType<ToolDefinition["execute"]>>[] = [];
  definition.execute = async (...args) => { const result = await execute(...args); results.push(result); return result; };
  ({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root), model }));
  await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error.error) });
  await until(() => polls >= 2);
  for (const [index, scenario] of cases.entries()) await t.test(scenario.name, async () => {
    current = scenario;
    const callsBefore = providerCalls, sentBefore = sent.length, uploadBefore = uploads.length, resultBefore = results.length;
    pending.push({ update_id: index + 1, message: { message_id: index + 1, date: 1791000000, from: { id: 123 }, chat: { id: 123, type: "private" }, text: scenario.voice ? "Explicitly send a voice reply please." : `Send ${scenario.name} and explain it.` } }); wake?.();
    await until(() => results.length === resultBefore + 1);
    await session!.waitForIdle(); await delay(30);
    assert.equal(uploads.length, uploadBefore + 1);
    const upload = uploads.at(-1)!;
    assert.equal(upload.method, scenario.method);
    if (scenario.mediaTypes) assert.deepEqual(JSON.parse(upload.body.get("media") as string).map((item: { type: string }) => item.type), scenario.mediaTypes);
    const result = results.at(-1)!;
    assert.deepEqual(result.details, { sent: true });
    assert.deepEqual(result.content, [{ type: "text", text: scenario.voice ? "Delivered to Telegram. Voice replies are complete; no chat is needed." : "Delivered to Telegram." }]);
    if (scenario.voice) assert.equal(result.terminate, true);
    else assert.equal(Object.hasOwn(result, "terminate"), false);
    assert.equal(providerCalls - callsBefore, scenario.voice ? 1 : 2, "Only voice skips the automatic model follow-up");
    assert.equal(sent.length - sentBefore, scenario.voice ? 0 : 1, "Ordinary attachment explanations are forwarded; voice stays voice-only");
    if (!scenario.voice) assert.deepEqual(sent.at(-1), { chat_id: 123, text: `Explanation after ${scenario.name}.` });
    assert.deepEqual(errors, []);
  });
  assert.deepEqual(scripts, [cases.find(item => item.name === "speech")!.params.speech]);
});
