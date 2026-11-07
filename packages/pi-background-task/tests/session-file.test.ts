import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFiles } from "../src/store.ts";

const isolated = await mkdtemp(join(tmpdir(), "pi-background-session-"));
process.env.PI_CODING_AGENT_DIR = isolated;

test("indexes forked session files by child session id once", async () => {
  const dir = join(isolated, "sessions", "--root-workspace--");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "2026-11-07T13-56-50-193Z_bg-abc123.jsonl"), "x");
  const index = await sessionFiles();
  assert.equal(index.get("bg-abc123"), join(dir, "2026-11-07T13-56-50-193Z_bg-abc123.jsonl"));
});

test("returns an empty index for an unknown run or missing session root", async () => {
  assert.equal((await sessionFiles()).get("bg-missing"), undefined);
});
