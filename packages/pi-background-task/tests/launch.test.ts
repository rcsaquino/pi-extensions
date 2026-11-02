import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildWorkerPrompt, WORKER_NOTE } from "../src/launch.ts";

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
