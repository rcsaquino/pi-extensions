import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWorkerPrompt, launchDetached, WORKER_NOTE } from "../src/launch.ts";

test("buildWorkerPrompt prefixes the operational note", () => {
  const task = "Fix the parser and report the test results.";
  const prompt = buildWorkerPrompt(task);
  assert.ok(prompt.startsWith(WORKER_NOTE));
  assert.ok(prompt.endsWith(task));
  assert.match(prompt, /do not ask for confirmation/);
  assert.match(prompt, /concise plain-text report/);
  assert.match(prompt, /Do not dispatch another background task/);
});

test("buildWorkerPrompt keeps the task verbatim", () => {
  const task = "line one\n\nline two\n";
  assert.equal(buildWorkerPrompt(task), `${WORKER_NOTE}\n\n---\n\n${task}`);
});

test("a missing worker binary fails with the command and the override", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-background-launch-"));
  const previous = process.env.PI_BACKGROUND_PI;
  process.env.PI_BACKGROUND_PI = join(dir, "missing-pi");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_BACKGROUND_PI; else process.env.PI_BACKGROUND_PI = previous;
    await rm(dir, { recursive: true, force: true });
  });
  assert.throws(() => launchDetached({
    sessionFile: join(dir, "session.jsonl"), childSessionId: "run", title: "Run", prompt: "Task", cwd: dir,
    reportPath: join(dir, "report.md"), stderrPath: join(dir, "stderr.log"), depth: 1,
  }), /did not start: .*missing-pi.*PI_BACKGROUND_PI/);
});
