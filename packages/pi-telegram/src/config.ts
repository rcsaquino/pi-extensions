import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export class SafeError extends Error {}
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
