import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import backgroundTask from "../index.ts";
import { readMeta } from "../src/store.ts";

/** Dispatch through the real tool and a fake worker so the notify flag is exercised end to end. */
test("notify false settles silently while the default still announces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-background-dispatch-"));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousWorker = process.env.PI_BACKGROUND_PI;
  process.env.PI_CODING_AGENT_DIR = root;

  const worker = join(root, "fake-pi");
  await writeFile(worker, "#!/bin/sh\necho \"fake worker report\"\nexit 0\n");
  await chmod(worker, 0o755);
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

  t.after(async () => {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousWorker === undefined) delete process.env.PI_BACKGROUND_PI; else process.env.PI_BACKGROUND_PI = previousWorker;
    await rm(root, { recursive: true, force: true });
  });

  const dispatch = async (params: Record<string, unknown>): Promise<string> => {
    const result = await tools.get("background_task")!.execute("call" as never, params as never, undefined as never, undefined as never, ctx as never) as { details: { id: string } };
    return result.details.id;
  };
  const untilSettled = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readMeta("parent", id))?.status !== "running") {
        await delay(100);
        return;
      }
      await delay(20);
    }
    assert.fail(`run ${id} did not settle`);
  };

  const silent = await dispatch({ title: "silent", task: "do nothing", notify: false, cwd: root });
  await untilSettled(silent);
  const silentMeta = await readMeta("parent", silent);
  assert.equal(silentMeta?.notify, false, "the silent flag must persist");
  assert.equal(silentMeta?.status, "done");
  assert.equal(silentMeta?.notified, true, "a silent run must be marked notified");
  assert.equal(notices.length, 0, "a silent run must not produce a notice");

  const normal = await dispatch({ title: "normal", task: "do nothing", cwd: root });
  await untilSettled(normal);
  assert.equal(notices.length, 1, "a default run must produce exactly one notice");
  assert.match(notices[0], /Background task finished/);
});
