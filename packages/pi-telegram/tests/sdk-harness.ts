import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export const workspace = process.env.TELEGRAM_TEST_DIR || resolve(process.env.TMPDIR || "/tmp", "pi-telegram-tests");

export async function until(predicate: () => boolean, label = "SDK acceptance timeout", timeout = 5000, interval = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(label);
    await delay(interval);
  }
}

/** Isolated SDK root with a private agent directory and the offline environment applied. */
export async function sdkRoot(prefix: string, env?: string) {
  await mkdir(workspace, { recursive: true });
  const root = await mkdtemp(resolve(workspace, prefix));
  const agentDir = resolve(root, "agent");
  await mkdir(agentDir);
  if (env) await writeFile(resolve(root, ".env"), env, { mode: 0o600 });
  const previous = {
    PI_OFFLINE: process.env.PI_OFFLINE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TELEGRAM_ENV_FILE: process.env.TELEGRAM_ENV_FILE,
  };
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.TELEGRAM_ENV_FILE;
  const originalFetch = globalThis.fetch;
  const cleanup = async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  };
  return { root, agentDir, cleanup };
}
