import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import backgroundTask from "../index.ts";
import { terminate } from "../src/launch.ts";
import { prepareRun, readMeta, reportPath } from "../src/store.ts";

interface Harness {
  notices: string[];
  tools: Map<string, { execute: (...args: never[]) => unknown }>;
  ctx: ExtensionContext;
}

async function harness(root: string, workerScript: string): Promise<Harness> {
  const worker = join(root, "fake-pi");
  await writeFile(worker, workerScript);
  await chmod(worker, 0o755);
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_BACKGROUND_PI = worker;
  const session = join(root, "session.jsonl");
  await writeFile(session, "{}\n");

  const notices: string[] = [];
  const tools = new Map<string, { execute: (...args: never[]) => unknown }>();
  const pi = {
    on() {},
    registerTool(tool: { name: string; execute: (...args: never[]) => unknown }) { tools.set(tool.name, tool); },
    sendMessage(message: { content: string }) { notices.push(message.content); },
  } as unknown as ExtensionAPI;
  backgroundTask(pi);
  const ctx = {
    sessionManager: { getSessionId: () => "parent", getSessionFile: () => session },
    cwd: root,
  } as unknown as ExtensionContext;
  return { notices, tools, ctx };
}

async function dispatch(h: Harness, params: Record<string, unknown>): Promise<string> {
  const result = await h.tools.get("background_task")!.execute("call" as never, params as never, undefined as never, undefined as never, h.ctx as never) as { details: { id: string } };
  return result.details.id;
}

async function wait(h: Harness, params: Record<string, unknown>): Promise<{ text: string; details: { status: string; notify?: boolean; notified?: boolean; timedOut?: boolean } }> {
  const result = await h.tools.get("background_wait")!.execute("call" as never, params as never, undefined as never, undefined as never, h.ctx as never) as { content: Array<{ text: string }>; details: { status: string; notify?: boolean; notified?: boolean; timedOut?: boolean } };
  return { text: result.content[0].text, details: result.details };
}

function isolate(t: { after: (fn: () => unknown) => void }) {
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousWorker = process.env.PI_BACKGROUND_PI;
  return async (root: string) => {
    t.after(async () => {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousWorker === undefined) delete process.env.PI_BACKGROUND_PI; else process.env.PI_BACKGROUND_PI = previousWorker;
      await rm(root, { recursive: true, force: true });
    });
  };
}

test("background_wait returns the report and claims the result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-background-wait-"));
  const cleanup = isolate(t);
  await cleanup(root);
  const h = await harness(root, "#!/bin/sh\nsleep 1\necho \"waited report\"\nexit 0\n");
  const id = await dispatch(h, { title: "wait", task: "do nothing", cwd: root });

  const result = await wait(h, { id, timeout_seconds: 5 });
  assert.match(result.text, /waited report/);
  assert.equal(result.details.status, "done");
  const meta = await readMeta("parent", id);
  assert.equal(meta?.notify, false, "waiting must claim the run");
  assert.equal(meta?.notified, true, "the claimed run must settle silently");
  await delay(200);
  assert.equal(h.notices.length, 0, "a claimed run must not announce");
});

test("background_wait times out without releasing the claim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-background-wait-timeout-"));
  const cleanup = isolate(t);
  await cleanup(root);
  const h = await harness(root, "#!/bin/sh\nsleep 30\necho \"late report\"\nexit 0\n");
  const id = await dispatch(h, { title: "slow", task: "do nothing", cwd: root });

  const result = await wait(h, { id, timeout_seconds: 1 });
  assert.match(result.text, /still running after 1s/i);
  assert.match(result.text, /will not announce itself/i);
  assert.match(result.text, /background_wait again/i);
  assert.match(result.text, /background_result/);
  assert.equal(result.details.status, "running");
  assert.equal(result.details.timedOut, true);
  const meta = await readMeta("parent", id);
  assert.equal(meta?.notify, false, "a timed-out wait still claims the run");
  assert.equal(h.notices.length, 0);
  if (meta) terminate(meta.pid);
});

test("background_list marks silent runs and leaves default runs unmarked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-background-list-"));
  const cleanup = isolate(t);
  await cleanup(root);
  const h = await harness(root, "#!/bin/sh\nsleep 30\nexit 0\n");
  const silent = await dispatch(h, { title: "silent", task: "do nothing", notify: false, cwd: root });
  const normal = await dispatch(h, { title: "normal", task: "do nothing", cwd: root });

  const listed = await h.tools.get("background_list")!.execute("call" as never, {} as never, undefined as never, undefined as never, h.ctx as never) as { content: Array<{ text: string }> };
  const blocks = listed.content[0].text.split("\n\n");
  const silentBlock = blocks.find(block => block.includes(silent));
  const normalBlock = blocks.find(block => block.includes(normal));
  assert.ok(silentBlock, "the silent run must be listed");
  assert.ok(normalBlock, "the default run must be listed");
  assert.match(silentBlock, / · silent · /);
  assert.doesNotMatch(normalBlock, /silent/);

  for (const id of [silent, normal]) {
    const meta = await readMeta("parent", id);
    if (meta) terminate(meta.pid);
  }
});

test("background_wait returns an already settled report without claiming it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-background-wait-settled-"));
  const cleanup = isolate(t);
  await cleanup(root);
  const h = await harness(root, "#!/bin/sh\nexit 0\n");
  const id = "bg-20261102-000000-settled";
  const run = {
    id, title: "settled", parentSessionId: "parent", childSessionId: id, pid: 0, cwd: root,
    startedAt: new Date().toISOString(), status: "done" as const, exitCode: 0,
    finishedAt: new Date().toISOString(), notified: true,
  };
  await prepareRun(run);
  await writeFile(reportPath("parent", id), "settled report\n");

  const result = await wait(h, { id, timeout_seconds: 1 });
  assert.match(result.text, /settled report/);
  assert.equal(result.details.status, "done");
  assert.equal((await readMeta("parent", id))?.notify, undefined);
});

test("background_wait rejects an unknown run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-background-wait-missing-"));
  const cleanup = isolate(t);
  await cleanup(root);
  const h = await harness(root, "#!/bin/sh\nexit 0\n");
  await assert.rejects(
    h.tools.get("background_wait")!.execute("call" as never, { id: "bg-missing" } as never, undefined as never, undefined as never, h.ctx as never) as Promise<unknown>,
    /was not found/,
  );
});
