import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { configuration } from "../src/config.ts";
import { SessionSearch } from "../src/sessions.ts";
import { temporary } from "./helpers.ts";

const unixOnly = { skip: process.platform === "win32" ? "Synthetic executable fixtures use Unix shebangs; Windows paths are tested separately." : false };

async function fixture(t: TestContext) {
  const directory = await temporary(t);
  const agent = join(directory, "custom agent ; not a shell");
  const config = configuration(agent, { PI_MEMORIA_DIR: join(directory, "separate-memory") });
  const root = config.sessionRoots[0]!;
  const source = join(root, "a.jsonl");
  await mkdir(root, { recursive: true });
  await writeFile(source, "{}\n");
  const pathDir = join(directory, "path");
  await mkdir(pathDir);
  const originalPath = process.env.PATH;
  process.env.PATH = pathDir; // No real system or agent binary can satisfy these tests.
  t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("Network access is forbidden in ripgrep fixtures."); };
  t.after(() => { globalThis.fetch = originalFetch; assert.equal(fetchCalls, 0, "session search must not download binaries or call providers"); });
  const search = new SessionSearch(() => [root], undefined, config.ripgrepPath);
  const executable = async (path: string, id: string, code?: string) => {
    await mkdir(dirname(path), { recursive: true });
    const event = { type: "match", data: { path: { text: source }, line_number: 1, lines: { text: JSON.stringify({ type: "message", id, message: { role: "user", content: "needle" } }) + "\n" } } };
    await writeFile(path, `#!${process.execPath}\n${code ?? `if (!process.argv.includes("--no-config") || !process.argv.includes("--")) process.exit(9);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")});`}\n`, { mode: 0o700 });
    return path;
  };
  return { directory, agent, config, root, source, search, executable, pathBinary: join(pathDir, "rg") };
}

test("PATH-only rg still works when the configured managed binary is missing", unixOnly, async (t) => {
  const h = await fixture(t);
  await h.executable(h.pathBinary, "path");
  const page = await h.search.search({ query: "needle" });
  assert.deepEqual(page.results.map((item) => item.entry_id), ["path"]);
  assert.equal(page.exhausted, true);
  await assert.rejects(stat(join(h.agent, "bin")), { code: "ENOENT" }, "search must not create/download a managed binary");
});

test("managed-only rg works at the custom agent root, independently of PI_MEMORIA_DIR", unixOnly, async (t) => {
  const h = await fixture(t);
  await h.executable(h.config.ripgrepPath, "managed");
  const page = await h.search.search({ query: "needle" });
  assert.deepEqual(page.results.map((item) => item.entry_id), ["managed"]);
  assert.equal(page.exhausted, true);
  await assert.rejects(stat(h.config.directory), { code: "ENOENT" });
});

test("managed rg takes precedence over PATH and explicit overrides bypass both", unixOnly, async (t) => {
  const h = await fixture(t);
  await h.executable(h.config.ripgrepPath, "managed");
  await h.executable(h.pathBinary, "path");
  assert.equal((await h.search.search({})).results[0]?.entry_id, "managed");
  const explicit = await h.executable(join(h.directory, "explicit rg"), "explicit");
  const search = new SessionSearch(() => [h.root], explicit, h.config.ripgrepPath);
  assert.equal((await search.search({})).results[0]?.entry_id, "explicit");
  await assert.rejects(new SessionSearch(() => [h.root], join(h.directory, "missing-explicit"), h.config.ripgrepPath).search({}), /missing-explicit.*Session search is incomplete/u);
});

test("absent rg reports both checked locations and a later managed binary is recognized", unixOnly, async (t) => {
  const h = await fixture(t);
  await assert.rejects(h.search.search({}), (error: Error) => {
    assert.match(error.message, /Install rg.*PATH/u);
    assert.ok(error.message.includes(`Checked: ${h.config.ripgrepPath}, rg`));
    assert.match(error.message, /incomplete/u);
    return true;
  });
  await assert.rejects(stat(join(h.agent, "bin")), { code: "ENOENT" });
  assert.equal((await h.search.read(h.source)).line, 1, "reading a citation does not require rg");
  await h.executable(h.config.ripgrepPath, "late-managed");
  assert.equal((await h.search.search({})).results[0]?.entry_id, "late-managed");
});

test("permission and rg exit failures are not hidden by PATH fallback", unixOnly, async (t) => {
  const h = await fixture(t);
  const marker = join(h.directory, "path-was-run");
  await h.executable(h.pathBinary, "path", `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected");`);
  await h.executable(h.config.ripgrepPath, "managed");
  await chmod(h.config.ripgrepPath, 0o600);
  await assert.rejects(h.search.search({}), /EACCES/u);
  await chmod(h.config.ripgrepPath, 0o700);
  await h.executable(h.config.ripgrepPath, "managed", 'process.stderr.write("fixture failure\\n"); process.exit(2);');
  const page = await h.search.search({});
  assert.equal(page.exhausted, false);
  assert.ok(page.warnings.some((warning) => warning.includes("fixture failure")));
  assert.ok(page.warnings.some((warning) => warning.includes("exit code 2")));
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("managed child cancellation and timeout terminate the process without fallback", unixOnly, async (t) => {
  const h = await fixture(t);
  const pidFile = join(h.directory, "child.pid");
  await h.executable(h.config.ripgrepPath, "managed", `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const page = await h.search.search({ timeout_ms: 200 });
  assert.equal(page.exhausted, false);
  assert.ok(page.warnings.some((warning) => warning.includes("timed out")));
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const controller = new AbortController();
  const work = h.search.search({}, controller.signal);
  const timer = setTimeout(() => controller.abort(), 200);
  try { await assert.rejects(work, /abort/iu); } finally { clearTimeout(timer); }
  const cancelledPid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(cancelledPid, 0), { code: "ESRCH" });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(h.search.search({}, alreadyAborted.signal), /abort/iu);
});
