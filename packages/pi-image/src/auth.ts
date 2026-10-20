import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SafeError } from "./errors.ts";

export const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images/generations";

/** Default model; override per call with any pattern-validated OpenRouter image model id. */
export const DEFAULT_MODEL = "openai/gpt-image-2.5-sunburst";

const MISSING_KEY =
  "OpenRouter key is missing (set OPENROUTER_API_KEY in .env or run /login for openrouter); image generation is unavailable.";

/** Resolve the agent directory the same way sibling extensions do. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi", "agent");
}

/**
 * Parse a minimal .env file: `KEY=VALUE` lines with optional `export`, blank lines,
 * `#` comments, and single- or double-quoted values. No expansion or escape handling.
 */
export function parseDotEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

/** Read OPENROUTER_API_KEY from `<dir>/.env`; a missing or unreadable file is not an error. */
async function readEnvFileKey(dir: string): Promise<string | undefined> {
  try {
    const key = parseDotEnv(await readFile(resolve(dir, ".env"), "utf8"))["OPENROUTER_API_KEY"]?.trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the OpenRouter API key: `OPENROUTER_API_KEY` in `<cwd>/.env`, then the agent
 * directory `.env`, then the process environment, then the Pi `/login` credential in
 * `<agent-dir>/auth.json`. Missing credentials fail closed with a safe error.
 */
export async function readOpenRouterKey(
  dir: string = agentDir(),
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  for (const candidate of new Set([cwd, dir])) {
    const key = await readEnvFileKey(candidate);
    if (key) return key;
  }
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  let data: unknown;
  try {
    data = JSON.parse(await readFile(resolve(dir, "auth.json"), "utf8"));
  } catch {
    throw new SafeError(MISSING_KEY);
  }
  const entry = (data as Record<string, unknown>)?.["openrouter"];
  const key = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["key"] : undefined;
  if (typeof key !== "string" || !key.trim()) throw new SafeError(MISSING_KEY);
  return key.trim();
}
