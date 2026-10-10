import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DeliveryLedger, methods, transportCause, type DeliveryContext, type DeliveryEvent } from "./delivery-ledger.ts";
import { readAttachment } from "./attachment.ts";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Config, SafeError, TransportFailure, redact } from "./config.ts";
import { formattedChunks, telegramFormat } from "./format.ts";
import { isOpus, joinSpeech, speechChunks } from "./voice.ts";

export const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const UPLOAD_LIMIT = 50 * 1024 * 1024;
export type MediaKind = "document" | "photo" | "video" | "voice";
export type Fetch = typeof globalThis.fetch;

export interface TgFile {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
}
export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
export interface TgChat { id: number; type: string }
/** Only fields used by this bridge; see https://core.telegram.org/bots/api#textquote. */
export interface TgQuote { text: string; position: number; is_manual?: boolean }
/** Deliberately no external content projection: it is outside this private-chat boundary. */
export interface TgExternalReply { origin: unknown; chat?: TgChat; message_id?: number }
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;
  business_connection_id?: string;
  guest_query_id?: string;
  reply_to_message?: TgMessage;
  external_reply?: TgExternalReply;
  quote?: TgQuote;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TgFile[];
  document?: TgFile;
  video?: TgFile;
  animation?: TgFile;
  video_note?: TgFile;
  voice?: TgFile;
  audio?: TgFile;
  sticker?: TgFile;
}
export interface TgUpdate { update_id: number; message?: TgMessage }

export class ApiError extends SafeError {
  constructor(public code: number, public retryAfter = 0) {
    super(code === 409 ? "Telegram polling conflict or webhook is active. Stop the other bridge before connecting."
      : code === 401 ? "Telegram authentication failed. Check TELEGRAM_BOT_TOKEN."
      : code === 403 ? "Telegram access was denied. The bot may have been blocked."
      : `Telegram API request failed (code ${code}).`);
  }
}

export async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new SafeError("File exceeds the supported size limit.");
  }
  if (!response.body) throw new SafeError("Empty response body.");
  const reader = response.body.getReader();
  const buffers: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new SafeError("File exceeds the supported size limit.");
      buffers.push(Buffer.from(value));
    }
    return Buffer.concat(buffers);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function imageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) return "image/gif";
}

export function safeFilename(name: string): string {
  return basename(name.replaceAll("\\", "/")).replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "_").slice(0, 120) || "attachment.bin";
}

export class TelegramApi {
  constructor(readonly config: Config, private fetcher: Fetch = globalThis.fetch, private ledger?: DeliveryLedger) {}

  private observe(event: DeliveryEvent): void {
    // Do not yield to filesystem I/O inside the reply/report ownership lifecycle.
    try { void this.ledger?.append(event).catch(() => {}); } catch {}
  }
  private context(context?: DeliveryContext): DeliveryContext { return { operation: "service", ...context, delivery: context?.delivery || randomUUID() }; }
  private failure(error: unknown, outgoing: boolean): Pick<DeliveryEvent, "outcome" | "code" | "cause" | "reason"> {
    try {
      if (error instanceof TransportFailure) return { outcome: error.deliveryOutcome, code: error.code, cause: error.causeCode };
      if (error instanceof ApiError) return { outcome: outgoing ? "rejected" : "not_applicable" };
    } catch { /* A hostile local refusal/observer must not replace the original thrown value. */ }
    return { outcome: outgoing ? "suppressed" : "not_applicable", reason: "local_failure" };
  }
  private async delivery(context: DeliveryContext, run: () => Promise<void>): Promise<void> {
    this.observe({ ...context, phase: "send_attempt", outcome: "pending" });
    try {
      await run();
      this.observe({ ...context, phase: "sent", outcome: "acknowledged" });
    } catch (error) {
      this.observe({ ...context, phase: "send_failed", ...this.failure(error, true) });
      throw error;
    }
  }

  private async request(url: string, init: RequestInit, signal: AbortSignal, timeout: number, outgoing = false, operation?: "download" | "transcribe" | "generateSpeech"): Promise<Response> {
    const deadline = AbortSignal.timeout(timeout);
    try {
      // An already-aborted request must settle safely without relying on a fetch listener.
      signal.throwIfAborted();
      return await this.fetcher(url, {
        ...init, redirect: "error", signal: AbortSignal.any([signal, deadline]),
      });
    } catch (error) {
      // Observed signals establish cancellation/deadline. Only allowlisted own cause codes survive.
      const failure = new TransportFailure(signal.aborted ? "TG_TRANSPORT_CANCELLED" : deadline.aborted ? "TG_TRANSPORT_TIMEOUT" : "TG_TRANSPORT_FAILED",
        outgoing ? "unknown" : "not_applicable", transportCause(error));
      if (operation) this.observe({ operation: operation === "generateSpeech" ? "service" : "incoming", method: operation, phase: "api_failed",
        outcome: "not_applicable", code: failure.code, cause: failure.causeCode });
      throw failure;
    }
  }

  async call<T>(method: string, args: Record<string, unknown> | FormData, signal: AbortSignal, timeout = 45_000, beforeUpload?: () => void,
    context?: DeliveryContext, chunk?: number, chunks?: number, album?: number): Promise<T> {
    const outgoing = ["sendMessage", "sendDocument", "sendPhoto", "sendVideo", "sendVoice", "sendMediaGroup"].includes(method);
    const base = { ...(outgoing ? this.context(context) : { operation: "incoming" as const }), method: methods.includes(method as typeof methods[number]) ? method as typeof methods[number] : "other" as const,
      chunk, chunks, album };
    for (let attempt = 0; ; attempt++) {
      let rejected = false;
      try {
        beforeUpload?.(); // Revalidate again after an explicit 429 rejection/backoff, before any next upload.
        if (outgoing) this.observe({ ...base, phase: "api_attempt", outcome: "pending", attempt: attempt + 1 });
        const response = await this.request(`https://api.telegram.org/bot${this.config.token}/${method}`, {
          method: "POST",
          ...(args instanceof FormData ? { body: args } : { headers: { "content-type": "application/json" }, body: JSON.stringify(args) }),
        }, signal, timeout, outgoing);
        let body: { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } };
        try {
          body = JSON.parse((await readLimited(response, 2 * 1024 * 1024)).toString());
          if (!body || typeof body !== "object" || typeof body.ok !== "boolean" || (outgoing && body.ok && body.result == null)) throw new SafeError("Invalid Telegram API response.");
        } catch (error) {
          if (outgoing) throw new TransportFailure("TG_TRANSPORT_RESPONSE", "unknown", transportCause(error));
          if (error instanceof SafeError) throw error;
          throw new SafeError("Invalid Telegram API response.");
        }
        if (response.ok && body.ok) {
          if (outgoing) this.observe({ ...base, phase: "api_ack", outcome: "acknowledged", attempt: attempt + 1 });
          return body.result as T;
        }
        const apiCode = typeof body.error_code === "number" && Number.isSafeInteger(body.error_code) && body.error_code >= 100 && body.error_code <= 599 ? body.error_code : response.status;
        const backoff = body.parameters?.retry_after;
        const error = new ApiError(apiCode, typeof backoff === "number" && Number.isFinite(backoff) && backoff > 0 ? Math.min(backoff, 60) : 1);
        rejected = true;
        this.observe({ ...base, phase: "api_rejected", outcome: outgoing ? "rejected" : "not_applicable", attempt: attempt + 1,
          rejection: error.code === 429 ? "rate_limit" : error.code === 401 ? "authentication" : error.code === 403 ? "access" : error.code === 409 ? "conflict" : "other" });
        // Only retry explicitly rejected 429s, never ambiguous network failures on sends.
        if (error.code !== 429 || attempt >= 2) throw error;
        await delay(error.retryAfter * 1000, undefined, { signal });
      } catch (error) {
        if (!rejected) this.observe({ ...base, phase: "api_failed", attempt: attempt + 1, ...this.failure(error, outgoing) });
        throw error;
      }
    }
  }

  async sendText(chat: number, text: string, signal: AbortSignal, context?: DeliveryContext): Promise<void> {
    const parts = formattedChunks(telegramFormat(redact(text, this.config))), delivery = this.context(context);
    if (!parts.length) { this.observe({ ...delivery, phase: "suppressed", outcome: "suppressed", reason: "empty_final" }); return; }
    await this.delivery(delivery, async () => {
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        await this.call("sendMessage", { chat_id: chat, text: part.text, ...(part.entities.length ? { entities: part.entities } : {}) }, signal, 45_000, undefined, delivery, index + 1, parts.length);
      }
    });
  }

  private validateMedia(kind: MediaKind, data: Buffer): void {
    const limit = kind === "photo" ? 10 * 1024 * 1024 : UPLOAD_LIMIT;
    if (!data.length || data.length > limit) throw new SafeError(`Invalid or oversized ${kind}; use a document for images over 10 MB.`);
    for (const secret of [this.config.token, this.config.groqKey, this.config.elevenKey]) {
      if (secret && data.includes(Buffer.from(secret))) throw new SafeError("Refusing to send a file containing configured credentials.");
    }
  }

  private mediaBlob(kind: MediaKind, data: Buffer, filename: string): Blob {
    const mime = kind === "photo" ? imageMime(data) || "image/jpeg"
      : kind === "video" ? "video/mp4"
      : kind === "voice" ? extname(filename).toLowerCase() === ".mp3" ? "audio/mpeg" : extname(filename).toLowerCase() === ".m4a" ? "audio/mp4" : "audio/ogg"
      : "application/octet-stream";
    return new Blob([new Uint8Array(data)], { type: mime });
  }

  async sendMedia(chat: number, kind: MediaKind, data: Buffer, filename: string, signal: AbortSignal, beforeUpload?: () => void, context?: DeliveryContext): Promise<void> {
    this.validateMedia(kind, data);
    const form = new FormData();
    form.set("chat_id", String(chat));
    form.set(kind, this.mediaBlob(kind, data, filename), safeFilename(filename));
    if (kind === "video") form.set("supports_streaming", "true");
    const delivery = this.context(context);
    await this.delivery(delivery, () => this.call<void>(`send${kind[0].toUpperCase()}${kind.slice(1)}`, form, signal, 120_000, beforeUpload, delivery));
  }

  /** A single Telegram album, not a series of independent sendPhoto/sendDocument calls. */
  async sendGroup(chat: number, files: OutgoingFile[], signal: AbortSignal, beforeUpload?: () => void, context?: DeliveryContext): Promise<void> {
    if (files.length === 1) return this.sendMedia(chat, files[0].kind, files[0].data, files[0].filename, signal, beforeUpload, context);
    if (files.length < 2 || files.length > 10) throw new SafeError("Telegram albums require 2–10 attachments.");
    if (files.some(file => file.kind === "voice")) throw new SafeError("Telegram cannot group voice notes into an album; send one voice note separately.");
    if (files.some(file => file.kind === "document") && !files.every(file => file.kind === "document")) {
      throw new SafeError("Telegram cannot mix documents with photos/videos in one album. Use kind: document for all files.");
    }
    for (const file of files) this.validateMedia(file.kind, file.data);
    const form = new FormData();
    form.set("chat_id", String(chat));
    form.set("media", JSON.stringify(files.map((file, index) => ({ type: file.kind, media: `attach://file${index}` }))));
    files.forEach((file, index) => form.set(`file${index}`, this.mediaBlob(file.kind, file.data, file.filename), safeFilename(file.filename)));
    const delivery = this.context(context);
    await this.delivery(delivery, () => this.call<void>("sendMediaGroup", form, signal, 120_000, beforeUpload, delivery, undefined, undefined, files.length));
  }

  /** Remove the bot's advertised slash-command menu; there are no extension command handlers. */
  async clearCommands(signal: AbortSignal): Promise<void> {
    const scopes = [{ type: "default" }, { type: "all_private_chats" }, ...[...this.config.allowed].map(id => ({ type: "chat", chat_id: Number(id) }))];
    for (const scope of scopes) await this.call("deleteMyCommands", { scope }, signal);
  }

  async download(file: TgFile, signal: AbortSignal): Promise<{ data: Buffer; filename: string }> {
    if ((file.file_size || 0) > DOWNLOAD_LIMIT) throw new SafeError("Telegram downloads are limited to 20 MB.");
    const info = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: file.file_id }, signal);
    if (!info.file_path || (info.file_size || 0) > DOWNLOAD_LIMIT) throw new SafeError("Telegram file is unavailable or exceeds 20 MB.");
    // Paths come from Telegram, not message-supplied URLs. Never follow redirects or include URLs in errors.
    const path = info.file_path.split("/").map(encodeURIComponent).join("/");
    const response = await this.request(`https://api.telegram.org/file/bot${this.config.token}/${path}`, {}, signal, 120_000, false, "download");
    if (!response.ok) throw new SafeError("Telegram download failed.");
    return { data: await readLimited(response, DOWNLOAD_LIMIT), filename: safeFilename(file.file_name || info.file_path) };
  }

  async transcribe(data: Buffer, filename: string, signal: AbortSignal): Promise<string> {
    if (!this.config.groqKey) throw new SafeError("GROQ_API_KEY is missing; voice transcription is unavailable.");
    const upload = audioUpload(data, filename);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(data)], { type: upload.mime }), upload.filename);
    form.set("model", "whisper-large-v3-turbo");
    form.set("response_format", "json");
    const response = await this.request("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", headers: { authorization: `Bearer ${this.config.groqKey}` }, body: form,
    }, signal, 120_000, false, "transcribe");
    if (!response.ok) { await response.body?.cancel(); throw new SafeError(`Groq transcription failed (HTTP ${response.status}).`); }
    try {
      const result = JSON.parse((await readLimited(response, 1024 * 1024)).toString());
      if (typeof result.text !== "string" || !result.text.trim()) throw new Error();
      return redact(result.text.trim(), this.config);
    } catch {
      throw new SafeError("Voice transcription returned no usable text.");
    }
  }

  async generateSpeech(text: string, signal: AbortSignal): Promise<Buffer> {
    const { elevenKey, voiceId, modelId } = this.config;
    if (!elevenKey || !voiceId || !modelId) throw new SafeError("ElevenLabs API key, voice ID and model ID are required for voice replies.");
    const chunks = speechChunks(redact(text, this.config), modelId);
    const parts: Buffer[] = [];
    let total = 0;
    for (const part of chunks) {
      const response = await this.request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=opus_48000_64`, {
        method: "POST", headers: { "xi-api-key": elevenKey, "content-type": "application/json", accept: "audio/ogg" },
        body: JSON.stringify({ text: part, model_id: modelId }),
      }, signal, 120_000, false, "generateSpeech");
      if (!response.ok) { await response.body?.cancel(); throw new SafeError(`ElevenLabs speech generation failed (HTTP ${response.status}); configured model was not changed.`); }
      const data = await readLimited(response, UPLOAD_LIMIT);
      if (!isOpus(data)) throw new SafeError("ElevenLabs did not return OGG/Opus audio; no format or model fallback was attempted.");
      total += data.length;
      if (total > UPLOAD_LIMIT) throw new SafeError("Generated speech exceeds Telegram's 50 MB voice limit.");
      parts.push(data);
    }
    return joinSpeech(parts, this.config.tmpDir || resolve(this.config.dataDir, "tmp"), signal);
  }

  async speak(chat: number, text: string, signal: AbortSignal, beforeUpload?: () => void, context?: DeliveryContext): Promise<void> {
    const data = await this.generateSpeech(text, signal);
    beforeUpload?.();
    await this.sendMedia(chat, "voice", data, "reply.ogg", signal, beforeUpload, context);
  }
}

export interface OutgoingFile { data: Buffer; filename: string; kind: MediaKind }

/** Normalize Telegram's .oga/.opus naming without altering the supported OGG bytes. */
export function audioUpload(data: Buffer, filename: string): { filename: string; mime: string } {
  let extension = extname(filename).toLowerCase().slice(1);
  if (data.subarray(0, 4).toString() === "OggS" || ["oga", "opus"].includes(extension)) extension = "ogg";
  else if (data.subarray(0, 4).toString() === "fLaC") extension = "flac";
  else if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WAVE") extension = "wav";
  else if (data.subarray(4, 8).toString() === "ftyp") extension = "mp4";
  else if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) extension = "webm";
  else if (data.subarray(0, 3).toString() === "ID3") extension = "mp3";
  const mimes: Record<string, string> = { flac: "audio/flac", mp3: "audio/mpeg", mp4: "audio/mp4", mpeg: "audio/mpeg", mpga: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", webm: "audio/webm" };
  if (!data.length || !mimes[extension]) throw new SafeError("Unsupported or empty transcription audio. Use OGG, WAV, FLAC, MP3, MP4, M4A or WebM.");
  return { filename: `${safeFilename(basename(filename, extname(filename)))}.${extension}`, mime: mimes[extension] };
}

export async function outboundFile(cwd: string, path: string, kind?: MediaKind, downloads?: string, signal?: AbortSignal): Promise<OutgoingFile> {
  signal?.throwIfAborted();
  const root = await realpath(cwd);
  const resolved = await realpath(resolve(root, path));
  const roots = [root];
  if (downloads) roots.push(await realpath(downloads));
  const accepted = roots.find(candidate => { const rel = relative(candidate, resolved); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); });
  if (!accepted) throw new SafeError("Outgoing files must be inside Pi's working directory or Telegram's downloads directory (including symlink targets).");
  const rel = relative(accepted, resolved);
  if (rel.split(/[\\/]/).some(part => /^(\.env(?:\..*)?|\.ssh|\.gnupg|auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part))) {
    throw new SafeError("Refusing to send a credential or secret file.");
  }
  const data = await readAttachment(resolved, UPLOAD_LIMIT, signal);
  const extension = extname(resolved).toLowerCase();
  kind ??= [".jpg", ".jpeg", ".png"].includes(extension) && data.length <= 10 * 1024 * 1024 ? "photo"
    : extension === ".mp4" ? "video" : [".ogg", ".opus"].includes(extension) ? "voice" : "document";
  return { data, filename: basename(resolved), kind };
}
