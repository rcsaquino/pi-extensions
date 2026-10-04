import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export class SafeError extends Error {}

export type DeliveryRefusalCode = "TG_BRIDGE_STOPPED" | "TG_BRIDGE_DISCONNECTED" | "TG_NO_CONTEXT" | "TG_CONTEXT_NOT_STARTED" |
  "TG_CONTEXT_SETTLING" | "TG_CONTEXT_CANCELLED" | "TG_CONTEXT_NOT_OWNER" | "TG_CONTEXT_REPLACED" |
  "TG_SESSION_CHANGED" | "TG_RECIPIENT_NOT_ALLOWED" | "TG_CALL_CANCELLED";
export interface DeliveryState {
  running: boolean; connected: boolean; context: "none" | "request" | "report";
  started: boolean; settling: boolean; cancelled: boolean; owned: boolean;
}
const refusalReasons: Record<DeliveryRefusalCode, string> = {
  TG_BRIDGE_STOPPED: "bridge is not running",
  TG_BRIDGE_DISCONNECTED: "bridge is disconnected",
  TG_NO_CONTEXT: "no authenticated request or dispatch-linked report is active",
  TG_CONTEXT_NOT_STARTED: "delivery context is queued but has not started",
  TG_CONTEXT_SETTLING: "delivery context is settling",
  TG_CONTEXT_CANCELLED: "delivery context was cancelled or revoked",
  TG_CONTEXT_NOT_OWNER: "delivery context does not own the foreground turn",
  TG_CONTEXT_REPLACED: "captured delivery context is no longer current",
  TG_SESSION_CHANGED: "delivery context belongs to a different session",
  TG_RECIPIENT_NOT_ALLOWED: "captured recipient is no longer allowed",
  TG_CALL_CANCELLED: "tool call was cancelled",
};
/** Closed, state-only diagnostics: never recipient IDs, content, paths, or raw exceptions. */
export class DeliveryRefusal extends SafeError {
  constructor(readonly code: DeliveryRefusalCode, readonly state: DeliveryState) {
    super(`telegram_send refused locally [${code}]: ${refusalReasons[code]}. No upload initiated by this refusal. ` +
      `State: running=${state.running}, connected=${state.connected}, context=${state.context}, started=${state.started}, ` +
      `settling=${state.settling}, cancelled=${state.cancelled}, owned=${state.owned}.`);
  }
}

export type TransportFailureCode = "TG_TRANSPORT_CANCELLED" | "TG_TRANSPORT_TIMEOUT" | "TG_TRANSPORT_FAILED" | "TG_TRANSPORT_RESPONSE";
export class TransportFailure extends SafeError {
  constructor(readonly code: TransportFailureCode, readonly deliveryOutcome: "unknown" | "not_applicable") {
    const reason = code === "TG_TRANSPORT_CANCELLED" ? "request was cancelled" : code === "TG_TRANSPORT_TIMEOUT" ? "request deadline elapsed"
      : code === "TG_TRANSPORT_RESPONSE" ? "response could not be confirmed" : "network request failed (cause unverified)";
    super(`Telegram transport [${code}]: ${reason}.` + (deliveryOutcome === "unknown"
      ? " Delivery outcome unknown; do not automatically retry." : ""));
  }
}
export function safeError(error: unknown): string {
  return error instanceof SafeError ? error.message : "Telegram operation failed. Check local configuration and connectivity.";
}

export interface Config {
  token: string;
  allowed: Set<string>;
  groqKey?: string;
  elevenKey?: string;
  voiceId?: string;
  modelId?: string;
  dataDir: string;
  /** Persistent polling state, separate from disposable downloaded files. */
  stateDir?: string;
  tmpDir?: string;
  /** Shared by all Pi instances using this agent directory, regardless of cwd. */
  lockDir?: string;
}

export function parseAllowed(value: string): Set<string> {
  let ids: unknown[];
  try {
    ids = value.trim().startsWith("[") ? JSON.parse(value) : value.trim().split(/[\s,;]+/);
  } catch {
    throw new SafeError("TELEGRAM_ALLOWED_ID must contain numeric user IDs.");
  }
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id)))) {
    throw new SafeError("TELEGRAM_ALLOWED_ID must contain positive numeric user IDs; access is denied by default.");
  }
  return new Set(ids.map(String));
}

export async function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  // Read only known fields. Never inject .env contents into Pi's process or model context.
  const agentDir = env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi", "agent");
  const home = resolve(agentDir, "pi-telegram");
  // The dedicated home contains generated/runtime data, not source or configuration.
  const paths = env.TELEGRAM_ENV_FILE ? [resolve(cwd, env.TELEGRAM_ENV_FILE)] : [resolve(cwd, ".env"), resolve(agentDir, ".env")];
  let file: Record<string, string | undefined> = {};
  for (const path of [...new Set(paths)]) {
    try {
      file = parseEnv(await readFile(path, "utf8"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SafeError("Unable to read Telegram .env configuration.");
      if (env.TELEGRAM_ENV_FILE) throw new SafeError("TELEGRAM_ENV_FILE does not exist.");
    }
  }
  // Explicit .env values beat stale inherited credentials, including explicitly empty values.
  const get = (key: string) => (file[key] ?? env[key])?.trim() || undefined;
  const token = get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new SafeError("TELEGRAM_BOT_TOKEN is missing; Telegram is disconnected.");
  return {
    token,
    allowed: parseAllowed(get("TELEGRAM_ALLOWED_ID") || ""),
    groqKey: get("GROQ_API_KEY"),
    elevenKey: get("ELEVENLABS_API_KEY"),
    voiceId: get("ELEVENLABS_VOICE_ID"),
    modelId: get("ELEVENLABS_MODEL_ID"),
    dataDir: resolve(home, "downloads"),
    stateDir: resolve(home, "state"),
    tmpDir: resolve(home, "tmp"),
    lockDir: resolve(home, "locks"),
  };
}

export function redact(text: string, config: Config): string {
  for (const secret of [config.token, config.groqKey, config.elevenKey]) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

/** Telegram's original instant, represented in the host's timezone with an explicit ISO offset. */
export function stamp(text: string, date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const iso = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `[${iso}] ${text}`;
}

// Telegram limits are UTF-16 based. Avoid splitting a surrogate pair; prefer word boundaries.
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  while (text.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const space = Math.max(text.lastIndexOf("\n", end - 1), text.lastIndexOf(" ", end - 1));
    if (space > end / 2) end = space + 1;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}
