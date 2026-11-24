import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { buildEtaMissing, buildEtaReminder, buildNotice, DEFAULT_ETA_MINUTES, reminderState, shouldNotify } from "./src/notice.ts";
import { buildWorkerPrompt, forceKill, launchDetached, terminate } from "./src/launch.ts";
import { createActiveWorkProvider, registerActiveWorkProvider } from "./src/background-work.ts";
import { createRunLock } from "./src/lock.ts";
import {
  applyEta, formatDuration, killIntentPath, listRuns, processAlive, prepareRun, pruneRuns, readMeta, readText,
  reportPath, sessionFiles, settleMeta, stderrPath, taskPath, writeMeta, type RunMeta,
} from "./src/store.ts";

const MAX_CONCURRENT = 4;
const MAX_DEPTH = 2;
const POLL_MS = 2000;
const RESULT_LIMIT = 12000;

interface SessionRef { id: string; file: string }

function sessionRef(ctx: ExtensionContext): SessionRef {
  const id = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();
  if (!file) throw new Error("Background tasks need a persisted session; this session is ephemeral.");
  return { id, file };
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `bg-${stamp}-${randomBytes(3).toString("hex")}`;
}

function depth(): number {
  const raw = Number(process.env.PI_BACKGROUND_DEPTH ?? "0");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export default function backgroundTask(pi: ExtensionAPI): void {
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const live = new Map<string, RunMeta>();
  const unregisterActiveWork = registerActiveWorkProvider(createActiveWorkProvider(live));
  const finalized = new Set<string>();
  const reminding = new Set<string>();
  const withRunLock = createRunLock();
  // Count-then-create must not interleave: parallel tool calls would exceed the cap.
  const withDispatchLock = createRunLock();

  function stopTimer(key: string): void {
    const timer = timers.get(key);
    if (timer) clearInterval(timer);
    timers.delete(key);
  }

  function notify(meta: RunMeta, report: string | undefined): boolean {
    try {
      pi.sendMessage(
        { customType: "background-task-notice", content: buildNotice(meta, report), display: true, details: { runId: meta.id } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return true;
    } catch {
      // A session switch during delivery must not lose the run record; recovery retries on the next start.
      return false;
    }
  }

  /** Persist the settle status, announce it when owed, then record delivery. */
  async function announce(meta: RunMeta): Promise<void> {
    if (!shouldNotify(meta)) {
      // An explicit kill is already acknowledged by the kill tool; no follow-up turn.
      await writeMeta({ ...meta, notified: true });
      return;
    }
    const report = await readText(reportPath(meta.parentSessionId, meta.id));
    await writeMeta({ ...meta, notified: notify(meta, report) });
  }

  async function claimRun(meta: RunMeta): Promise<RunMeta> {
    const key = `${meta.parentSessionId}/${meta.id}`;
    return withRunLock(key, async () => {
      const current = (await readMeta(meta.parentSessionId, meta.id)) ?? meta;
      if (current.status !== "running" || current.notify === false) {
        live.set(key, current);
        return current;
      }
      const updated = { ...current, notify: false };
      await writeMeta(updated);
      live.set(key, updated);
      return updated;
    });
  }

  async function waitForRun(meta: RunMeta, timeoutSeconds: number): Promise<RunMeta> {
    const key = `${meta.parentSessionId}/${meta.id}`;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let current = await claimRun(meta);
    while (current.status === "running") {
      if (!processAlive(current.pid, current.childSessionId)) await finalize(current, null);
      if (Date.now() >= deadline) break;
      await delay(Math.min(500, Math.max(1, deadline - Date.now())));
      current = (await readMeta(meta.parentSessionId, meta.id)) ?? current;
      live.set(key, current);
    }
    if (current.status === "running") {
      current = (await readMeta(meta.parentSessionId, meta.id)) ?? current;
      live.set(key, current);
    }
    return current;
  }

  async function readReportPage(parentSessionId: string, meta: RunMeta, offset: number, limit: number) {
    const report = (await readText(reportPath(parentSessionId, meta.id)))?.trim();
    const stderr = report ? undefined : (await readText(stderrPath(parentSessionId, meta.id)))?.trim();
    const body = report && report.length > 0 ? report : stderr && stderr.length > 0 ? `(no report; stderr tail)\n${stderr.slice(-8000)}` : "(no output)";
    const page = body.slice(offset, offset + limit);
    const more = offset + limit < body.length ? `\n\n[more: offset ${offset + limit} of ${body.length}]` : "";
    const header = `${meta.title} · ${meta.status} · ${formatDuration(meta.startedAt, meta.finishedAt)}\n\n`;
    return { text: header + page + more, total: body.length, offset };
  }

  async function finalize(meta: RunMeta, exitCode: number | null, note?: string): Promise<void> {
    const key = `${meta.parentSessionId}/${meta.id}`;
    if (finalized.has(key)) return;
    finalized.add(key);
    stopTimer(key);

    await withRunLock(key, async () => {
      const current = (await readMeta(meta.parentSessionId, meta.id)) ?? meta;
      if (current.status !== "running") return;

      const updated = settleMeta(current, exitCode, note === "killed" || existsSync(killIntentPath(meta.parentSessionId, meta.id)) ? "killed" : note);
      // Persist the settled status before triggering a follow-up turn.
      if (shouldNotify(updated)) await writeMeta(updated);
      await announce(updated);
    });
  }

  async function maybeRemind(meta: RunMeta): Promise<void> {
    const key = `${meta.parentSessionId}/${meta.id}`;
    if (reminding.has(key)) return;
    reminding.add(key);
    try {
      await withRunLock(key, async () => {
        const current = (await readMeta(meta.parentSessionId, meta.id)) ?? meta;
        const state = reminderState(current);
        if (state === "none") {
          live.set(key, current);
          return;
        }
        const now = new Date().toISOString();
        const updated: RunMeta = state === "remind"
          ? { ...current, reminders: (current.reminders ?? 0) + 1, lastReminderAt: now, etaPending: now }
          : { ...current, lastReminderAt: now };
        // Persist before sending: a failed write must not retrigger a follow-up every poll.
        await writeMeta(updated);
        live.set(key, updated);
        pi.sendMessage(
          {
            customType: state === "remind" ? "background-task-eta" : "background-task-eta-missing",
            content: state === "remind" ? buildEtaReminder(updated) : buildEtaMissing(updated),
            display: true,
            details: { runId: updated.id },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      });
    } catch {
      // A failed write sends nothing; the next poll retries. A failed send stays recorded.
    } finally {
      reminding.delete(key);
    }
  }

  function watch(meta: RunMeta): void {
    const key = `${meta.parentSessionId}/${meta.id}`;
    live.set(key, meta);
    if (timers.has(key)) return;
    const timer = setInterval(() => {
      void (async () => {
        const current = live.get(key) ?? meta;
        if (processAlive(current.pid, current.childSessionId)) {
          if (reminderState(current) !== "none") await maybeRemind(current);
          return;
        }
        await finalize(current, null);
      })().catch(() => {});
    }, POLL_MS);
    timer.unref?.();
    timers.set(key, timer);
  }

  async function recover(ctx: ExtensionContext): Promise<void> {
    const { id } = sessionRef(ctx);
    const runs = await listRuns(id);
    for (const run of runs) {
      if (run.status === "running") {
        if (processAlive(run.pid, run.childSessionId)) {
          watch(run);
          continue;
        }
        await finalize(run, null);
      } else if (!run.notified) {
        await announce(run);
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // Let the session finish initializing before injecting a recovered notice.
    setTimeout(() => {
      void (async () => {
        await recover(ctx);
        await pruneRuns(sessionRef(ctx).id);
      })().catch(() => {});
    }, 500).unref?.();
  });

  pi.on("session_shutdown", () => {
    unregisterActiveWork();
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    live.clear();
  });

  pi.registerTool({
    name: "background_task",
    label: "Background task",
    description: "Fork this exact conversation into a detached Pi session that keeps working while the chat stays free. The worker has every tool, skill, extension and memory you have. Returns immediately with a run id. By default a notice arrives when it settles and a reminder if it runs past its ETA; set notify false for helper runs whose report the caller will collect with background_result. Provide a complete, self-contained task: the worker sees the conversation as of this moment and nothing said afterward.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 160, description: "Short single-line label for the run" }),
      task: Type.String({ minLength: 1, maxLength: 40000, description: "The complete job, including scope, constraints, and what counts as done" }),
      eta_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 240, description: `Expected minutes to completion; a reminder arrives if the run is still going past it. Defaults to ${DEFAULT_ETA_MINUTES}.` })),
      notify: Type.Optional(Type.Boolean({ description: "Send a settle notice and ETA reminders. Default true. Set false for helper runs whose report the caller will read with background_result; silent runs are never announced." })),
      cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Absolute working directory; defaults to the current one" })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async execute(_callId, params, _signal, _update, ctx) {
      return withDispatchLock("dispatch", async () => {
        if (depth() >= MAX_DEPTH) {
          throw new Error(`Background depth limit ${MAX_DEPTH} reached; finish this task instead of nesting further.`);
        }
        const { id: parentSessionId, file: sessionFile } = sessionRef(ctx);
        const running = (await listRuns(parentSessionId)).filter(run => run.status === "running" && processAlive(run.pid, run.childSessionId));
        if (running.length >= MAX_CONCURRENT) {
          throw new Error(`${running.length} background tasks are already running (limit ${MAX_CONCURRENT}). Wait for a notice or kill one with background_kill.`);
        }

        const cwd = resolve(params.cwd ?? ctx.cwd);
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
          throw new Error(`Working directory does not exist: ${cwd}`);
        }

        const id = newId();
        const childSessionId = id;
        const meta: RunMeta = {
          id,
          title: params.title.trim() || id,
          parentSessionId,
          childSessionId,
          pid: 0,
          cwd,
          startedAt: new Date().toISOString(),
          status: "running",
          etaMinutes: params.eta_minutes ?? DEFAULT_ETA_MINUTES,
          ...(params.notify === false ? { notify: false } : {}),
        };
        await prepareRun(meta);
        const prompt = buildWorkerPrompt(params.task);
        await writeFile(taskPath(parentSessionId, id), `# Task\n\n${prompt}\n`, { mode: 0o600 });

        let launched;
        try {
          launched = launchDetached({
            sessionFile,
            childSessionId,
            title: meta.title,
            prompt,
            cwd,
            reportPath: reportPath(parentSessionId, id),
            stderrPath: stderrPath(parentSessionId, id),
            depth: depth() + 1,
          });
        } catch (error) {
          await writeMeta({ ...meta, status: "failed", finishedAt: new Date().toISOString(), note: "launch failed" });
          throw error;
        }

        const started: RunMeta = { ...meta, pid: launched.pid };
        await writeMeta(started);
        watch(started);
        void launched.exited.then(code => finalize(started, code)).catch(() => {});

        return {
          content: [{ type: "text", text: `Started ${id} (pid ${launched.pid}) in ${cwd}. ETA ${meta.etaMinutes}m; ${meta.notify === false ? "no settle notice will follow, read its report with background_result." : "a notice arrives when it settles, and a reminder if it overruns. Do not poll."}` }],
          details: { ...started, report: reportPath(parentSessionId, id) },
        };
      });
    },
  });

  pi.registerTool({
    name: "background_eta",
    label: "Revise background ETA",
    description: "Revise a running background task's ETA. The next reminder counts from now, so a new promise gets a new check instead of waiting for the old one.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, description: "Run id" }),
      eta_minutes: Type.Integer({ minimum: 1, maximum: 240, description: "Minutes from now until the next reminder" }),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(_callId, params, _signal, _update, ctx) {
      const { id: parentSessionId } = sessionRef(ctx);
      const key = `${parentSessionId}/${params.id}`;
      return withRunLock(key, async () => {
        const meta = await readMeta(parentSessionId, params.id);
        if (!meta) throw new Error(`Run ${params.id} was not found in this session.`);
        if (meta.status !== "running" || !processAlive(meta.pid, meta.childSessionId)) {
          return { content: [{ type: "text", text: `${meta.id} already settled as ${meta.status}.` }], details: meta };
        }
        const now = new Date();
        const updated = applyEta(meta, params.eta_minutes, now.toISOString());
        await writeMeta(updated);
        live.set(key, updated);
        const due = new Date(now.getTime() + params.eta_minutes * 60_000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        return {
          content: [{ type: "text", text: `ETA for ${updated.id} is now ${params.eta_minutes}m from now; ${updated.notify === false ? "no reminder will fire, read the report with background_result." : `the next reminder is at ${due}.`}` }],
          details: updated,
        };
      });
    },
  });

  pi.registerTool({
    name: "background_list",
    label: "List background tasks",
    description: "List background tasks for this session with status, elapsed time, pid and report path. Use when the user asks how a run is going, or after a restart when a notice may not have arrived.",
    parameters: Type.Object({}, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_callId, _params, _signal, _update, ctx) {
      const { id } = sessionRef(ctx);
      const runs = await listRuns(id);
      if (!runs.length) return { content: [{ type: "text", text: "No background tasks in this session." }], details: { runs: [] } };
      const sessions = await sessionFiles();
      const lines = runs.map(run => {
        const alive = run.status === "running" && processAlive(run.pid, run.childSessionId);
        const state = run.status === "running" && !alive ? "lost" : run.status;
        const eta = run.etaMinutes ?? DEFAULT_ETA_MINUTES;
        const base = Date.parse(run.etaFrom ?? run.startedAt);
        const over = run.status === "running" && Date.now() >= base + eta * 60_000;
        const session = sessions.get(run.childSessionId);
        const refs = [
          session ? `session ${session}` : undefined,
          reportPath(id, run.id),
        ].filter(Boolean).join("\n  ");
        return `${run.id} · ${state}${run.notify === false ? " · silent" : ""} · ${formatDuration(run.startedAt, run.finishedAt)} · eta ${eta}m${over ? " (over)" : ""}\n  ${run.title}\n  pid ${run.pid} · ${run.cwd}\n  ${refs}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }], details: { runs } };
    },
  });

  pi.registerTool({
    name: "background_result",
    label: "Read background result",
    description: "Read a background task's report, paged by characters. Falls back to the tail of stderr when the worker produced no output, so a crash before any report is diagnosable.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, description: "Run id from background_task or the settle notice" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to start from; defaults to 0" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30000, description: `Maximum characters to return; defaults to ${RESULT_LIMIT}` })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_callId, params, _signal, _update, ctx) {
      const { id: parentSessionId } = sessionRef(ctx);
      const meta = await readMeta(parentSessionId, params.id);
      if (!meta) throw new Error(`Run ${params.id} was not found in this session.`);
      const page = await readReportPage(parentSessionId, meta, params.offset ?? 0, params.limit ?? RESULT_LIMIT);
      return { content: [{ type: "text", text: page.text }], details: { ...meta, total: page.total, offset: page.offset } };
    },
  });

  pi.registerTool({
    name: "background_wait",
    label: "Wait for background result",
    description: "Wait for a background task to settle and return its report. A running task is claimed first, which suppresses its settle notice and ETA reminder after the wait begins. Returns still-running status on timeout.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, description: "Run id from background_task or the settle notice" }),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "Seconds to wait before returning still-running; defaults to 120." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to start from; defaults to 0" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30000, description: `Maximum characters to return; defaults to ${RESULT_LIMIT}` })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(_callId, params, _signal, _update, ctx) {
      const { id: parentSessionId } = sessionRef(ctx);
      const meta = await readMeta(parentSessionId, params.id);
      if (!meta) throw new Error(`Run ${params.id} was not found in this session.`);
      const timeout = params.timeout_seconds ?? 120;
      const settled = await waitForRun(meta, timeout);
      if (settled.status === "running") {
        return {
          content: [{ type: "text", text: `${settled.title} · still running after ${timeout}s wait · ${formatDuration(settled.startedAt)}\n\nThe wait claimed this run. It will not announce itself, and no settle notice or ETA reminder will follow. Call background_wait again to collect it, or read partial output with background_result.\n\nReport: ${reportPath(parentSessionId, settled.id)}` }],
          details: { ...settled, total: 0, offset: 0, timedOut: true, waitedSeconds: timeout },
        };
      }
      const page = await readReportPage(parentSessionId, settled, params.offset ?? 0, params.limit ?? RESULT_LIMIT);
      return { content: [{ type: "text", text: page.text }], details: { ...settled, total: page.total, offset: page.offset } };
    },
  });

  pi.registerTool({
    name: "background_kill",
    label: "Kill background task",
    description: "Terminate a running background task's process group, escalating to SIGKILL. Use for runaway, stuck, or no-longer-wanted runs.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, description: "Run id" }),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(_callId, params, _signal, _update, ctx) {
      const { id: parentSessionId } = sessionRef(ctx);
      const meta = await readMeta(parentSessionId, params.id);
      if (!meta) throw new Error(`Run ${params.id} was not found in this session.`);
      if (meta.status !== "running") {
        return { content: [{ type: "text", text: `${meta.id} already settled as ${meta.status}.` }], details: meta };
      }
      // Persist intent before any signal: the 2s watcher and this 500ms check can race on process death.
      await writeFile(killIntentPath(parentSessionId, meta.id), "killed\n", { mode: 0o600, flag: "wx" }).catch(() => {});
      const alive = processAlive(meta.pid, meta.childSessionId);
      if (!alive) {
        await finalize(meta, null, "killed");
        return { content: [{ type: "text", text: `${meta.id} was no longer running; settled silently.` }], details: meta };
      }
      const result = terminate(meta.pid);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (!processAlive(meta.pid, meta.childSessionId)) {
          clearInterval(timer);
          void finalize(meta, null, "killed");
          return;
        }
        if (Date.now() - startedAt > 4000) {
          clearInterval(timer);
          forceKill(meta.pid);
          void finalize(meta, null, "killed");
        }
      }, 500);
      timer.unref?.();
      return {
        content: [{ type: "text", text: `Sent SIGTERM to ${meta.id} (pid ${meta.pid}); it will be killed after 4s if it does not exit. No settle notice will follow.` }],
        details: { ...meta, signaled: result },
      };
    },
  });
}
