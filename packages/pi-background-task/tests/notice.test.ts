import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildNotice, NOTICE_EXCERPT, shouldNotify, truncate } from "../src/notice.ts";
import { formatDuration, processAlive, type RunMeta } from "../src/store.ts";

const base: RunMeta = {
  id: "bg-20261102-120000-abc123",
  title: "Test run",
  parentSessionId: "parent",
  childSessionId: "bg-20261102-120000-abc123",
  pid: process.pid,
  cwd: "/tmp",
  startedAt: new Date(Date.now() - 65_000).toISOString(),
  status: "running",
};

test("truncate keeps short text and flags long text", () => {
  assert.equal(truncate("short", 10), "short");
  const long = truncate("x".repeat(20), 10);
  assert.match(long, /^x{10}\n\[truncated\]$/);
});

test("shouldNotify silences only explicit kills", () => {
  assert.equal(shouldNotify({ status: "killed" }), false);
  for (const status of ["done", "failed", "unknown", "running"] as const) assert.equal(shouldNotify({ status }), true, status);
});

test("buildNotice carries id, status, duration and report excerpt", () => {
  const notice = buildNotice({ ...base, status: "done", finishedAt: new Date().toISOString() }, "the answer");
  assert.match(notice, /Background task finished/);
  assert.match(notice, new RegExp(base.id));
  assert.match(notice, /Status: done/);
  assert.match(notice, /the answer/);
  assert.match(notice, /background_result\("bg-20261102-120000-abc123"\)/);
});

test("buildNotice truncates a long report", () => {
  const notice = buildNotice({ ...base, status: "done", finishedAt: new Date().toISOString() }, "y".repeat(NOTICE_EXCERPT * 3));
  assert.match(notice, /\[truncated\]/);
  assert.ok(notice.length < NOTICE_EXCERPT + 700);
});

test("buildNotice handles a missing report", () => {
  const notice = buildNotice({ ...base, status: "failed", finishedAt: new Date().toISOString(), exitCode: 1 }, undefined);
  assert.match(notice, /no report output/);
  assert.match(notice, /exit 1/);
});

test("formatDuration is bounded", () => {
  assert.equal(formatDuration(new Date(0).toISOString(), new Date(30_000).toISOString()), "30s");
  assert.equal(formatDuration(new Date(0).toISOString(), new Date(90_000).toISOString()), "1m 30s");
});

test("processAlive recognises this process and rejects a dead pid", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(process.pid, "node"), true);
  assert.equal(processAlive(process.pid, "definitely-not-in-cmdline"), false);
  assert.equal(processAlive(-1), false);
  assert.equal(processAlive(999_999_999), false);
});

test("processAlive survives a rewritten process title when the launch marker is in the environment", async () => {
  const marker = `bg-test-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", 'process.title="pi"; setTimeout(() => {}, 5000)'], {
    env: { ...process.env, PI_BACKGROUND_RUN: marker },
    stdio: "ignore",
  });
  try {
    const pid = child.pid;
    assert.ok(pid, "child process must start");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker), "process title should erase the marker");
    assert.equal(processAlive(pid, marker), true);
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
  }
});
