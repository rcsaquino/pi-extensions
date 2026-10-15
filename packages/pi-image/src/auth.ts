import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SafeError } from "./errors.ts";

export const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images/generations";

/** Default model; override per call with any pattern-validated OpenRouter image model id. */
export const DEFAULT_MODEL = "openai/gpt-image-2.5-sunburst";

/** Resolve the agent directory the same way sibling extensions do. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi", "agent");
}

/**
 * Read the OpenRouter API key stored via Pi /login (<agent-dir>/auth.json).
 * No new keys, no environment fallback: a missing login fails closed with a safe error.
 */
export async function readOpenRouterKey(dir: string = agentDir()): Promise<string> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(resolve(dir, "auth.json"), "utf8"));
  } catch {
    throw new SafeError("OpenRouter login is missing (run /login for openrouter); image generation is unavailable.");
  }
  const entry = (data as Record<string, unknown>)?.["openrouter"];
  const key = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["key"] : undefined;
  if (typeof key !== "string" || !key.trim()) {
    throw new SafeError("OpenRouter login is missing (run /login for openrouter); image generation is unavailable.");
  }
  return key.trim();
}
