import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RunStatus = "running" | "done" | "failed" | "killed" | "unknown";

export interface RunMeta {
  id: string;
  title: string;
  parentSessionId: string;
  childSessionId: string;
  pid: number;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  exitCode?: number | null;
  notified?: boolean;
  note?: string;
  /** Caller's expected runtime; a reminder arrives when the run passes it. */
  etaMinutes?: number;
  /** When the current ETA window started; defaults to startedAt. */
  etaFrom?: string;
  /** Overrun reminders already sent for the current ETA window. */
  reminders?: number;
  lastReminderAt?: string;
  /** Set when a reminder went out and no revised ETA has been recorded since. */
  etaPending?: string;
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Locate every forked session file once; keys are child session ids. */
export async function sessionFiles(): Promise<Map<string, string>> {
  const root = join(agentDir(), "sessions");
  const index = new Map<string, string>();
  if (!existsSync(root)) return index;
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return index;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    let files;
    try {
      files = await readdir(dir, { withFileTypes: true });
    } catch {
      // A removed or unreadable project must not hide every other run.
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const stem = file.name.slice(0, -".jsonl".length);
      const separator = stem.indexOf("_");
      if (separator > 0 && separator < stem.length - 1) index.set(stem.slice(separator + 1), join(dir, file.name));
    }
  }
  return index;
}

export function runsRoot(): string {
  return join(agentDir(), "background");
}

export function sessionRoot(parentSessionId: string): string {
  return join(runsRoot(), parentSessionId);
}

export function runDir(parentSessionId: string, id: string): string {
  return join(sessionRoot(parentSessionId), id);
}

export function reportPath(parentSessionId: string, id: string): string {
  return join(runDir(parentSessionId, id), "report.md");
}

export function stderrPath(parentSessionId: string, id: string): string {
  return join(runDir(parentSessionId, id), "stderr.log");
}

export function taskPath(parentSessionId: string, id: string): string {
  return join(runDir(parentSessionId, id), "task.md");
}

export function metaPath(parentSessionId: string, id: string): string {
  return join(runDir(parentSessionId, id), "meta.json");
}

/** Written before an explicit kill signal so a racing watcher still settles silently. */
export function killIntentPath(parentSessionId: string, id: string): string {
  return join(runDir(parentSessionId, id), "kill.intent");
}

export async function prepareRun(meta: RunMeta): Promise<void> {
  await mkdir(runDir(meta.parentSessionId, meta.id), { recursive: true, mode: 0o700 });
  await writeMeta(meta);
}

export async function writeMeta(meta: RunMeta): Promise<void> {
  const target = metaPath(meta.parentSessionId, meta.id);
  // A per-process temp name collides under parallel tool calls; every write needs its own file.
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function readMeta(parentSessionId: string, id: string): Promise<RunMeta | undefined> {
  // Caller-supplied ids are joined into paths; only run dir names may pass.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || id === "." || id === "..") return undefined;
  try {
    const raw = await readFile(metaPath(parentSessionId, id), "utf8");
    const parsed = JSON.parse(raw) as RunMeta;
    return parsed && typeof parsed.id === "string" && parsed.id === id ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Exit code and kill note decide the settled status in one place. */
export function settleMeta(meta: RunMeta, exitCode: number | null, note?: string, now = new Date().toISOString()): RunMeta {
  const status = note === "killed" ? "killed" : exitCode === 0 ? "done" : exitCode === null ? "unknown" : "failed";
  return { ...meta, status, exitCode, finishedAt: now, ...(note ? { note } : {}) };
}

/** Rebase the ETA from now and restart its reminder window. */
export function applyEta(meta: RunMeta, minutes: number, now = new Date().toISOString()): RunMeta {
  const { lastReminderAt: _last, etaPending: _pending, ...rest } = meta;
  return { ...rest, etaMinutes: minutes, etaFrom: now, reminders: 0 };
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Running runs whose process is gone but whose meta was never finalized. */
export async function listRuns(parentSessionId: string): Promise<RunMeta[]> {
  const dir = sessionRoot(parentSessionId);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const runs: RunMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readMeta(parentSessionId, entry.name);
    if (meta) runs.push(meta);
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function processAlive(pid: number, marker?: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!marker) return true;
  // Pi sets process.title during CLI startup, which overwrites
  // /proc/<pid>/cmdline and erases the launch marker. The environment marker
  // is set at spawn time and survives, so prefer it over argv.
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
    if (environ.split("\0").includes(`PI_BACKGROUND_RUN=${marker}`)) return true;
  } catch {
    // Fall through to the cmdline check for callers that use a plain marker.
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes(marker);
  } catch {
    return false;
  }
}

export function formatDuration(fromIso: string, toIso?: string): string {
  const from = Date.parse(fromIso);
  const to = toIso ? Date.parse(toIso) : Date.now();
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const RETENTION_DAYS = 30;
export const RETENTION_RUNS = 25;

/**
 * Delete artifacts of settled runs that are older than the age limit or beyond
 * the newest N runs for this session, whichever comes first. Running runs and
 * runs whose notice was never delivered are always kept.
 */
export async function pruneRuns(
  parentSessionId: string,
  now = Date.now(),
): Promise<{ deleted: string[]; kept: number }> {
  const runs = await listRuns(parentSessionId);
  if (!runs.length) return { deleted: [], kept: 0 };
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  const newest = new Set(runs.slice(-RETENTION_RUNS).map(run => run.id));
  const deleted: string[] = [];
  for (const run of runs) {
    if (run.status === "running") continue;
    if (run.notified === false) continue;
    const tooOld = Number.isFinite(Date.parse(run.startedAt)) && Date.parse(run.startedAt) < cutoff;
    const beyondLimit = !newest.has(run.id);
    if (!tooOld && !beyondLimit) continue;
    await rm(runDir(parentSessionId, run.id), { recursive: true, force: true });
    deleted.push(run.id);
  }
  if (deleted.length) {
    try { await rmdir(sessionRoot(parentSessionId)); } catch { /* not empty or already gone */ }
  }
  return { deleted, kept: runs.length - deleted.length };
}
