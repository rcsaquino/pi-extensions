import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildNotice } from "./src/notice.ts";
import { buildWorkerPrompt, forceKill, launchDetached, terminate } from "./src/launch.ts";
import {
  formatDuration, listRuns, processAlive, prepareRun, pruneRuns, readMeta, readText,
  reportPath, stderrPath, taskPath, writeMeta, type RunMeta,
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
  const finalized = new Set<string>();

  function stopTimer(key: string): void {
    const timer = timers.get(key);
    if (timer) clearInterval(timer);
    timers.delete(key);
  }

  function notify(ctx: ExtensionContext, meta: RunMeta, report: string | undefined): boolean {
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

  async function finalize(ctx: ExtensionContext, meta: RunMeta, exitCode: number | null, note?: string): Promise<void> {
    const key = `${meta.parentSessionId}/${meta.id}`;
    if (finalized.has(key)) return;
    finalized.add(key);
    stopTimer(key);

    const current = (await readMeta(meta.parentSessionId, meta.id)) ?? meta;
    if (current.status !== "running") return;

    const status = note === "killed" ? "killed" : exitCode === 0 ? "done" : exitCode === null ? "unknown" : "failed";
    const updated: RunMeta = {
      ...current,
      status,
      exitCode,
      finishedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    await writeMeta(updated);

    const report = await readText(reportPath(updated.parentSessionId, updated.id));
    const sent = notify(ctx, updated, report);
    await writeMeta({ ...updated, notified: sent });
  }

  function watch(ctx: ExtensionContext, meta: RunMeta): void {
    const key = `${meta.parentSessionId}/${meta.id}`;
    if (timers.has(key)) return;
    const timer = setInterval(() => {
      void (async () => {
        if (processAlive(meta.pid, meta.childSessionId)) return;
        await finalize(ctx, meta, null);
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
          watch(ctx, run);
          continue;
        }
        await finalize(ctx, run, null);
      } else if (!run.notified) {
        const report = await readText(reportPath(id, run.id));
        const sent = notify(ctx, run, report);
        await writeMeta({ ...run, notified: sent });
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
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
  });

  pi.registerTool({
    name: "background_task",
    label: "Background task",
    description: "Fork this exact conversation into a detached Pi session that keeps working while the chat stays free. The worker has every tool, skill, extension and memory you have. Returns immediately with a run id; a notice arrives when it settles. Provide a complete, self-contained task: the worker sees the conversation as of this moment and nothing said afterward.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 160, description: "Short single-line label for the run" }),
      task: Type.String({ minLength: 1, maxLength: 40000, description: "The complete job, including scope, constraints, and what counts as done" }),
      cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Absolute working directory; defaults to the current one" })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async execute(_callId, params, _signal, _update, ctx) {
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
      watch(ctx, started);
      void launched.exited.then(code => finalize(ctx, started, code)).catch(() => {});

      return {
        content: [{ type: "text", text: `Started ${id} (pid ${launched.pid}) in ${cwd}. A notice arrives when it settles; do not poll.` }],
        details: { ...started, report: reportPath(parentSessionId, id) },
      };
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
      const lines = runs.map(run => {
        const alive = run.status === "running" && processAlive(run.pid, run.childSessionId);
        const state = run.status === "running" && !alive ? "lost" : run.status;
        return `${run.id} · ${state} · ${formatDuration(run.startedAt, run.finishedAt)}\n  ${run.title}\n  pid ${run.pid} · ${run.cwd}\n  ${reportPath(id, run.id)}`;
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
      const report = (await readText(reportPath(parentSessionId, params.id)))?.trim();
      const stderr = report ? undefined : (await readText(stderrPath(parentSessionId, params.id)))?.trim();
      const body = report && report.length > 0 ? report : stderr && stderr.length > 0 ? `(no report; stderr tail)\n${stderr.slice(-8000)}` : "(no output)";
      const offset = params.offset ?? 0;
      const limit = params.limit ?? RESULT_LIMIT;
      const page = body.slice(offset, offset + limit);
      const more = offset + limit < body.length ? `\n\n[more: offset ${offset + limit} of ${body.length}]` : "";
      const header = `${meta.title} · ${meta.status} · ${formatDuration(meta.startedAt, meta.finishedAt)}\n\n`;
      return { content: [{ type: "text", text: header + page + more }], details: { ...meta, total: body.length, offset } };
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
      const alive = processAlive(meta.pid, meta.childSessionId);
      if (!alive) {
        await finalize(ctx, meta, null);
        return { content: [{ type: "text", text: `${meta.id} was no longer running; finalized.` }], details: meta };
      }
      const result = terminate(meta.pid);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (!processAlive(meta.pid, meta.childSessionId)) {
          clearInterval(timer);
          void finalize(ctx, meta, null, "killed");
          return;
        }
        if (Date.now() - startedAt > 4000) {
          clearInterval(timer);
          forceKill(meta.pid);
          void finalize(ctx, meta, null, "killed");
        }
      }, 500);
      timer.unref?.();
      return {
        content: [{ type: "text", text: `Sent SIGTERM to ${meta.id} (pid ${meta.pid}); it will be killed after 4s if it does not exit.` }],
        details: { ...meta, signaled: result.term },
      };
    },
  });
}
