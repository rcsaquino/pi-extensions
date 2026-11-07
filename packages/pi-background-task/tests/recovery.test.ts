import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import backgroundTask from "../index.ts";
import { prepareRun, readMeta, reportPath, killIntentPath, type RunMeta } from "../src/store.ts";

const root = await mkdtemp(join(tmpdir(), "pi-background-task-recovery-"));
process.env.PI_CODING_AGENT_DIR = root;

const PARENT = "parent-session";
const deadPid = 2_147_483_646;

function meta(id: string, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id, title: id, parentSessionId: PARENT, childSessionId: id, pid: deadPid,
    cwd: root, startedAt: "2026-11-02T00:00:00.000Z", status: "running", ...overrides,
  };
}

/** The extension reaches Pi through on/registerTool/sendMessage only. */
function harness() {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const notices: string[] = [];
  const tools = new Map<string, { execute: (...args: never[]) => unknown }>();
  const pi = {
    on(event: string, handler: (...args: never[]) => unknown) { handlers.set(event, handler); },
    registerTool(tool: { name: string; execute: (...args: never[]) => unknown }) { tools.set(tool.name, tool); },
    sendMessage(message: { content: string }) { notices.push(message.content); },
  } as unknown as ExtensionAPI;
  backgroundTask(pi);
  const ctx = { sessionManager: { getSessionId: () => PARENT, getSessionFile: () => join(root, "session.jsonl") }, cwd: root } as unknown as ExtensionContext;
  const start = () => handlers.get("session_start")!({} as never, ctx as never);
  return { notices, start, tools, ctx };
}

async function until(predicate: () => boolean, timeout = 4000): Promise<void> {
  const begin = Date.now();
  while (!predicate()) {
    if (Date.now() - begin > timeout) assert.fail("timed out waiting for a recovered notice");
    await delay(20);
  }
  await delay(200);
}

test("recover silences an unnotified killed run and never announces it", async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = meta("bg-20261102-000000-kill01", { status: "killed", exitCode: null, note: "killed", finishedAt: "2026-11-02T00:12:00.000Z", notified: false });
  await prepareRun(run);
  await writeFile(reportPath(PARENT, run.id), "cancelled report\n");
  const { notices, start } = harness();

  await start();
  await delay(900);

  assert.equal(notices.length, 0, "an explicit kill must not produce a follow-up turn");
  const settled = await readMeta(PARENT, run.id);
  assert.equal(settled?.status, "killed", "status must stay killed");
  assert.equal(settled?.notified, true, "silence must not be retried on the next start");
  assert.ok(settled?.finishedAt);
});

test("background_kill on an already-dead run settles silently as killed", async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = meta("bg-20261102-000000-kill02");
  await prepareRun(run);
  const { notices, tools, ctx } = harness();

  const result = await tools.get("background_kill")!.execute("call" as never, { id: run.id } as never, undefined as never, undefined as never, ctx as never) as { content: Array<{ text: string }> };
  assert.match(result.content[0].text, /no longer running/);
  const settled = await readMeta(PARENT, run.id);
  assert.equal(settled?.status, "killed");
  assert.equal(settled?.notified, true);
  await delay(300);
  assert.equal(notices.length, 0, "a direct kill must not announce a settled run");
});

test("a persisted kill intent silences a dead running run", async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = meta("bg-20261102-000000-kill03");
  await prepareRun(run);
  await writeFile(killIntentPath(PARENT, run.id), "killed\n");
  const { notices, start } = harness();

  await start();
  await delay(900);

  assert.equal(notices.length, 0, "a killing watcher race must stay silent");
  const settled = await readMeta(PARENT, run.id);
  assert.equal(settled?.status, "killed");
  assert.equal(settled?.notified, true);
});

test("recover still announces an unnotified failed run", async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = meta("bg-20261102-000000-fail01", { status: "failed", exitCode: 1, finishedAt: "2026-11-02T00:13:00.000Z", notified: false });
  await prepareRun(run);
  await writeFile(reportPath(PARENT, run.id), "failed report\n");
  const { notices, start } = harness();

  await start();
  await until(() => notices.length > 0);

  assert.equal(notices.length, 1);
  assert.match(notices[0], new RegExp(run.id));
  assert.equal((await readMeta(PARENT, run.id))?.notified, true);
});

test("recover finalizes a run whose process died, once, and never announces it again", async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = meta("bg-20261102-000000-dead01");
  await prepareRun(run);
  const { notices, start } = harness();

  await start();
  await until(() => notices.length > 0);

  const settled = await readMeta(PARENT, run.id);
  assert.equal(settled?.status, "unknown");
  assert.equal(settled?.exitCode, null);
  assert.equal(settled?.notified, true);
  assert.ok(settled?.finishedAt);
  assert.equal(notices.length, 1);

  await start();
  await delay(900);
  assert.equal(notices.length, 1, "a settled run must not be announced again");
});

test("two overlapping recoveries settle one dead run with one notice", async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = meta("bg-20261102-000000-race01");
  await prepareRun(run);
  const { notices, start } = harness();

  await Promise.all([start(), start()]);
  await until(() => notices.length > 0);
  assert.equal(notices.length, 1, "the second settle must be a no-op");

  const settled = await readMeta(PARENT, run.id);
  assert.equal(settled?.status, "unknown");
  assert.equal(settled?.notified, true);
});

test("recover announces a settled but unnotified run, and leaves notified or live runs alone", async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const unnotified = meta("bg-20261102-000000-unnot1", { status: "done", exitCode: 0, finishedAt: "2026-11-02T00:10:00.000Z", notified: false });
  const notified = meta("bg-20261102-000000-notif1", { status: "failed", exitCode: 1, finishedAt: "2026-11-02T00:11:00.000Z", notified: true });
  const live = meta("bg-20261102-000000-live01");
  const child = spawn("sleep", ["30"], { stdio: "ignore", env: { ...process.env, PI_BACKGROUND_RUN: live.childSessionId } });
  live.pid = child.pid!;
  t.after(() => child.kill("SIGKILL"));
  for (const run of [unnotified, notified, live]) await prepareRun(run);
  await writeFile(reportPath(PARENT, unnotified.id), "recovered report\n");
  const { notices, start } = harness();

  await start();
  await until(() => notices.length > 0);

  assert.equal(notices.length, 1, "only the unnotified run is announced");
  assert.match(notices[0], new RegExp(unnotified.id));
  assert.match(notices[0], /recovered report/);
  assert.equal((await readMeta(PARENT, unnotified.id))?.notified, true);
  assert.equal((await readMeta(PARENT, unnotified.id))?.status, "done", "announcing must not rewrite the status");
  assert.equal((await readMeta(PARENT, notified.id))?.notified, true);
  assert.equal((await readMeta(PARENT, live.id))?.status, "running", "a live run is left running");

  await start();
  await delay(900);
  assert.equal(notices.length, 1, "recovery is idempotent");
});
