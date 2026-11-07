import { strict as assert } from "node:assert";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import backgroundTask from "../index.ts";
import { prepareRun, readMeta, runDir, type RunMeta } from "../src/store.ts";

const execute = promisify(execFile);
const PARENT = "eta-parent";

function meta(id: string, root: string, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id, title: id, parentSessionId: PARENT, childSessionId: id, pid: 0, cwd: root,
    startedAt: new Date().toISOString(), status: "running", etaMinutes: 10, ...overrides,
  };
}

function harness(root: string) {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const notices: { content: string; customType?: string }[] = [];
  const tools = new Map<string, { execute: (...args: never[]) => unknown }>();
  const pi = {
    on(event: string, handler: (...args: never[]) => unknown) { handlers.set(event, handler); },
    registerTool(tool: { name: string; execute: (...args: never[]) => unknown }) { tools.set(tool.name, tool); },
    sendMessage(message: { content: string; customType?: string }) { notices.push({ content: message.content, customType: message.customType }); },
  } as unknown as ExtensionAPI;
  backgroundTask(pi);
  const ctx = { sessionManager: { getSessionId: () => PARENT, getSessionFile: () => join(root, "session.jsonl") }, cwd: root } as unknown as ExtensionContext;
  return {
    notices, tools, ctx,
    start: () => handlers.get("session_start")!({} as never, ctx as never),
    stop: () => handlers.get("session_shutdown")!({} as never),
  };
}

function spawnLive(id: string): ChildProcess {
  return spawn("sleep", ["30"], { stdio: "ignore", env: { ...process.env, PI_BACKGROUND_RUN: id } });
}

async function until(predicate: () => boolean, timeout = 6000): Promise<void> {
  const begin = Date.now();
  while (!predicate()) {
    if (Date.now() - begin > timeout) assert.fail("timed out waiting for a reminder");
    await delay(20);
  }
  await delay(100);
}

function setup(t: TestContext) {
  return (async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-background-eta-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const children: ChildProcess[] = [];
    const immutable: string[] = [];
    t.after(async () => {
      for (const path of immutable) await execute("chattr", ["-i", path]).catch(() => {});
      for (const child of children) child.kill("SIGKILL");
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    });
    return { root, children, immutable };
  })();
}

test("one overdue reminder, and background_eta rebases the window", async t => {
  const { root, children } = await setup(t);
  const id = "bg-20261107-120000-etaone";
  const child = spawnLive(id); children.push(child);
  const run = meta(id, root, { pid: child.pid!, startedAt: new Date(Date.now() - 11 * 60_000).toISOString(), etaMinutes: 10 });
  await prepareRun(run);
  const { notices, tools, ctx, start, stop } = harness(root);

  await start();
  await until(() => notices.length > 0);
  assert.equal(notices.length, 1, "an overdue run is reminded exactly once");
  assert.match(notices[0].content, /still running/);
  const reminded = await readMeta(PARENT, id);
  assert.equal(reminded?.reminders, 1);
  assert.ok(reminded?.lastReminderAt);

  const result = await tools.get("background_eta")!.execute("call" as never, { id, eta_minutes: 1 } as never, undefined as never, undefined as never, ctx as never) as { content: Array<{ text: string }> };
  assert.match(result.content[0].text, /now 1m from now/);
  const revised = await readMeta(PARENT, id);
  assert.equal(revised?.etaMinutes, 1);
  assert.equal(revised?.reminders, 0);
  assert.equal(revised?.etaPending, undefined);
  assert.ok(revised?.etaFrom && Math.abs(Date.parse(revised.etaFrom) - Date.now()) < 2000);

  await delay(2600);
  assert.equal(notices.length, 1, "the rebased window is not due yet");
  stop();
});

test("ten parallel ETA revisions all land on one valid record", async t => {
  const { root, children } = await setup(t);
  const id = "bg-20261107-120000-etaten";
  const child = spawnLive(id); children.push(child);
  const run = meta(id, root, { pid: child.pid! });
  await prepareRun(run);
  const { tools, ctx, start, stop } = harness(root);
  await start();

  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => tools.get("background_eta")!.execute(
    "call" as never, { id, eta_minutes: index + 1 } as never, undefined as never, undefined as never, ctx as never,
  )));
  assert.equal(results.length, 10);
  const stored = await readMeta(PARENT, id);
  assert.equal(stored?.status, "running");
  assert.equal(stored?.etaMinutes, 10, "the last queued revision wins");
  assert.equal(stored?.reminders, 0);
  assert.deepEqual((await readdir(runDir(PARENT, id))).filter(name => name.endsWith(".tmp")), []);
  stop();
});

test("a failed metadata write sends no reminder", async t => {
  const { root, children, immutable } = await setup(t);
  const id = "bg-20261107-120000-etafail";
  const child = spawnLive(id); children.push(child);
  const run = meta(id, root, { pid: child.pid!, startedAt: new Date(Date.now() - 11 * 60_000).toISOString(), etaMinutes: 10 });
  await prepareRun(run);
  const { notices, start, stop } = harness(root);
  const dir = runDir(PARENT, id);
  try {
    await execute("chattr", ["+i", dir]);
  } catch {
    stop();
    t.skip("chattr is unavailable; permission faults cannot be injected as root");
    return;
  }
  immutable.push(dir);

  try {
    await start();
    await delay(3000);
    assert.equal(notices.length, 0, "without a persisted attempt the reminder must not be sent");
    assert.equal((await readMeta(PARENT, id))?.reminders, undefined);
  } finally {
    stop();
  }
});

test("a settled run cannot be revived by background_eta", async t => {
  const { root } = await setup(t);
  const id = "bg-20261107-120000-etadone";
  const run = meta(id, root, { status: "done", exitCode: 0, finishedAt: new Date().toISOString(), notified: true });
  await prepareRun(run);
  const { tools, ctx } = harness(root);
  const result = await tools.get("background_eta")!.execute("call" as never, { id, eta_minutes: 5 } as never, undefined as never, undefined as never, ctx as never) as { content: Array<{ text: string }> };
  assert.match(result.content[0].text, /already settled as done/);
  const stored = await readMeta(PARENT, id);
  assert.equal(stored?.status, "done");
  assert.equal(stored?.etaFrom, undefined);
});

test("background_list omits a missing transcript instead of printing undefined", async t => {
  const { root } = await setup(t);
  const id = "bg-20261107-120000-etalist";
  await prepareRun(meta(id, root, { status: "done", exitCode: 0, finishedAt: new Date().toISOString(), notified: true, childSessionId: "bg-missing" }));
  const { tools, ctx } = harness(root);
  const result = await tools.get("background_list")!.execute("call" as never, {} as never, undefined as never, undefined as never, ctx as never) as { content: Array<{ text: string }> };
  assert.doesNotMatch(result.content[0].text, /session undefined/);
  assert.match(result.content[0].text, new RegExp(id));
});
