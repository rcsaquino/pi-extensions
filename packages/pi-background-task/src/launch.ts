import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export const WORKER_NOTE =
  "[Background job] This session was started detached by the background_task tool. " +
  "No one will read intermediate output or answer questions; do not ask for confirmation. " +
  "Carry out the assignment below and finish with a concise plain-text report: what you did, " +
  "files or paths produced, verification, and any blockers. Do not dispatch another background " +
  "task unless the assignment explicitly requires it.";

/** Prefix a task with the operational contract a fork cannot guarantee. */
export function buildWorkerPrompt(task: string): string {
  return `${WORKER_NOTE}\n\n---\n\n${task}`;
}

export interface LaunchOptions {
  sessionFile: string;
  childSessionId: string;
  title: string;
  prompt: string;
  cwd: string;
  reportPath: string;
  stderrPath: string;
  depth: number;
}

export interface LaunchResult {
  pid: number;
  exited: Promise<number | null>;
}

/** Fork the session into a detached `pi -p` process whose stdout is the report. */
export function launchDetached(options: LaunchOptions): LaunchResult {
  const out = openSync(options.reportPath, "a", 0o600);
  const err = openSync(options.stderrPath, "a", 0o600);
  const command = process.env.PI_BACKGROUND_PI ?? "pi";
  try {
    const child = spawn(command, [
      "--fork", options.sessionFile,
      "--session-id", options.childSessionId,
      "--name", options.title,
      "-p", options.prompt,
    ], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", out, err],
      env: {
        ...process.env,
        PI_BACKGROUND_DEPTH: String(options.depth),
        PI_BACKGROUND_RUN: options.childSessionId,
      },
    });
    const exited = new Promise<number | null>(resolve => {
      child.once("error", () => resolve(null));
      child.once("exit", code => resolve(code));
    });
    if (!child.pid) throw new Error(`The background worker did not start: ${command}. Install Pi on PATH or set PI_BACKGROUND_PI to the Pi executable.`);
    child.unref();
    return { pid: child.pid, exited };
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

/** Terminate a detached run's process group, escalating to SIGKILL. */
export function terminate(pid: number): { term: boolean; killed: boolean } {
  let term = false;
  let killed = false;
  try {
    process.kill(-pid, "SIGTERM");
    term = true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      term = true;
    } catch { /* already gone */ }
  }
  return { term, killed };
}

export function forceKill(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}
