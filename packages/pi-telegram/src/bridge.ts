import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentActivityOutcome, ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { ApiError, TelegramApi, imageMime, outboundFile, type Fetch, type MediaKind, type TgMessage, type TgUpdate } from "./api.ts";
import { type Config, DeliveryRefusal, type DeliveryRefusalCode, SafeError, redact, safeError, stamp } from "./config.ts";
import { ConnectionLease } from "./connection-lease.ts";
import { HumanInputScope } from "./human-input.ts";

const ALBUM_WAIT_MS = 1000;
interface QueuedRequest { messages: TgMessage[]; readyAt: number; content?: (TextContent | ImageContent)[] }
interface Reply {
  sessionId: string;
  controller: AbortController;
  started: boolean;
  submittedAt?: number;
  prompt?: string;
  steeringPrompts?: Set<string>;
  revision?: number;
  settling?: boolean;
  final?: string;
  outcome: AgentActivityOutcome;
  spoke?: boolean;
  delivered?: boolean;
}
interface Request extends QueuedRequest, Reply {}
interface Report extends Reply { chat: number; noticeId: string }
interface Notice { chat: number; sessionId: string; generation: number; id: string; content: string }
export interface SendParams { path?: string; paths?: string[]; kind?: MediaKind; speech?: string }

/** One Pi conversation and reply owner. Same-chat follow-ups steer; other chats wait. */
export class TelegramBridge {
  readonly api: TelegramApi;
  private controller = new AbortController();
  private queue: QueuedRequest[] = [];
  private active?: Request;
  private report?: Report;
  private foregroundOwner?: Request | Report;
  private foregroundRunning = false;
  private notices: Notice[] = [];
  private noticeIds = new Set<string>();
  private generation = 0;
  private humanInput?: HumanInputScope;
  private offOwner?: () => void;
  private directory: string;
  private stateDirectory: string;
  private offset?: number;
  private pollTask?: Promise<void>;
  private workTask?: Promise<void>;
  private worker?: ReturnType<typeof setInterval>;
  private typing?: ReturnType<typeof setInterval>;
  private typingTask?: Promise<void>;
  private sending: Promise<unknown> = Promise.resolve();
  private running = false;
  private connected = false;
  private state = "disconnected";
  private lease?: ConnectionLease;
  private startTask?: Promise<void>;
  private stopTask?: Promise<void>;

  constructor(private pi: ExtensionAPI, private ctx: ExtensionContext, readonly config: Config, fetcher?: Fetch) {
    this.api = new TelegramApi(config, fetcher);
    const bot = createHash("sha256").update(config.token).digest("hex").slice(0, 16);
    this.directory = resolve(config.dataDir, bot);
    this.stateDirectory = resolve(config.stateDir || config.dataDir, bot);
  }

  private listen(): void {
    this.humanInput = new HumanInputScope(this.pi);
    this.offOwner = this.pi.events.on("background-tasks:claim-owner:v1", data => {
      const query = data as { sessionId?: string; accept?: (route: (id: string, content: string) => boolean) => void };
      const request = this.active;
      if (!this.running || this.report || !request?.started || request.settling || request.controller.signal.aborted || this.foregroundOwner !== request ||
        query.sessionId !== this.ctx.sessionManager.getSessionId() || request.sessionId !== query.sessionId || typeof query.accept !== "function") return;
      // Capture the authenticated owner NOW, never an ambient last-chat fallback.
      const chat = request.messages[0].chat.id;
      const sessionId = request.sessionId;
      const generation = this.generation;
      const expiresAt = Date.now() + 7 * 86400_000;
      query.accept((id, content) => {
        if (!this.running || generation !== this.generation || Date.now() > expiresAt ||
          sessionId !== this.ctx.sessionManager.getSessionId()) return false;
        if (this.noticeIds.has(id)) return true;
        if (this.notices.length >= 128 || this.noticeIds.size >= 1024) return false;
        this.noticeIds.add(id);
        this.notices.push({ chat, sessionId, generation, id, content });
        return true;
      });
    });
  }

  get status(): string { return this.state; }
  get ownsConnection(): boolean { return this.running; }
  isTelegramPrompt(prompt: string): boolean {
    if (this.report?.prompt === prompt) return true;
    return Boolean(this.active?.prompt && (prompt.includes(this.active.prompt) ||
      [...this.active.steeringPrompts || []].some(text => prompt.includes(text))));
  }

  /** Navigation revokes ephemeral capabilities, including a switch that is later cancelled. */
  invalidate(): void {
    this.generation++;
    this.foregroundRunning = false;
    this.active?.controller.abort();
    this.report?.controller.abort();
    this.active = this.report = this.foregroundOwner = undefined;
    this.queue = []; this.notices = []; this.noticeIds.clear();
  }

  private reply(): Request | Report | undefined { return this.report || this.active; }
  private chat(reply: Request | Report): number { return "chat" in reply ? reply.chat : reply.messages[0].chat.id; }
  private submit(request: Request, content: (TextContent | ImageContent)[], deliverAs: "steer" | "followUp"): void {
    const text = content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const generation = this.generation;
    this.humanInput!.send(text, this.ctx.sessionManager.getSessionId(),
      () => this.running && generation === this.generation && !request.controller.signal.aborted,
      () => this.pi.sendUserMessage(content, { deliverAs, expandPromptTemplates: false }));
  }

  private statusChanged(connected: boolean, detail?: string): void {
    this.connected = connected;
    this.state = connected ? "connected" : `disconnected${detail ? `: ${detail}` : ""}`;
    if (this.ctx.mode === "tui") {
      this.ctx.ui.setStatus("pi-telegram", this.ctx.ui.theme.fg(connected ? "success" : "warning", `Telegram ${connected ? "● connected" : "○ disconnected"}`));
    }
  }

  async start(): Promise<void> {
    if (this.startTask) return this.startTask;
    if (this.running) return;
    if (this.stopTask) { await this.stopTask; return this.start(); }
    this.running = true;
    this.controller = new AbortController();
    this.listen();
    this.statusChanged(false, "connecting");
    this.startTask = this.startOwned().finally(() => { this.startTask = undefined; });
    return this.startTask;
  }

  private async cursor(path: string): Promise<number | undefined> {
    try {
      const state = JSON.parse(await readFile(path, "utf8"));
      if (!Number.isSafeInteger(state.offset) || state.offset < 0) throw new Error();
      return state.offset;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new SafeError("Telegram cursor is unreadable; refusing to replay old updates.");
    }
  }

  private async startOwned(): Promise<void> {
    try {
      this.lease = await ConnectionLease.acquire(this.config.lockDir || this.config.dataDir, this.config.token, this.controller.signal,
        () => { void this.stop("connection ownership interrupted"); });
      this.controller.signal.throwIfAborted();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      const path = resolve(this.stateDirectory, "cursor.json");
      const legacy = resolve(this.directory, "cursor.json");
      const positions = [await this.cursor(path)];
      if (legacy !== path) positions.push(await this.cursor(legacy));
      const valid = positions.filter((value): value is number => value !== undefined);
      this.offset = valid.length ? Math.max(...valid) : undefined;
      if (legacy !== path && positions[1] !== undefined) {
        // Migration happens only while holding ownership. Retain the newest accepted update.
        await this.saveCursor();
        await rm(legacy);
      }
      this.controller.signal.throwIfAborted();
      this.worker = setInterval(() => {
        if (!this.workTask) {
          this.workTask = this.processQueue().catch(() => this.statusChanged(false, "message processing failed")).finally(() => { this.workTask = undefined; });
        }
      }, 100);
      this.worker.unref();
      this.typing = setInterval(() => this.refreshTyping(), 4000);
      this.typing.unref();
      this.pollTask = this.poll();
    } catch (error) {
      await this.stop(safeError(error));
      throw error;
    }
  }

  stop(detail?: string): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.running = false;
    this.controller.abort();
    this.invalidate();
    this.humanInput?.close(); this.offOwner?.();
    this.humanInput = this.offOwner = undefined;
    if (this.worker) clearInterval(this.worker);
    if (this.typing) clearInterval(this.typing);
    this.worker = this.typing = undefined;
    this.queue = [];
    this.active = undefined;
    this.stopTask = (async () => {
      await Promise.allSettled([this.pollTask, this.workTask, this.typingTask, this.sending]);
      const lease = this.lease;
      this.lease = undefined;
      await lease?.release();
      this.pollTask = this.workTask = this.typingTask = undefined;
      this.statusChanged(false, detail);
    })().finally(() => { this.stopTask = undefined; });
    return this.stopTask;
  }

  private async saveCursor(): Promise<void> {
    const path = resolve(this.stateDirectory, "cursor.json");
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ offset: this.offset }), { mode: 0o600 });
    await rename(temp, path);
  }

  private async poll(): Promise<void> {
    const signal = this.controller.signal;
    let verified = false;
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (!verified) {
          await this.api.call("getMe", {}, signal);
          const hook = await this.api.call<{ url: string }>("getWebhookInfo", {}, signal);
          if (hook.url) throw new ApiError(409);
          await this.api.clearCommands(signal);
          verified = true;
        }
        const updates = await this.api.call<TgUpdate[]>("getUpdates", {
          ...(this.offset !== undefined ? { offset: this.offset } : {}), timeout: 30, limit: 100, allowed_updates: ["message"],
        }, signal);
        if (signal.aborted) break;
        this.statusChanged(true);
        failures = 0;
        for (const update of updates) {
          if (!Number.isSafeInteger(update.update_id) || (this.offset !== undefined && update.update_id < this.offset)) continue;
          if (update.message) await this.receive(update.message);
          if (signal.aborted) break;
          this.offset = update.update_id + 1;
          await this.saveCursor();
        }
      } catch (error) {
        if (signal.aborted) break;
        this.statusChanged(false, safeError(error));
        if ((error instanceof ApiError && [401, 403, 409].includes(error.code)) || !(error instanceof SafeError)) {
          if (this.ctx.hasUI) this.ctx.ui.notify(safeError(error), "warning");
          void this.stop(safeError(error));
          return;
        }
        try { await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal }); } catch { break; }
      }
    }
  }

  private authorized(message: TgMessage): boolean {
    return message.chat.type === "private" && !message.from?.is_bot &&
      this.config.allowed.has(String(message.from?.id)) && message.chat.id === message.from?.id;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.sending.then(fn, fn);
    this.sending = task.catch(() => {});
    return task;
  }

  private async text(chat: number, text: string, signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
    await this.serial(() => { combined.throwIfAborted(); return this.api.sendText(chat, text, combined); });
  }

  private async receive(message: TgMessage): Promise<void> {
    if (!this.authorized(message)) return;
    // Slash-prefixed text is ordinary input, never transport control or a Pi command.
    if (!message.text && !message.caption && !message.photo && !message.document && !message.video && !message.animation && !message.video_note && !message.voice && !message.audio) {
      await this.text(message.chat.id, "Send text, a file, photo, video or voice message.");
      return;
    }
    const existing = message.media_group_id && this.queue.find(item =>
      item.messages[0].chat.id === message.chat.id && item.messages[0].media_group_id === message.media_group_id);
    if (existing) {
      if (!existing.messages.some(item => item.message_id === message.message_id)) existing.messages.push(message);
      existing.messages.sort((a, b) => a.message_id - b.message_id);
      existing.readyAt = Date.now() + ALBUM_WAIT_MS;
    } else {
      if (this.queue.length >= 32) { await this.text(message.chat.id, "Telegram request queue is full. Please try again later."); return; }
      this.queue.push({ messages: [message], readyAt: Date.now() + (message.media_group_id ? ALBUM_WAIT_MS : 0) });
    }
    this.refreshTyping();
  }

  private refreshTyping(): void {
    if (!this.running || !this.connected || this.typingTask) return;
    const chats = new Set(this.queue.map(item => item.messages[0].chat.id));
    if (this.active) chats.add(this.active.messages[0].chat.id);
    if (!chats.size) return;
    this.typingTask = Promise.all([...chats].map(chat_id => this.api.call("sendChatAction", { chat_id, action: "typing" }, this.controller.signal).catch(() => {})))
      .then(() => {}).finally(() => { this.typingTask = undefined; });
  }

  private async prepare(request: Request): Promise<(TextContent | ImageContent)[]> {
    const signal = AbortSignal.any([this.controller.signal, request.controller.signal]);
    const parts: string[] = [];
    const paths: string[] = [];
    const content: (TextContent | ImageContent)[] = [];
    for (const message of request.messages) {
      const text = message.text || message.caption || "";
      if (text && !parts.includes(text)) parts.push(text);
      const photo = message.photo?.reduce((best, current) => (current.file_size || (current.width || 0) * (current.height || 0)) > (best.file_size || (best.width || 0) * (best.height || 0)) ? current : best);
      const file = photo || message.document || message.video || message.animation || message.video_note || message.voice || message.audio;
      if (!file) continue;
      const { data, filename } = await this.api.download(file, signal);
      const path = resolve(this.directory, `${message.message_id}-${randomUUID()}-${filename}`);
      await writeFile(path, data, { mode: 0o600, flag: "wx" });
      paths.push(path);
      const isVideo = Boolean(message.video || message.video_note || message.animation);
      const mime = imageMime(data);
      if (mime && !isVideo) content.push({ type: "image", data: data.toString("base64"), mimeType: mime });
      if (message.voice || message.audio) parts.push(`[Transcription]\n${await this.api.transcribe(data, filename, signal)}`);
    }
    if (paths.length) parts.push(`[Attachment/s]\n${paths.join("\n")}`);
    const date = new Date(Math.min(...request.messages.map(message => message.date)) * 1000);
    content.unshift({ type: "text", text: stamp(redact(parts.join("\n\n"), this.config), date) });
    return content;
  }

  private async steer(request: Request, followUp: QueuedRequest): Promise<void> {
    try {
      followUp.content ||= await this.prepare({ ...followUp, sessionId: request.sessionId, controller: request.controller, started: false, outcome: "completed" });
      if (!this.running || request.controller.signal.aborted) return;
      // Downloads/STT may outlive the run. Keep the prepared input for normal dispatch,
      // rather than attaching it to a settled request or downloading it twice.
      if (this.active !== request || request.settling || this.ctx.isIdle()) {
        this.queue.unshift(followUp);
        return;
      }
      const prompt = followUp.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      (request.steeringPrompts ||= new Set()).add(prompt);
      this.submit(request, followUp.content, "steer");
    } catch (error) {
      if (this.running) await this.text(followUp.messages[0].chat.id, safeError(error)).catch(() => {});
    }
  }

  private async processQueue(): Promise<void> {
    if (!this.running) return;
    if (this.report) {
      if (!this.report.started && this.report.submittedAt && Date.now() - this.report.submittedAt > 10_000 && this.ctx.isIdle()) {
        this.report.controller.abort(); this.report = undefined;
      }
      return;
    }
    if (this.active) {
      const request = this.active;
      if (!request.started && request.submittedAt && Date.now() - request.submittedAt > 10_000 && this.ctx.isIdle()) {
        request.controller.abort(); this.foregroundOwner = undefined; this.active = undefined;
        await this.text(request.messages[0].chat.id, "Pi did not start this request. Check the TUI for configuration or extension errors.");
      } else if (this.connected && request.started && !request.settling && !this.ctx.isIdle()) {
        // Do not let another chat's queued request block the current owner's correction.
        const index = this.queue.findIndex(item => item.messages[0].chat.id === request.messages[0].chat.id);
        if (index >= 0 && this.queue[index].readyAt <= Date.now()) await this.steer(request, this.queue.splice(index, 1)[0]);
      }
      return;
    }
    // isIdle becomes true before agent_settled observers finish. Wait for our own
    // lifecycle observation as well, so notices cannot enter an older run's settlement.
    if (!this.connected || this.foregroundRunning || !this.ctx.isIdle() || this.ctx.hasPendingMessages()) return;
    if (!this.queue.length) {
      const notice = this.notices.shift();
      if (!notice || notice.generation !== this.generation || notice.sessionId !== this.ctx.sessionManager.getSessionId()) return;
      const noticeId = randomUUID();
      this.report = { chat: notice.chat, noticeId, sessionId: notice.sessionId, prompt: notice.content, controller: new AbortController(),
        started: false, submittedAt: Date.now(), outcome: "completed" };
      try {
        this.pi.sendMessage({ customType: "background-notice", content: notice.content, display: false,
          details: { telegramNoticeId: noticeId } }, { triggerTurn: true, deliverAs: "followUp" });
      } catch { this.report.controller.abort(); this.report = undefined; }
      return;
    }
    if (this.queue[0].readyAt > Date.now()) return;
    const request: Request = { ...this.queue.shift()!, sessionId: this.ctx.sessionManager.getSessionId(), controller: new AbortController(), started: false, outcome: "completed" };
    this.active = request;
    this.refreshTyping();
    try {
      const content = request.content || await this.prepare(request);
      if (!this.running || request.controller.signal.aborted) throw new SafeError("Request cancelled.");
      const signal = AbortSignal.any([this.controller.signal, request.controller.signal]);
      while (!this.ctx.isIdle() || this.ctx.hasPendingMessages()) await delay(100, undefined, { signal });
      signal.throwIfAborted();
      request.prompt = content.filter(block => block.type === "text").map(block => block.text).join("\n");
      request.submittedAt = Date.now();
      this.submit(request, content, "followUp");
    } catch (error) {
      request.controller.abort();
      if (this.active === request) this.active = this.foregroundOwner = undefined;
      if (this.running) await this.text(request.messages[0].chat.id, safeError(error)).catch(() => {});
    }
  }

  input(event: InputEvent): void {
    // Text equality alone is not authority: an intervening local/generic input can
    // repeat the exact Telegram prompt. Only this bridge's async submission is owned.
    if (this.humanInput?.matches(event, this.ctx.sessionManager.getSessionId())) return;
    this.active?.controller.abort(); this.report?.controller.abort();
    this.foregroundOwner = undefined;
  }

  userStart(message: { role: string; content?: unknown; customType?: string; details?: unknown }): void {
    if (message.role === "custom") {
      const id = (message.details as { telegramNoticeId?: unknown } | undefined)?.telegramNoticeId;
      this.foregroundOwner = undefined;
      if (this.report && message.customType === "background-notice" && id === this.report.noticeId && !this.report.started && !this.report.controller.signal.aborted) {
        this.report.started = true;
        this.foregroundOwner = this.report;
      } else if (this.report) { this.report.started = false; this.report.controller.abort(); }
      if (this.active) this.active.controller.abort();
      return;
    }
    if (message.role !== "user") return;
    // A local/RPC user that intervenes in a report must not capture its chat or final.
    if (this.report) { this.report.started = false; this.report.controller.abort(); }
    this.foregroundOwner = undefined;
    if (!this.active?.prompt) return;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.filter(block => block?.type === "text").map(block => block.text).join("\n") : "";
    const steering = [...this.active.steeringPrompts || []].find(prompt => text === prompt);
    if (steering) {
      this.active.steeringPrompts!.delete(steering);
      this.active.revision = (this.active.revision || 0) + 1;
      this.active.settling = false;
      // Only a consumed correction supersedes the old final/voice-only state.
      this.active.final = undefined;
      this.active.spoke = this.active.delivered = false;
      this.active.outcome = "completed";
    }
    if (text === this.active.prompt || steering) { this.active.started = true; this.foregroundOwner = this.active; }
    else this.active.controller.abort();
  }

  assistantEnd(message: { role: string; content?: unknown; stopReason?: string }): void {
    const request = this.reply();
    if (!request?.started || request.controller.signal.aborted || message.role !== "assistant" || !Array.isArray(message.content)) return;
    if (message.stopReason === "toolUse" || message.content.some(block => block?.type === "toolCall")) {
      request.final = undefined;
      return;
    }
    const successful = ["stop", "length"].includes(message.stopReason || "");
    request.outcome = successful ? "completed" : message.stopReason === "aborted" ? "aborted" : "error";
    request.final = successful ? message.content.filter(block => block?.type === "text").map(block => block.text).join("\n").trim() : undefined;
  }

  boundary(outcome: AgentActivityOutcome): void { const request = this.reply(); if (request?.started) request.outcome = outcome; }

  agentStart(): void { this.foregroundRunning = true; }

  async settled(): Promise<void> {
    this.foregroundRunning = false;
    const request = this.reply();
    if (request?.settling) return;
    if (!request?.started || request.controller.signal.aborted) {
      // Pi advertises idle before all agent_settled observers finish. A queue timer
      // can submit a deferred report in that interval; this is the OLD run's event,
      // not settlement of the report. Keep it pending, still unauthorized until its
      // matching custom message starts. Cancellation/watchdog/navigation still revoke it.
      if (this.report === request && request?.controller.signal.aborted) {
        this.report = undefined;
        if (this.foregroundOwner === request) this.foregroundOwner = undefined;
      }
      if (this.active === request && request?.controller.signal.aborted) this.active = this.foregroundOwner = undefined;
      return;
    }
    request.settling = true;
    const revision = request.revision;
    const chat = this.chat(request);
    try {
      if (!this.running) return;
      if (request.outcome !== "completed") {
        await this.text(chat, request.outcome === "aborted" ? "Pi request was cancelled." : "Pi could not complete this request. Check the TUI for details.", request.controller.signal);
      } else if (request.spoke) {
        // An explicit voice message is the complete reply, even if the model says 'Sent' afterward.
        return;
      } else if (request.final) {
        // Input format does not opt the user into speech. Only explicit tool sends produce voice.
        await this.text(chat, request.final, request.controller.signal);
      }
      // A successful empty final or attachment-only reply intentionally sends no chat.
    } catch (error) {
      if (this.running && !request.controller.signal.aborted) {
        await this.text(chat, safeError(error), request.controller.signal).catch(() => {});
        if (this.ctx.hasUI) this.ctx.ui.notify(safeError(error), "warning");
      }
    } finally {
      if (this.report === request) {
        this.report = undefined;
        if (this.foregroundOwner === request) this.foregroundOwner = undefined;
      }
      if (this.active === request && request.revision === revision) {
        this.foregroundOwner = undefined;
        if (this.running && request.steeringPrompts?.size) {
          // A slow input hook can finish after settlement and start a new run.
          // Retain the reply owner until that already-submitted input is consumed.
          request.started = false;
          request.settling = false;
          request.submittedAt = Date.now();
          request.final = undefined;
        } else this.active = undefined;
      }
    }
  }

  private assertDelivery(request: Request | Report | undefined, signal?: AbortSignal): asserts request is Request | Report {
    const refuse = (code: DeliveryRefusalCode): never => { throw new DeliveryRefusal(code, {
      running: this.running, connected: this.connected, context: !request ? "none" : "chat" in request ? "report" : "request",
      started: Boolean(request?.started), settling: Boolean(request?.settling), cancelled: Boolean(request?.controller.signal.aborted),
      owned: Boolean(request && this.foregroundOwner === request),
    }); };
    if (!this.running) refuse("TG_BRIDGE_STOPPED");
    if (!this.connected) refuse("TG_BRIDGE_DISCONNECTED");
    if (!request) return refuse("TG_NO_CONTEXT");
    if (request.controller.signal.aborted) refuse("TG_CONTEXT_CANCELLED");
    if (this.reply() !== request) refuse("TG_CONTEXT_REPLACED");
    if (!request.started) refuse("TG_CONTEXT_NOT_STARTED");
    if (request.settling) refuse("TG_CONTEXT_SETTLING");
    if (this.foregroundOwner !== request) refuse("TG_CONTEXT_NOT_OWNER");
    if (request.sessionId !== this.ctx.sessionManager.getSessionId()) refuse("TG_SESSION_CHANGED");
    if (!this.config.allowed.has(String(this.chat(request)))) refuse("TG_RECIPIENT_NOT_ALLOWED");
    if (signal?.aborted) refuse("TG_CALL_CANCELLED");
  }

  async send(params: SendParams, signal?: AbortSignal): Promise<void> {
    const request = this.reply();
    this.assertDelivery(request, signal);
    const modes = [Boolean(params.path), params.paths !== undefined, Boolean(params.speech)].filter(Boolean).length;
    if (modes !== 1) throw new SafeError("Provide exactly one of path, paths or speech.");
    if (params.paths && (params.paths.length < 1 || params.paths.length > 10)) throw new SafeError("Provide 1–10 attachment paths.");
    const signals = [this.controller.signal, request.controller.signal];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);
    const beforeUpload = () => this.assertDelivery(request, signal);
    await this.serial(async () => {
      beforeUpload();
      if (params.speech) {
        await this.api.speak(this.chat(request), params.speech, combined, beforeUpload);
        request.spoke = request.delivered = true;
      } else {
        const files = await Promise.all((params.paths || [params.path!]).map(path => outboundFile(this.ctx.cwd, path, params.kind, this.config.dataDir)));
        beforeUpload();
        await this.api.sendGroup(this.chat(request), files, combined, beforeUpload);
        request.delivered = true;
        if (files.some(file => file.kind === "voice")) request.spoke = true;
      }
    });
  }
}
