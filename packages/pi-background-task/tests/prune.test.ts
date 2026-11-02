import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRun, pruneRuns, RETENTION_RUNS, sessionRoot, type RunMeta, type RunStatus } from "../src/store.ts";

const isolated = await mkdtemp(join(tmpdir(), "pi-background-task-"));
process.env.PI_CODING_AGENT_DIR = isolated;

function meta(parent: string, id: string, startedAt: string, status: RunStatus = "done", notified = true): RunMeta {
  return {
    id,
    title: id,
    parentSessionId: parent,
    childSessionId: id,
    pid: 1,
    cwd: isolated,
    startedAt,
    finishedAt: startedAt,
    status,
    notified,
  };
}

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

test("keeps the newest runs and deletes the rest", async () => {
  const parent = "count-parent";
  for (let i = 0; i < RETENTION_RUNS + 5; i += 1) {
    await prepareRun(meta(parent, `bg-count-${String(i).padStart(2, "0")}`, at((RETENTION_RUNS + 5 - i) * 60_000)));
  }
  const result = await pruneRuns(parent);
  assert.equal(result.deleted.length, 5);
  assert.equal(result.kept, RETENTION_RUNS);
  const left = await readdir(sessionRoot(parent));
  assert.equal(left.length, RETENTION_RUNS);
  assert.ok(!left.includes("bg-count-00"));
  assert.ok(left.includes(`bg-count-${String(RETENTION_RUNS + 4).padStart(2, "0")}`));
});

test("deletes a run past the age limit even when within the count limit", async () => {
  const parent = "age-parent";
  await prepareRun(meta(parent, "bg-old", at(40 * 86_400_000)));
  await prepareRun(meta(parent, "bg-new", at(60_000)));
  const result = await pruneRuns(parent);
  assert.deepEqual(result.deleted, ["bg-old"]);
  assert.deepEqual(await readdir(sessionRoot(parent)), ["bg-new"]);
});

test("never deletes a running run", async () => {
  const parent = "running-parent";
  await prepareRun(meta(parent, "bg-running", at(40 * 86_400_000), "running"));
  await prepareRun(meta(parent, "bg-done", at(40 * 86_400_000)));
  const result = await pruneRuns(parent);
  assert.deepEqual(result.deleted, ["bg-done"]);
  assert.deepEqual(await readdir(sessionRoot(parent)), ["bg-running"]);
});

test("keeps a settled run whose notice was never delivered", async () => {
  const parent = "unnotified-parent";
  await prepareRun(meta(parent, "bg-quiet", at(40 * 86_400_000), "done", false));
  const result = await pruneRuns(parent);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(await readdir(sessionRoot(parent)), ["bg-quiet"]);
});
