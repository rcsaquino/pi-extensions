import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forceKill, terminate } from "../src/launch.ts";
import { readMeta, settleMeta, type RunMeta } from "../src/store.ts";

const meta = (overrides: Partial<RunMeta> = {}): RunMeta => ({
  id: "bg-20261102-000000-aaaaaa", title: "t", parentSessionId: "parent", childSessionId: "child",
  pid: 0, cwd: tmpdir(), startedAt: "2026-11-02T00:00:00.000Z", status: "running", ...overrides,
});

test("settled status maps every exit outcome once", () => {
  assert.equal(settleMeta(meta(), 0).status, "done");
  assert.equal(settleMeta(meta(), 1).status, "failed");
  assert.equal(settleMeta(meta(), null).status, "unknown");
  assert.equal(settleMeta(meta(), null, "killed").status, "killed");
  assert.equal(settleMeta(meta(), 0, "killed").status, "killed", "an explicit kill wins over code 0");
  assert.match(settleMeta(meta(), 1).finishedAt!, /^\d{4}-\d{2}-\d{2}T/);
});

test("caller ids cannot escape the run directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "bg-id-"));
  const previous = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = root;
  try {
    for (const id of ["../../../../etc", "..", ".", "a/b", "x".repeat(65)]) assert.equal(await readMeta("parent", id), undefined, id);
    assert.equal(await readMeta("parent", meta().id), undefined, "a missing but valid id is simply absent");
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("terminate escalates to a process-group kill", { skip: process.platform === "win32" }, async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  assert.ok(child.pid);
  try {
    assert.equal(terminate(child.pid).term, true);
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.ok(code === 0 || signal === "SIGTERM", `exit ${code} ${signal}`);
    assert.equal(forceKill(child.pid), false, "an exited group cannot be killed again");
  } finally { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
});
