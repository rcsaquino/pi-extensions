import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, metaPath, pruneRuns, readMeta, runDir } from "../src/store.ts";

const isolated = await mkdtemp(join(tmpdir(), "pi-background-task-meta-"));
process.env.PI_CODING_AGENT_DIR = isolated;
const parent = "meta-parent";

/** Persist a record this process did not write, as another version or a partial edit would. */
async function persisted(id: string, value: unknown): Promise<void> {
  await mkdir(runDir(parent, id), { recursive: true, mode: 0o700 });
  await writeFile(metaPath(parent, id), typeof value === "string" ? value : JSON.stringify(value));
}

function valid(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: id, parentSessionId: parent, childSessionId: id, pid: 4242, cwd: isolated,
    startedAt: "2026-11-02T00:00:00.000Z", status: "running", ...overrides,
  };
}

test("a record missing what the store relies on is absent, never half-trusted", async () => {
  const broken: Record<string, unknown> = {
    "bg-meta-json": "{",
    "bg-meta-status": valid("bg-meta-status", { status: "paused" }),
    "bg-meta-started": valid("bg-meta-started", { startedAt: undefined }),
    "bg-meta-pid": valid("bg-meta-pid", { pid: "4242" }),
    "bg-meta-foreign": valid("bg-meta-somewhere-else"),
  };
  for (const [id, value] of Object.entries(broken)) await persisted(id, value);

  for (const id of Object.keys(broken)) assert.equal(await readMeta(parent, id), undefined, id);
  assert.deepEqual(await listRuns(parent), [], "an untrusted record must not break or appear in the run list");
});

test("wrong-typed optional fields are dropped and unknown keys ignored", async () => {
  await persisted("bg-meta-optional", valid("bg-meta-optional", {
    notified: "yes", finishedAt: "not-a-date", etaMinutes: "10", reminders: -1, futureField: true,
    note: 7, status: "done",
  }));

  const meta = await readMeta(parent, "bg-meta-optional");
  assert.ok(meta, "a record with a coherent core stays readable");
  assert.equal(meta.status, "done");
  assert.equal(meta.pid, 4242);
  for (const key of ["notified", "finishedAt", "etaMinutes", "reminders", "note"] as const) {
    assert.equal(meta[key], undefined, `${key} must not survive with the wrong type`);
  }
  assert.equal("futureField" in meta, false, "keys from another version are not promoted");
});

test("an untrusted record cannot be pruned as though it had settled", async () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  await persisted("bg-meta-untrusted", valid("bg-meta-untrusted", { startedAt: old, status: "paused" }));
  await persisted("bg-meta-settled", valid("bg-meta-settled", { startedAt: old, status: "done", notified: true }));

  const result = await pruneRuns(parent);
  assert.deepEqual(result.deleted, ["bg-meta-settled"], "the pruner still works on a readable record");
  assert.ok(existsSync(runDir(parent, "bg-meta-untrusted")), "an unreadable record keeps its files");
});
