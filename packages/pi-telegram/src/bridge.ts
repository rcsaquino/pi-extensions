import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentActivityOutcome, ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { ApiError, TelegramApi, imageMime, outboundFile, type Fetch, type MediaKind, type OutgoingFile, type TgMessage, type TgUpdate, type TgUser } from "./api.ts";
import { type Config, DeliveryRefusal, type DeliveryRefusalCode, SafeError, redact, safeError, stamp } from "./config.ts";
import { ConnectionLease } from "./connection-lease.ts";
import { HumanInputScope } from "./human-input.ts";
import { formatReplyContext } from "./reply-context.ts";
import { SentMediaRegistry, type SentMediaRecord } from "./sent-media.ts";
import { DeliveryLedger, type DeliveryContext, type DeliveryEvent } from "./delivery-ledger.ts";

const ALBUM_WAIT_MS = 1000;
/** Timestamp metadata is emitted at most once per session in any 30-minute window. */
const STAMP_INTERVAL_MS = 30 * 60_000;

interface QueuedRequest { messages: TgMessage[]; readyAt: number; content?: (TextContent | ImageContent)[] }
/** One observed Pi run. Telegram requests carry their messages; every other run is mirrored. */
interface Reply {
  sessionId: string;
  chat: number;
  controller: AbortController;
  started: boolean;
  submittedAt?: number;
  prompt?: string;
  diagnosticId?: string;
  taskId?: string;
  cancellation?: "foreign_input" | "unowned_user_start" | "custom_interruption";
  revision?: number;
  settling?: boolean;
  final?: string;
  pendingFinals?: { text: string; revision: number }[];
  outcome: AgentActivityOutcome;
  spoke?: boolean;
  delivered?: boolean;
}
interface Request extends Reply { messages: TgMessage[]; content?: (TextContent | ImageContent)[] }
type DiagnosticReason = NonNullable<Reply["cancellation"]> | "context_revoked" | "owner_session_or_allowlist_changed" | "outcome_unknown";
export interface SendParams { path?: string; paths?: string[]; kind?: MediaKind; speech?: string }

/** One Pi session and one destination chat. Inbound requests reply to their chat; every other settled turn is mirrored. */
export class TelegramBridge {
  readonly api: TelegramApi;
  readonly ledger: DeliveryLedger;
  private controller = new AbortController();
  private queue: QueuedRequest[] = [];
  private active?: Request;
  private run?: Reply;
  private foregroundRunning = false;
  private generation = 0;
  private humanInput?: HumanInputScope;
  private directory: string;
  private stateDirectory: string;
  private offset?: number;
  private botId?: number;
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
  private media?: SentMediaRegistry;
  private lastStamp?: { sessionId: string; at: number };
  private readonly destination: number;

  constructor(private pi: ExtensionAPI, private ctx: ExtensionContext, readonly config: Config, fetcher?: Fetch) {
    this.ledger = new DeliveryLedger(config.diagnosticsDir || resolve(config.stateDir || config.dataDir, "diagnostics"));
    this.api = new TelegramApi(config, fetcher, this.ledger);
    const bot = createHash("sha256").update(config.token).digest("hex").slice(0, 16);
    this.directory = resolve(config.dataDir, bot);
    this.stateDirectory = resolve(config.stateDir || config.dataDir, bot);
    this.destination = Number([...config.allowed][0]);
  }

  private listen(): void {
    this.humanInput = new HumanInputScope();
  }

  get status(): string { return this.state; }
  get ownsConnection(): boolean { return this.running; }
  isTelegramPrompt(prompt: string): boolean {
    return Boolean(this.active && (prompt === this.active.prompt || this.humanInput?.hasPrompt(this.active, prompt)));
  }

  /** Navigation revokes ephemeral capabilities, including a switch that is later cancelled. */
  invalidate(): void {
    if (this.run) this.record({ ...this.correlation(this.run, "reply"), phase: "suppressed", outcome: "suppressed", reason: "navigation_or_shutdown" });
    this.generation++;
    this.foregroundRunning = false;
    this.run?.controller.abort();
    this.run = this.active = undefined;
    this.queue = [];
  }

  private submit(request: Request, content: (TextContent | ImageContent)[], deliverAs: "steer" | "followUp"): void {
    const text = content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const generation = this.generation;
    this.humanInput!.send(text, request.sessionId,
      () => this.running && generation === this.generation && !request.controller.signal.aborted &&
        request.sessionId === this.ctx.sessionManager.getSessionId(),
      () => this.pi.sendUserMessage(content, { deliverAs, expandPromptTemplates: false }),
      { images: content.filter(block => block.type === "image"), owner: request, steering: deliverAs === "steer" });
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
    this.botId = undefined;
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
      this.media = new SentMediaRegistry(resolve(this.stateDirectory, "media-index.json"));
      await this.media.load();
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
    this.humanInput?.close();
    this.humanInput = undefined;
    this.media?.clear();
    if (this.worker) clearInterval(this.worker);
    if (this.typing) clearInterval(this.typing);
    this.worker = this.typing = undefined;
    this.queue = [];
    this.active = undefined;
    this.stopTask = (async () => {
      await Promise.allSettled([this.pollTask, this.workTask, this.typingTask, this.sending]);
      await this.ledger.flush(2000);
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
          const me = await this.api.call<TgUser>("getMe", {}, signal);
          this.botId = Number.isSafeInteger(me.id) && me.id > 0 ? me.id : undefined;
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

  private async text(chat: number, text: string, signal?: AbortSignal, context?: DeliveryContext): Promise<void> {
    const combined = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
    await this.serial(() => { combined.throwIfAborted(); return this.api.sendText(chat, text, combined, context); });
  }

  private record(event: DeliveryEvent): void { try { void this.ledger.append(event).catch(() => {}); } catch {} }
  private correlation(reply: Reply, operation: DeliveryContext["operation"], parent?: string): DeliveryContext {
    reply.diagnosticId ||= randomUUID();
    return { reply: reply.diagnosticId, operation, parent, revision: reply.revision || 0, task: reply.taskId };
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
    if (this.active) chats.add(this.active.chat);
    if (!chats.size) return;
    this.typingTask = Promise.all([...chats].map(chat_id => this.api.call("sendChatAction", { chat_id, action: "typing" }, this.controller.signal).catch(() => {})))
      .then(() => {}).finally(() => { this.typingTask = undefined; });
  }

  /** Emits the final timestamp element only on a new session or 30+ minutes after the last emitted one. */
  private shouldStamp(sessionId: string, date: Date): boolean {
    const previous = this.lastStamp;
    if (previous && previous.sessionId === sessionId && date.getTime() - previous.at < STAMP_INTERVAL_MS) return false;
    this.lastStamp = { sessionId, at: date.getTime() };
    return true;
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
      const kind = photo ? "photo" : message.document ? "document" : message.video ? "video" : message.animation ? "animation"
        : message.video_note ? "video_note" : message.voice ? "voice" : "audio";
      await this.indexInbound(message, path, kind);
      const isVideo = Boolean(message.video || message.video_note || message.animation);
      const mime = imageMime(data);
      if (mime && !isVideo) content.push({ type: "image", data: data.toString("base64"), mimeType: mime });
      if (message.voice || message.audio) parts.push(`<transcription>\n${await this.api.transcribe(data, filename, signal)}\n</transcription>`);
    }
    if (paths.length) parts.push(`<attachments>\n${paths.map((path, index) => `${index + 1}. ${path}`).join("\n")}\n</attachments>`);
    const date = new Date(Math.min(...request.messages.map(message => message.date)) * 1000);
    const reference = formatReplyContext(request.messages, this.config, this.botId, await this.replyMedia(request.messages));
    const body = redact(parts.join("\n\n"), this.config);
    // The element is always the final field: after text, transcription and attachment blocks.
    const current = this.shouldStamp(request.sessionId, date) ? stamp(body, date) : body;
    content.unshift({ type: "text", text: reference ? `${reference}\n\n${current}` : current });
    return content;
  }

  /** Best-effort inbound indexing: store the realpath'd copy that was actually written. */
  private async indexInbound(message: TgMessage, path: string, kind: string): Promise<void> {
    try {
      await this.media?.record([{ chat: message.chat.id, message: message.message_id, path: await realpath(path), kind, source: "inbound" }]);
    } catch { /* Indexing never fails an admitted download or transcription. */ }
  }

  /** Replied-to media resolves only when the indexed local copy still exists at exactly that path. */
  private async replyMedia(messages: TgMessage[]): Promise<Map<number, string>> {
    const resolved = new Map<number, string>();
    for (const message of messages) {
      const target = message.reply_to_message;
      const targetId = target && Number.isSafeInteger(target.message_id) && target.message_id > 0 ? target.message_id : undefined;
      if (!target || targetId === undefined || resolved.has(targetId)) continue;
      if (!target.photo?.length && !target.document && !target.video && !target.animation && !target.video_note && !target.voice && !target.audio && !target.sticker) continue;
      const entry = this.media?.lookup(message.chat.id, targetId);
      if (!entry) continue;
      try {
        // realpath also rejects a symlink swap that no longer points at the stored copy.
        if (await realpath(entry.path) === entry.path) resolved.set(targetId, entry.path);
      } catch { /* Missing, unreadable or replaced local copies are omitted. */ }
    }
    return resolved;
  }

  private async steer(request: Request, followUp: QueuedRequest): Promise<void> {
    try {
      followUp.content ||= await this.prepare({ ...followUp, sessionId: request.sessionId, chat: request.chat, controller: request.controller, started: false, outcome: "completed" });
      if (!this.running || request.controller.signal.aborted) return;
      // Downloads/STT may outlive the run. Keep the prepared input for normal dispatch,
      // rather than attaching it to a settled request or downloading it twice.
      if (this.active !== request || request.settling || this.ctx.isIdle()) {
        this.queue.unshift(followUp);
        return;
      }
      this.submit(request, followUp.content, "steer");
    } catch (error) {
      if (this.running) await this.text(followUp.messages[0].chat.id, safeError(error)).catch(() => {});
    }
  }

  private async processQueue(): Promise<void> {
    if (!this.running) return;
    if (this.active) {
      const request = this.active;
      if (!request.started && request.submittedAt && Date.now() - request.submittedAt > 10_000 && this.ctx.isIdle()) {
        this.record({ ...this.correlation(request, "reply"), phase: "suppressed", outcome: "suppressed", reason: "start_watchdog" });
        request.controller.abort(); this.active = undefined; if (this.run === request) this.run = undefined;
        await this.text(request.chat, "Pi did not start this request. Check the TUI for configuration or extension errors.", undefined, this.correlation(request, "warning"));
      } else if (this.connected && request.started && !request.settling && !this.ctx.isIdle()) {
        // Only a message from the request's own chat may steer it.
        const index = this.queue.findIndex(item => item.messages[0].chat.id === request.chat);
        if (index >= 0 && this.queue[index].readyAt <= Date.now()) await this.steer(request, this.queue.splice(index, 1)[0]);
      }
      return;
    }
    // isIdle becomes true before agent_settled observers finish. Wait for our own
    // lifecycle observation as well, so a queued request cannot enter an older run.
    if (!this.connected || this.foregroundRunning || !this.ctx.isIdle() || this.ctx.hasPendingMessages()) return;
    if (!this.queue.length) return;
    if (this.queue[0].readyAt > Date.now()) return;
    const queued = this.queue.shift()!;
    const request: Request = { ...queued, sessionId: this.ctx.sessionManager.getSessionId(), chat: queued.messages[0].chat.id,
      controller: new AbortController(), started: false, outcome: "completed" };
    this.active = request;
    this.run = request;
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
      if (this.active === request) this.active = undefined;
      if (this.run === request) this.run = undefined;
      if (this.running) await this.text(request.chat, safeError(error)).catch(() => {});
    }
  }

  private diagnostic(reply: Reply, phase: "cancelled" | "suppressed" | "send_attempt" | "sent" | "send_failed", reason?: DiagnosticReason): void {
    // Closed metadata only: no chat/session IDs, content, paths, provider errors or credentials.
    reply.diagnosticId ||= randomUUID();
    // Persistent-only: the API records send phases; do not duplicate them or write around Pi's TUI.
    if (phase === "cancelled" || phase === "suppressed") this.record({ ...this.correlation(reply, "reply"), phase, outcome: "suppressed", reason });
  }

  /** Arm only the admitted submission's own pre-normalization lifecycle. */
  beforeStart(prompt: string, images?: ImageContent[]): boolean {
    return Boolean(this.active && this.humanInput?.prepare(prompt, images, this.ctx.sessionManager.getSessionId(), this.active));
  }

  input(event: InputEvent): void {
    if (this.active) this.humanInput?.admit(event, this.ctx.sessionManager.getSessionId(), this.active);
  }

  userStart(message: { role: string; content?: unknown; customType?: string; details?: unknown }): void {
    if (message.role !== "user") return;
    const request = this.active;
    if (!request?.prompt || request.controller.signal.aborted) return;
    const consumed = this.humanInput?.consume(message.content, this.ctx.sessionManager.getSessionId(), request);
    if (!consumed) return;
    this.run = request;
    if (consumed.steering) {
      // A generated final is already user-visible in the TUI. Preserve it for
      // ordered delivery instead of dropping it when the correction steers.
      // Voice trailing text stays suppressed: an explicit voice send is the reply.
      const superseded = request.final?.trim();
      if (superseded && !request.spoke && request.outcome === "completed") {
        (request.pendingFinals ||= []).push({ text: superseded, revision: request.revision || 0 });
      }
      request.revision = (request.revision || 0) + 1;
      request.settling = false;
      // Only a consumed correction supersedes the old final/voice-only state.
      request.final = undefined;
      request.spoke = request.delivered = false;
      request.outcome = "completed";
    }
    request.started = true;
  }

  assistantEnd(message: { role: string; content?: unknown; stopReason?: string }): void {
    const request = this.run;
    if (!request?.started || request.controller.signal.aborted ||
      request.sessionId !== this.ctx.sessionManager.getSessionId() || message.role !== "assistant" || !Array.isArray(message.content)) return;
    if (message.stopReason === "toolUse" || message.content.some(block => block?.type === "toolCall")) {
      request.final = undefined;
      return;
    }
    const successful = ["stop", "length"].includes(message.stopReason || "");
    request.outcome = successful ? "completed" : message.stopReason === "aborted" ? "aborted" : "error";
    request.final = successful ? message.content.filter(block => block?.type === "text").map(block => block.text).join("\n").trim() : undefined;
    this.record({ ...this.correlation(request, "reply"), phase: "generated", outcome: "not_applicable", reason: successful ? undefined : request.outcome === "aborted" ? "agent_aborted" : "agent_error" });
  }

  boundary(outcome: AgentActivityOutcome): void { const request = this.run; if (request?.started) request.outcome = outcome; }

  agentStart(): void {
    this.foregroundRunning = true;
    this.humanInput?.startRun(this.ctx.sessionManager.getSessionId());
    if (this.active) { this.run = this.active; return; }
    if (this.run && !this.run.settling) { this.run.started = true; return; }
    this.run = { sessionId: this.ctx.sessionManager.getSessionId(), chat: this.destination, controller: new AbortController(),
      started: true, outcome: "completed" };
  }

  async settled(): Promise<void> {
    this.foregroundRunning = false;
    const request = this.run;
    if (!request || request.settling) return;
    if (!request.started || request.controller.signal.aborted) {
      if (request.controller.signal.aborted) this.diagnostic(request, "suppressed", request.cancellation || "context_revoked");
      this.clearRun(request);
      return;
    }
    request.settling = true;
    const revision = request.revision;
    const chat = request.chat;
    const delivery = { ...this.correlation(request, "reply"), delivery: randomUUID() };
    this.record({ ...delivery, phase: "settled", outcome: "not_applicable" });
    try {
      if (!this.running) return;
      if (request.sessionId !== this.ctx.sessionManager.getSessionId() || !this.config.allowed.has(String(chat))) {
        this.diagnostic(request, "suppressed", "owner_session_or_allowlist_changed");
        return;
      }
      if (request.outcome !== "completed") {
        // Steered intermediate finals were already user-visible; deliver them
        // in order before reporting the terminal outcome.
        const queued = request.pendingFinals?.splice(0) ?? [];
        request.pendingFinals = [];
        request.final = undefined;
        const finals = queued.filter((item, index) => index === 0 || item.text !== queued[index - 1].text);
        for (const item of finals) {
          await this.text(chat, item.text, request.controller.signal, { ...this.correlation(request, "reply"), revision: item.revision, delivery: randomUUID(), parent: delivery.delivery });
        }
        await this.text(chat, request.outcome === "aborted" ? "Pi request was cancelled." : "Pi could not complete this request. Check the TUI for details.", request.controller.signal, this.correlation(request, "warning", delivery.delivery));
      } else if (request.spoke) {
        // A steered intermediate text final is still user-visible, but trailing
        // text after an explicit voice send stays suppressed.
        const queued = request.pendingFinals?.splice(0) ?? [];
        request.pendingFinals = [];
        request.final = undefined;
        const finals = queued.filter((item, index) => index === 0 || item.text !== queued[index - 1].text);
        for (const item of finals) {
          this.diagnostic(request, "send_attempt");
          await this.text(chat, item.text, request.controller.signal, { ...this.correlation(request, "reply"), revision: item.revision, delivery: randomUUID(), parent: delivery.delivery });
          this.diagnostic(request, "sent");
        }
        // An explicit voice message is the complete reply, even if the model says 'Sent' afterward.
        this.record({ ...delivery, phase: "suppressed", outcome: "suppressed", reason: "voice_only" });
        return;
      } else {
        // Move already-generated finals to local state before any await, so a
        // correction steering mid-send cannot re-queue the final being sent.
        const queued = request.pendingFinals?.splice(0) ?? [];
        request.pendingFinals = [];
        const currentText = request.final?.trim();
        const currentRevision = request.revision || 0;
        request.final = undefined;
        const ordered = [...queued];
        if (currentText) ordered.push({ text: currentText, revision: currentRevision });
        // True retries/continuations repeat content; send repeated text once.
        const finals = ordered.filter((item, index) => index === 0 || item.text !== ordered[index - 1].text);
        if (!finals.length) {
          this.record({ ...delivery, phase: "suppressed", outcome: "suppressed", reason: "empty_final" });
        } else if (finals.length === 1 && !queued.length) {
          // Input format does not opt the user into speech. Only explicit tool sends produce voice.
          this.diagnostic(request, "send_attempt");
          await this.text(chat, finals[0].text, request.controller.signal, delivery);
          this.diagnostic(request, "sent");
        } else for (const item of finals) {
          // Steered intermediate finals keep their own revision and delivery
          // identity under the same reply, parented to this settlement.
          this.diagnostic(request, "send_attempt");
          await this.text(chat, item.text, request.controller.signal, { ...this.correlation(request, "reply"), revision: item.revision, delivery: randomUUID(), parent: delivery.delivery });
          this.diagnostic(request, "sent");
        }
      }
      // A successful empty final or attachment-only reply intentionally sends no chat.
    } catch (error) {
      this.diagnostic(request, "send_failed", request.controller.signal.aborted ? "context_revoked" : "outcome_unknown");
      if (this.running && !request.controller.signal.aborted) {
        await this.text(chat, safeError(error), request.controller.signal, this.correlation(request, "warning", delivery.delivery)).catch(() => {});
        if (this.ctx.hasUI) this.ctx.ui.notify(safeError(error), "warning");
      }
    } finally {
      this.clearRun(request);
      void revision;
    }
  }

  private clearRun(request: Reply): void {
    if (this.run === request) this.run = undefined;
    if (this.active === request) {
      if (this.running && this.humanInput?.hasPending(request)) {
        // A slow input hook can finish after settlement and start a new run.
        // Retain the reply owner until that already-submitted input is consumed.
        request.started = false;
        request.settling = false;
        request.submittedAt = Date.now();
        request.final = undefined;
      } else this.active = undefined;
    }
  }

  private assertDelivery(request: Reply | undefined, signal?: AbortSignal): asserts request is Reply {
    const refuse = (code: DeliveryRefusalCode): never => {
      if (request) this.record({ ...this.correlation(request, "attachment"), phase: "suppressed", outcome: "suppressed", reason: "local_refusal" });
      throw new DeliveryRefusal(code, {
      running: this.running, connected: this.connected, context: !request ? "none" : "request",
      started: Boolean(request?.started), settling: Boolean(request?.settling), cancelled: Boolean(request?.controller.signal.aborted),
      owned: Boolean(request && request === this.run),
    }); };
    if (!this.running) refuse("TG_BRIDGE_STOPPED");
    if (!this.connected) refuse("TG_BRIDGE_DISCONNECTED");
    if (!request) return refuse("TG_NO_CONTEXT");
    if (request.controller.signal.aborted) refuse("TG_CONTEXT_CANCELLED");
    if (this.run !== request) refuse("TG_CONTEXT_REPLACED");
    if (!request.started) refuse("TG_CONTEXT_NOT_STARTED");
    if (request.settling) refuse("TG_CONTEXT_SETTLING");
    if (request.sessionId !== this.ctx.sessionManager.getSessionId()) refuse("TG_SESSION_CHANGED");
    if (!this.config.allowed.has(String(request.chat))) refuse("TG_RECIPIENT_NOT_ALLOWED");
    if (signal?.aborted) refuse("TG_CALL_CANCELLED");
  }

  /** Best-effort outbound indexing of the acknowledged message id per sent file. */
  private async indexOutbound(chat: number, files: OutgoingFile[], sent: unknown): Promise<void> {
    try {
      if (!Array.isArray(sent)) return;
      const entries = files.flatMap((file, index): SentMediaRecord[] => {
        const messageId = (sent[index] as TgMessage | undefined)?.message_id;
        if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0) return [];
        return [{ chat, message: messageId, path: file.path, kind: file.kind, source: "outbound" }];
      });
      if (entries.length) await this.media?.record(entries);
    } catch { /* A malformed transport result or an index failure never changes send semantics. */ }
  }

  async send(params: SendParams, signal?: AbortSignal): Promise<void> {
    const request = this.run;
    this.assertDelivery(request, signal);
    const modes = [Boolean(params.path), params.paths !== undefined, Boolean(params.speech)].filter(Boolean).length;
    if (modes !== 1) throw new SafeError("Provide exactly one of path, paths or speech.");
    if (params.paths && (params.paths.length < 1 || params.paths.length > 10)) throw new SafeError("Provide 1–10 attachment paths.");
    const signals = [this.controller.signal, request.controller.signal];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);
    const beforeUpload = () => this.assertDelivery(request, signal);
    const context = this.correlation(request, params.speech || params.kind === "voice" ? "voice" : "attachment");
    await this.serial(async () => {
      beforeUpload();
      if (params.speech) {
        await this.api.speak(request.chat, params.speech, combined, beforeUpload, context);
        request.spoke = request.delivered = true;
      } else {
        const files = await Promise.all((params.paths || [params.path!]).map(path => outboundFile(this.ctx.cwd, path, params.kind, this.config.dataDir, combined)));
        beforeUpload();
        const chat = request.chat;
        const sent = await this.api.sendGroup(chat, files, combined, beforeUpload, { ...context, operation: files.some(file => file.kind === "voice") ? "voice" : "attachment" });
        await this.indexOutbound(chat, files, sent);
        request.delivered = true;
        if (files.some(file => file.kind === "voice")) request.spoke = true;
      }
    });
  }
}
