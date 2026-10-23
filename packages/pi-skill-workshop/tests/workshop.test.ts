import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { workshopPaths } from "../src/config.ts";
import { privateDir } from "../src/files.ts";
import { SkillWorkshop, type WorkshopAction, type WorkshopRequest } from "../src/workshop.ts";
import { collectGarbage } from "../src/snapshots.ts";
import { VERSION_RE } from "../src/validation.ts";
import { changes, exists, fixture, mode, skillText, versions, walk } from "./helpers.ts";

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function blobFile(state: string, hash: string): string {
  return join(state, "blobs", hash.slice(0, 2), hash);
}

function manifestFile(state: string, name: string, version: string): string {
  return join(state, "manifests", name, `${version}.json`);
}

interface FingerprintEntry {
  path: string;
  kind: "dir" | "file";
  mode: number;
  hash: string;
  size: number;
}

async function fingerprint(path: string, prefix = ""): Promise<FingerprintEntry[]> {
  const info = await stat(path);
  const entries: FingerprintEntry[] = [{
    path: prefix || ".", kind: "dir", mode: info.mode & 0o777, hash: "", size: 0,
  }];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      entries.push(...await fingerprint(child, rel));
      continue;
    }
    if (!entry.isFile()) throw new Error(`unexpected entry in fingerprint: ${rel}`);
    const data = await readFile(child);
    entries.push({
      path: rel,
      kind: "file",
      mode: (await stat(child)).mode & 0o777,
      hash: sha256(data),
      size: data.length,
    });
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await treeBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

async function writeFeed(state: string, entries: Record<string, unknown>[]): Promise<void> {
  await writeFile(join(state, "changes.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

async function rejectsClean(work: () => unknown | Promise<unknown>, pattern?: RegExp): Promise<void> {
  await assert.rejects(async () => { await work(); }, (error: unknown) => {
    assert.ok(error instanceof Error, "expected an Error");
    if (pattern) assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /\n\s+at /, "error message must not contain a stack trace");
    return true;
  });
}

function setup(workshop: SkillWorkshop, name: string, text = skillText(name)): void {
  workshop.execute("create", { action: "create", name, content: text, reason: "test create" });
}

test("create, patch and undo are exact and leave no workshop metadata", async (t) => {
  const { base, root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  const call = (action: WorkshopAction, input: Omit<WorkshopRequest, "action"> = {}) =>
    workshop.execute(action, { action, ...input });

  const original = skillText();
  setup(workshop, "alpha", original);
  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), original);

  call("patch", { name: "alpha", old: "Body.", new: "Changed body.", reason: "test patch" });
  assert.match(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), /Changed body\./);

  call("undo");

  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), original);
  assert.deepEqual((await walk(root)).filter((path) => path.endsWith(".workshop-reason")), []);
  assert.deepEqual((await walk(state)).filter((path) => path.endsWith(".workshop-reason")), []);
  assert.deepEqual((await import("node:fs/promises").then((fs) => fs.readdir(root))).filter((name) => name.startsWith(".workshop-")), []);
  assert.equal(await mode(state), 0o700);
  assert.equal(await mode(join(state, "versions")), 0o700);
  assert.equal(await mode(join(state, "versions", "alpha")), 0o700);
  assert.ok(await exists(join(base, "skills", "alpha")));
});

test("archive then undo restores the live skill and removes the archive copy", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  const original = skillText();
  setup(workshop, "alpha", original);

  workshop.execute("archive", { action: "archive", name: "alpha", reason: "test archive" });
  assert.equal(await exists(join(root, "alpha")), false);
  assert.equal(await exists(join(state, "archive", "alpha")), true);
  assert.equal(await mode(join(state, "archive")), 0o700);
  assert.equal(await mode(join(state, "archive", "alpha")), 0o700);

  workshop.execute("undo", { action: "undo" });

  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), original);
  assert.equal(await exists(join(state, "archive", "alpha")), false);
  const feed = await changes(state);
  assert.equal(feed[feed.length - 1]?.action, "undo");
  assert.equal(await exists(join(root, "alpha", ".workshop-reason")), false);
});

test("view refuses traversal and symlink escapes", async (t) => {
  const { base, root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  const secret = join(base, "secret.txt");
  await writeFile(secret, "TOP SECRET\n");
  const references = join(root, "alpha", "references");
  await mkdir(references);
  await symlink(secret, join(references, "leak.txt"));

  for (const rel of ["../../secret.txt", secret, "references/../../secret.txt", "references/leak.txt"]) {
    await rejectsClean(() => workshop.execute("view", { action: "view", name: "alpha", file: rel }));
  }
  await rejectsClean(() => workshop.execute("view", { action: "view", name: "alpha", version: "../../etc" }), /invalid version id/);
});

test("restore refuses a traversing version id and leaves the archive alone", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  workshop.execute("patch", { action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "test" });
  workshop.execute("archive", { action: "archive", name: "alpha", reason: "test archive" });

  await rejectsClean(
    () => workshop.execute("restore", { action: "restore", name: "alpha", version: "../../etc" }),
    /invalid version id/,
  );

  assert.equal(await exists(join(root, "alpha")), false);
  assert.equal(await exists(join(root, "etc")), false);
  assert.equal(await exists(join(state, "archive", "alpha")), true);
});

test("patch rejects missing and conflicting arguments without changing anything", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  const before = await readFile(join(root, "alpha", "SKILL.md"), "utf8");

  await rejectsClean(
    () => workshop.execute("patch", { action: "patch", name: "alpha", old: "Body." }),
    /requires exactly one of new or new_file/,
  );
  await rejectsClean(
    () => workshop.execute("patch", { action: "patch", name: "alpha", new: "Changed." }),
    /requires exactly one of old or old_file/,
  );
  await rejectsClean(
    () => workshop.execute("patch", { action: "patch", name: "alpha" }),
    /requires exactly one of old or old_file/,
  );
  await rejectsClean(
    () => workshop.execute("patch", {
      action: "patch", name: "alpha", old: "Body.", new: "Changed.",
      old_file: join(root, "alpha", "SKILL.md"),
    }),
    /requires exactly one of old or old_file/,
  );

  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), before);
});

test("restoring a version works and records usage", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  const original = skillText();
  setup(workshop, "alpha", original);
  workshop.execute("patch", { action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "test patch" });
  const feed = await changes(state);
  const patch = [...feed].reverse().find((entry) => entry.action === "patch");
  assert.ok(patch);
  const version = patch.version as string;
  assert.equal(typeof version, "string");
  assert.match(version, VERSION_RE);

  await rm(join(root, "alpha"), { recursive: true });
  workshop.execute("restore", { action: "restore", name: "alpha", version });

  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), original);
  assert.equal(await exists(join(state, "usage", "alpha")), true);
  const after = await changes(state);
  assert.equal(after[after.length - 1]?.action, "restore");
  assert.match(String(after[after.length - 1]?.reason), /restored version/);
  const leftovers = (await import("node:fs/promises").then((fs) => fs.readdir(root))).filter((name) => name.startsWith(".workshop-"));
  assert.deepEqual(leftovers, []);
});

test("restoring an archive records usage", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  const original = skillText();
  setup(workshop, "alpha", original);
  workshop.execute("archive", { action: "archive", name: "alpha", reason: "test archive" });
  workshop.execute("restore", { action: "restore", name: "alpha" });

  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), original);
  assert.equal(await exists(join(state, "usage", "alpha")), true);
  assert.equal(await exists(join(state, "archive", "alpha")), false);
});

test("version retention keeps at most ten copies", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha", skillText("alpha", "v0"));

  for (let number = 1; number <= 12; number++) {
    workshop.execute("patch", {
      action: "patch", name: "alpha", old: `v${number - 1}`, new: `v${number}`, reason: `patch ${number}`,
    });
  }

  const kept = await versions(state);
  assert.equal(kept.length, 10);
  for (const version of kept) assert.match(version, VERSION_RE);
});

test("retention never prunes the version it just wrote", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha", skillText("alpha", "v0"));
  const versionsRoot = join(state, "versions", "alpha");
  for (let number = 0; number < 10; number++) {
    await mkdir(join(versionsRoot, `20991231T235959Z-${String(number).padStart(6, "0")}`), { recursive: true });
  }

  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "v0", new: "v1", reason: "keep the new snapshot",
  });
  const patch = [...await changes(state)].reverse().find((entry) => entry.action === "patch");
  assert.ok(patch);
  const id = String(patch.version);
  assert.match(id, VERSION_RE);
  assert.equal(await exists(manifestFile(state, "alpha", id)), true);
  assert.deepEqual(await readdir(join(versionsRoot, id)), []);
  assert.equal((await versions(state)).length, 10);
});

test("a failed restore leaves the live skill intact", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  const original = skillText();
  setup(workshop, "alpha", original);
  workshop.execute("patch", { action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "test patch" });
  const feed = await changes(state);
  const patch = [...feed].reverse().find((entry) => entry.action === "patch");
  assert.ok(patch);
  const versionDir = join(state, "versions", "alpha", String(patch.version));
  const socketPath = join(versionDir, "bad.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    await rejectsClean(() => workshop.execute("undo", { action: "undo" }), /could not stage restore/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  }

  const live = await readFile(join(root, "alpha", "SKILL.md"), "utf8");
  assert.match(live, /Changed\./);
  assert.notEqual(live, original);
  const leftovers = (await import("node:fs/promises").then((fs) => fs.readdir(root))).filter((name) => name.startsWith(".workshop-"));
  assert.deepEqual(leftovers, []);
});

test("write_file enforces the support-file cap", async (t) => {
  const { base, root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  const oversized = join(base, "oversized.txt");
  await writeFile(oversized, "x".repeat(256 * 1024 + 1));

  await rejectsClean(
    () => workshop.execute("write_file", {
      action: "write_file", name: "alpha", path: "references/oversized.txt", content_path: oversized,
    }),
    /exceeds/,
  );

  assert.equal(await exists(join(root, "alpha", "references", "oversized.txt")), false);
});

test("patch rejects support-file secrets and oversize replacements before publishing", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/notes.md", content: "safe\n", reason: "notes",
  });
  const notes = join(root, "alpha", "references", "notes.md");
  const before = await readFile(notes, "utf8");
  const beforeFeed = (await changes(state)).length;
  const beforeVersions = (await versions(state)).length;

  await rejectsClean(
    () => workshop.execute("patch", {
      action: "patch", name: "alpha", path: "references/notes.md",
      old: "safe", new: `sk-${"A".repeat(30)}`, reason: "leak",
    }),
    /possible literal secret/,
  );
  assert.equal(await readFile(notes, "utf8"), before);

  await rejectsClean(
    () => workshop.execute("patch", {
      action: "patch", name: "alpha", path: "references/notes.md",
      old: "safe", new: "x".repeat(256 * 1024 + 1), reason: "oversize",
    }),
    /support file exceeds/,
  );
  assert.equal(await readFile(notes, "utf8"), before);
  assert.equal((await changes(state)).length, beforeFeed, "a rejected patch must not record a change");
  assert.equal((await versions(state)).length, beforeVersions, "pre-write rejection must not leave a snapshot");
});

test("a failed post-write patch rolls the live tree back and records nothing", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/notes.md", content: "safe\n", reason: "notes",
  });
  const notes = join(root, "alpha", "references", "notes.md");
  const before = await readFile(notes, "utf8");
  // A pre-existing tree problem makes the post-write scan fail after the target
  // has been replaced. The patch must restore the previous bytes.
  await writeFile(join(root, "alpha", "references", "preexisting.md"), `ghp_${"a".repeat(30)}\n`);
  const feedBefore = (await changes(state)).filter((entry) => entry.action === "patch").length;
  const versionsBefore = (await versions(state)).length;

  await rejectsClean(
    () => workshop.execute("patch", {
      action: "patch", name: "alpha", path: "references/notes.md",
      old: "safe", new: "changed", reason: "must roll back",
    }),
    /possible literal secret/,
  );
  assert.equal(await readFile(notes, "utf8"), before);
  assert.equal((await changes(state)).filter((entry) => entry.action === "patch").length, feedBefore);
  assert.equal((await versions(state)).length, versionsBefore, "the rolled-back snapshot is not left behind");
});

test("a change-feed write failure rolls the mutation back", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/notes.md", content: "safe\n", reason: "notes",
  });
  const notes = join(root, "alpha", "references", "notes.md");
  const before = await readFile(notes, "utf8");
  const versionsBefore = (await versions(state)).length;
  await rm(join(state, "changes.jsonl"));
  await mkdir(join(state, "changes.jsonl"));

  await rejectsClean(
    () => workshop.execute("patch", {
      action: "patch", name: "alpha", path: "references/notes.md",
      old: "safe", new: "changed", reason: "record failure",
    }),
    /directory|EISDIR/i,
  );
  assert.equal(await readFile(notes, "utf8"), before);
  assert.equal((await versions(state)).length, versionsBefore);
});

test("archive and restore roll back when the change feed cannot be written", async (t) => {
  const first = await fixture(t);
  const archivist = new SkillWorkshop({ root: first.root, state: first.state });
  setup(archivist, "alpha");
  await rm(join(first.state, "changes.jsonl"));
  await mkdir(join(first.state, "changes.jsonl"));
  await rejectsClean(
    () => archivist.execute("archive", { action: "archive", name: "alpha", reason: "record must fail" }),
    /directory|EISDIR/i,
  );
  assert.equal(await exists(join(first.root, "alpha")), true, "a failed archive keeps the live skill");
  assert.equal(await exists(join(first.state, "archive", "alpha")), false);

  const second = await fixture(t);
  const restorer = new SkillWorkshop({ root: second.root, state: second.state });
  setup(restorer, "alpha");
  restorer.execute("archive", { action: "archive", name: "alpha", reason: "prepare archive" });
  await rm(join(second.state, "changes.jsonl"));
  await mkdir(join(second.state, "changes.jsonl"));
  await rejectsClean(
    () => restorer.execute("restore", { action: "restore", name: "alpha" }),
    /directory|EISDIR/i,
  );
  assert.equal(await exists(join(second.root, "alpha")), false, "a failed restore leaves the archive in place");
  assert.equal(await exists(join(second.state, "archive", "alpha")), true);
});

test("default paths derive from the agent directory, not a hard-coded /root", () => {
  const configured = workshopPaths({ PI_CODING_AGENT_DIR: "/tmp/synthetic-pi-agent" });
  assert.equal(configured.root, join("/tmp/synthetic-pi-agent", "skills", "skill-workshop"));
  assert.equal(configured.state, join("/tmp/synthetic-pi-agent", "skill-workshop"));
  const fallback = workshopPaths({});
  assert.equal(fallback.root, join(homedir(), ".pi", "agent", "skills", "skill-workshop"));
  assert.equal(fallback.state, join(homedir(), ".pi", "agent", "skill-workshop"));
  const homeFallback = workshopPaths({ HOME: "/tmp/synthetic-home" });
  assert.equal(homeFallback.root, join("/tmp/synthetic-home", ".pi", "agent", "skills", "skill-workshop"));
  const tilde = workshopPaths({ HOME: "/tmp/synthetic-home", PI_CODING_AGENT_DIR: "~/custom-agent" });
  assert.equal(tilde.root, join("/tmp/synthetic-home", "custom-agent", "skills", "skill-workshop"));
  const overridden = workshopPaths({
    PI_CODING_AGENT_DIR: "/tmp/ignored-agent",
    PI_SKILL_WORKSHOP_ROOT: "/tmp/explicit-root",
    PI_SKILL_WORKSHOP_STATE: "/tmp/explicit-state",
  });
  assert.deepEqual(overridden, { root: "/tmp/explicit-root", state: "/tmp/explicit-state" });
  assert.throws(() => workshopPaths({ PI_CODING_AGENT_DIR: "relative/agent" }), /absolute path/);
});

test("state paths reject symlinks and pre-existing directories keep their mode", async (t) => {
  const { base, root, state } = await fixture(t);
  const shared = join(base, "shared-state");
  await mkdir(shared);
  await chmod(shared, 0o755);
  assert.equal(privateDir(shared), shared);
  assert.equal((await stat(shared)).mode & 0o777, 0o755, "an existing directory must not be chmodded");

  await rm(state, { recursive: true, force: true });
  await symlink(shared, state);
  assert.throws(() => new SkillWorkshop({ root, state }), /symbolic link/);

  const realState = join(root, "inside-state");
  await mkdir(realState);
  const link = join(base, "parent-link");
  await symlink(root, link);
  assert.throws(
    () => new SkillWorkshop({ root, state: join(link, "inside-state") }),
    /outside the managed skills root after resolving symlinks/,
  );
});

test("the change feed is serialized across processes without losing entries", async (t) => {
  const { base, root, state } = await fixture(t);
  const script = join(base, "writer.mjs");
  await writeFile(script, `
    import { SkillWorkshop } from ${JSON.stringify(new URL("../src/workshop.ts", import.meta.url).href)};
    const workshop = new SkillWorkshop({ root: process.argv[2], state: process.argv[3] });
    const tag = process.argv[4];
    for (let index = 0; index < 8; index++) {
      const name = \`worker-\${tag}-\${index}\`;
      workshop.execute("create", {
        action: "create", name,
        content: \`---\nname: \${name}\ndescription: Use when testing \${name}.\n---\nBody.\n\`,
        reason: \`created \${name}\`,
      });
    }
  `);
  const run = (tag: string) => new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, root, state, tag], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? done() : reject(new Error(`writer ${tag} failed: ${stderr}`)));
  });
  await Promise.all([run("a"), run("b")]);
  assert.equal((await readdir(root)).filter((name) => name.startsWith("worker-")).length, 16);
  const feed = await changes(state);
  assert.equal(feed.length, 16);
  assert.equal(new Set(feed.map((entry) => entry.id)).size, 16);
});

test("validation rejects literal secrets and oversized SKILL.md content", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });

  await rejectsClean(
    () => workshop.execute("create", {
      action: "create", name: "leaky", content: skillText("leaky", `token ghp_${"a".repeat(30)}`),
    }),
    /possible literal secret/,
  );
  assert.equal(await exists(join(root, "leaky")), false);

  await rejectsClean(
    () => workshop.execute("create", {
      action: "create", name: "big", content: skillText("big", "x".repeat(40_001)),
    }),
    /exceeds 40000 bytes/,
  );
  assert.equal(await exists(join(root, "big")), false);

  setup(workshop, "alpha");
  await rejectsClean(
    () => workshop.execute("write_file", {
      action: "write_file", name: "alpha", path: "references/leak.txt", content: `ghp_${"a".repeat(30)}`,
    }),
    /possible literal secret at input line 1/,
  );
  assert.equal(await exists(join(root, "alpha", "references", "leak.txt")), false);
  assert.equal((await versions(state)).length, 0);
});

test("undo rejects malformed change ids", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  for (const id of ["../../etc", "abc", "ZZZZZZZZZZZZ"]) {
    await rejectsClean(
      () => workshop.execute("undo", { action: "undo", id }),
      /invalid change id/,
    );
  }
});

test("write_file rewrites SKILL.md with validation and can undo the rewrite", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  const original = skillText();
  setup(workshop, "alpha", original);

  await rejectsClean(
    () => workshop.execute("write_file", { action: "write_file", name: "alpha", content: "not frontmatter" }),
    /missing YAML frontmatter/,
  );
  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), original);

  const rewritten = skillText("alpha", "Rewritten.");
  workshop.execute("write_file", { action: "write_file", name: "alpha", content: rewritten, reason: "rewrite" });
  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), rewritten);
  const feed = await changes(state);
  assert.equal(feed[feed.length - 1]?.action, "write_file");

  workshop.execute("undo", { action: "undo" });
  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), original);
});

test("support files can be written and removed, and changes are newest first", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/note.txt", content: "hello", reason: "note",
  });
  assert.equal(await readFile(join(root, "alpha", "references", "note.txt"), "utf8"), "hello");

  workshop.execute("remove_file", { action: "remove_file", name: "alpha", path: "references/note.txt", reason: "remove note" });
  assert.equal(await exists(join(root, "alpha", "references", "note.txt")), false);

  setup(workshop, "beta");
  const latest = workshop.execute("changes", { action: "changes", limit: 1 });
  assert.match(latest, /beta/);
  assert.doesNotMatch(latest, /alpha/);
  const alphaOnly = workshop.execute("changes", { action: "changes", name: "alpha", limit: 20 });
  for (const line of alphaOnly.split("\n")) assert.match(line, /alpha/);
});

test("cleanup enforces the daily marker, dry-run and pinned exemption", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "pinned", skillText("pinned", "Body.", "pinned: true\n"));
  setup(workshop, "old", skillText("old"));
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await utimes(join(root, "old", "SKILL.md"), old, old);

  const dry = workshop.execute("cleanup", { action: "cleanup", days: 1, dry_run: true });
  assert.match(dry, /would archive old \(idle\)/);
  assert.equal(await exists(join(state, "last-cleanup")), false);

  const cleaned = workshop.execute("cleanup", { action: "cleanup", days: 1 });
  assert.match(cleaned, /archived old/);
  assert.equal(await exists(join(root, "pinned")), true);
  assert.equal(await exists(join(root, "old")), false);
  assert.equal(await exists(join(state, "archive", "old")), true);
  assert.equal(await exists(join(state, "last-cleanup")), true);
  const feed = await changes(state);
  assert.equal(feed[feed.length - 1]?.action, "archive");
  assert.equal(feed[feed.length - 1]?.actor, "curator");

  assert.equal(workshop.execute("cleanup", { action: "cleanup", days: 1 }), "cleanup already ran today");
  await access(join(state, "archive", "old"));
});

test("hash-addressed snapshots store an unchanged payload once and materialize exact trees", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  const live = join(root, "alpha");
  await chmod(live, 0o755);
  await mkdir(join(live, "assets"));
  await chmod(join(live, "assets"), 0o750);
  const payload = randomBytes(3 * 1024 * 1024);
  const asset = join(live, "assets", "big.bin");
  await writeFile(asset, payload);
  await chmod(asset, 0o640);

  const first = await fingerprint(live);
  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/one.txt", content: "one", reason: "first",
  });
  const second = await fingerprint(live);
  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/two.txt", content: "two", reason: "second",
  });

  const snapshots = (await changes(state))
    .filter((entry) => entry.action === "write_file")
    .map((entry) => String(entry.version));
  assert.equal(snapshots.length, 2);
  const firstId = snapshots[0];
  const secondId = snapshots[1];
  assert.ok(firstId && secondId);
  assert.deepEqual((await versions(state)).sort(), [...snapshots].sort());
  for (const id of snapshots) {
    assert.deepEqual(await readdir(join(state, "versions", "alpha", id)), []);
    assert.ok(await exists(manifestFile(state, "alpha", id)), "every version has a manifest in the sibling store");
  }

  const payloadHash = sha256(payload);
  assert.ok(await exists(blobFile(state, payloadHash)), "the payload must have exactly one blob");
  assert.equal((await stat(blobFile(state, payloadHash))).size, payload.length);
  assert.equal(await mode(blobFile(state, payloadHash)), 0o600);
  assert.equal(await mode(dirname(blobFile(state, payloadHash))), 0o700);
  assert.equal(await mode(join(state, "blobs")), 0o700);
  assert.equal(await mode(join(state, "manifests")), 0o700);
  assert.equal(await mode(join(state, "manifests", "alpha")), 0o700);
  assert.equal(await mode(manifestFile(state, "alpha", firstId)), 0o600);
  assert.equal(await mode(join(state, "versions", "alpha", firstId)), 0o700);
  const stored = await treeBytes(state);
  assert.ok(stored < payload.length * 1.5, `state grew to ${stored} bytes for one ${payload.length}-byte payload`);
  assert.ok(stored < payload.length * 2, "two versions must not duplicate the unchanged payload");

  await rm(live, { recursive: true });
  workshop.execute("restore", { action: "restore", name: "alpha", version: firstId });
  assert.deepEqual(await fingerprint(live), first);
  assert.deepEqual(await readFile(asset), payload);
  assert.equal(await mode(asset), 0o640);
  assert.equal(await mode(join(live, "assets")), 0o750);
  assert.equal(await exists(join(live, "references", "one.txt")), false);

  await rm(live, { recursive: true });
  workshop.execute("restore", { action: "restore", name: "alpha", version: secondId });
  assert.deepEqual(await fingerprint(live), second);
  assert.equal(await readFile(join(live, "references", "one.txt"), "utf8"), "one");
  assert.equal(await exists(join(live, "references", "two.txt")), false);
  assert.deepEqual(await readFile(asset), payload);
});

test("a changed support file creates a new blob and hashed versions expose old bytes", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  const live = join(root, "alpha");

  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/note.txt", content: "v1", reason: "one",
  });
  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/note.txt", content: "v2", reason: "two",
  });
  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/note.txt", content: "v3", reason: "three",
  });
  const entries = (await changes(state)).filter((entry) => entry.action === "write_file");
  const version = entries[1]?.version;
  assert.equal(typeof version, "string");
  assert.match(String(version), VERSION_RE);

  assert.equal(
    workshop.execute("view", { action: "view", name: "alpha", version: String(version), file: "references/note.txt" }),
    "v1",
  );
  await rejectsClean(
    () => workshop.execute("view", { action: "view", name: "alpha", version: String(version), file: "manifest.json" }),
    /not found/,
  );
  assert.ok(await exists(blobFile(state, sha256("v1"))));
  assert.ok(await exists(blobFile(state, sha256("v2"))));
  assert.equal(await exists(blobFile(state, sha256("v3"))), false);

  await rm(live, { recursive: true });
  workshop.execute("restore", { action: "restore", name: "alpha", version: String(version) });
  assert.equal(await readFile(join(live, "references", "note.txt"), "utf8"), "v1");
});

test("undo and restore from hashed versions rebuild the exact live tree", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  const live = join(root, "alpha");
  await chmod(live, 0o755);
  workshop.execute("write_file", {
    action: "write_file", name: "alpha", path: "references/kept.txt", content: "kept", reason: "support file",
  });
  const expected = await fingerprint(live);
  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "changed",
  });
  const patch = [...await changes(state)].reverse().find((entry) => entry.action === "patch");
  assert.ok(patch);
  const version = String(patch.version);
  assert.match(version, VERSION_RE);

  workshop.execute("undo", { action: "undo" });
  assert.deepEqual(await fingerprint(live), expected);

  await rm(live, { recursive: true });
  workshop.execute("restore", { action: "restore", name: "alpha", version });
  assert.deepEqual(await fingerprint(live), expected);
});

test("a missing blob fails closed and leaves the live tree intact", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  const original = skillText();
  setup(workshop, "alpha", original);
  const live = join(root, "alpha");
  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "changed",
  });
  const patch = [...await changes(state)].reverse().find((entry) => entry.action === "patch");
  assert.ok(patch);
  const version = String(patch.version);
  await rm(blobFile(state, sha256(original)));

  const before = await fingerprint(live);
  await rejectsClean(() => workshop.execute("undo", { action: "undo" }), /missing blob/);
  assert.deepEqual(await fingerprint(live), before);
  assert.match(await readFile(join(live, "SKILL.md"), "utf8"), /Changed\./);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".workshop-")), []);

  await rm(live, { recursive: true });
  await rejectsClean(
    () => workshop.execute("restore", { action: "restore", name: "alpha", version }),
    /missing blob/,
  );
  assert.equal(await exists(live), false);
});

test("legacy full-copy version directories still view, restore and undo", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha");
  const live = join(root, "alpha");
  const legacyId = "20260101T000000Z-abcdef";
  const legacyText = skillText("alpha", "Legacy body.");
  const legacyDir = join(state, "versions", "alpha", legacyId);
  await mkdir(join(legacyDir, "references"), { recursive: true });
  await writeFile(join(legacyDir, "SKILL.md"), legacyText);
  await chmod(join(legacyDir, "SKILL.md"), 0o640);
  await writeFile(join(legacyDir, "references", "legacy.txt"), "legacy support");
  await chmod(join(legacyDir, "references", "legacy.txt"), 0o600);

  assert.equal(workshop.execute("view", { action: "view", name: "alpha", version: legacyId }), legacyText);
  assert.equal(
    workshop.execute("view", { action: "view", name: "alpha", version: legacyId, file: "references/legacy.txt" }),
    "legacy support",
  );
  await rm(live, { recursive: true });
  workshop.execute("restore", { action: "restore", name: "alpha", version: legacyId });
  assert.equal(await readFile(join(live, "SKILL.md"), "utf8"), legacyText);
  assert.equal(await mode(join(live, "SKILL.md")), 0o640);
  assert.equal(await readFile(join(live, "references", "legacy.txt"), "utf8"), "legacy support");

  await writeFile(join(live, "SKILL.md"), skillText("alpha", "Current body."));
  await writeFeed(state, [{
    id: "abcdefabcdef",
    ts: "2026-01-02T00:00:00Z",
    actor: "eve",
    action: "patch",
    skill: "alpha",
    reason: "legacy baseline",
    version: legacyId,
  }]);
  workshop.execute("undo", { action: "undo" });
  assert.equal(await readFile(join(live, "SKILL.md"), "utf8"), legacyText);
});

test("garbage collection removes unreferenced blobs and keeps referenced ones", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha", skillText("alpha", "v0"));
  const live = join(root, "alpha");
  await mkdir(join(live, "references"));
  await writeFile(join(live, "references", "stable.txt"), "stable");

  for (let number = 1; number <= 12; number++) {
    workshop.execute("patch", {
      action: "patch", name: "alpha", old: `v${number - 1}`, new: `v${number}`, reason: `patch ${number}`,
    });
  }
  const kept = await versions(state);
  assert.equal(kept.length, 10);
  const entries = (await changes(state)).filter((entry) => entry.action === "patch");
  assert.equal(entries.length, 12);
  const snapshots = entries.map((entry) => ({
    id: String(entry.version),
    content: String(entry.reason).replace(/^patch /, ""),
  }));
  const pruned = snapshots.filter((snapshot) => !kept.includes(snapshot.id));
  assert.equal(pruned.length, 2);
  for (const snapshot of pruned) {
    const hash = sha256(skillText("alpha", `v${Number(snapshot.content) - 1}`));
    assert.equal(await exists(manifestFile(state, "alpha", snapshot.id)), false, `manifest for pruned version ${snapshot.id} survived`);
    assert.equal(await exists(blobFile(state, hash)), false, `unreferenced blob for v${Number(snapshot.content) - 1} survived`);
  }
  for (const snapshot of snapshots.filter((candidate) => kept.includes(candidate.id))) {
    const hash = sha256(skillText("alpha", `v${Number(snapshot.content) - 1}`));
    assert.equal(await exists(manifestFile(state, "alpha", snapshot.id)), true, `manifest for kept version ${snapshot.id} was removed`);
    assert.ok(await exists(blobFile(state, hash)), `reachable blob for v${Number(snapshot.content) - 1} was removed`);
  }
  assert.ok(await exists(blobFile(state, sha256("stable"))), "a shared support blob must survive");
});

test("an unreadable manifest disables garbage collection", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha", skillText("alpha", "v0"));

  for (let number = 1; number <= 10; number++) {
    workshop.execute("patch", {
      action: "patch", name: "alpha", old: `v${number - 1}`, new: `v${number}`, reason: `patch ${number}`,
    });
  }
  const before = await versions(state);
  assert.equal(before.length, 10);
  const hashes = new Map<string, string>();
  for (const id of before) {
    const manifest = JSON.parse(
      await readFile(manifestFile(state, "alpha", id), "utf8"),
    ) as { files: { path: string; hash: string }[] };
    const skill = manifest.files.find((file) => file.path === "SKILL.md");
    assert.ok(skill);
    hashes.set(id, skill.hash);
  }
  // Sort order is oldest-first by version id, so retention prunes before[0]
  // and this corrupted manifest is guaranteed to survive into the GC pass.
  const corrupt = before[1];
  assert.ok(corrupt);
  await writeFile(manifestFile(state, "alpha", corrupt), "{ not json\n");

  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "v10", new: "v11", reason: "patch 11",
  });
  const after = await versions(state);
  assert.equal(after.length, 10);
  const patch11 = [...await changes(state)].reverse().find((entry) => entry.reason === "patch 11");
  assert.ok(patch11);
  const newId = String(patch11.version);
  const pruned = [...new Set([...before, newId])].filter((id) => !after.includes(id));
  assert.equal(pruned.length, 1);
  const prunedId = pruned[0];
  assert.ok(prunedId);
  assert.ok(after.includes(corrupt), "the corrupted manifest must survive retention");
  assert.equal(await exists(manifestFile(state, "alpha", prunedId)), false);
  // Retention prunes the lexicographically first old version id, so before[1]
  // is guaranteed to survive. Its blob must stay while GC is disabled.
  const hash = hashes.get(prunedId) ?? sha256(skillText("alpha", "v10"));
  assert.ok(
    await exists(blobFile(state, hash)),
    "GC must not delete blobs while any surviving manifest is unreadable",
  );
});

test("snapshots still refuse symlinks and unsupported file types", async (t) => {
  const { base, root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  const original = skillText();
  setup(workshop, "alpha", original);
  const live = join(root, "alpha");
  await mkdir(join(live, "references"));
  const outside = join(base, "outside.txt");
  await writeFile(outside, "outside\n");
  const link = join(live, "references", "leak.txt");
  await symlink(outside, link);

  await rejectsClean(
    () => workshop.execute("patch", {
      action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "symlink",
    }),
    /symlink refused/,
  );
  assert.equal(await readFile(join(live, "SKILL.md"), "utf8"), original);
  assert.deepEqual(await versions(state), []);
  await rm(link);

  const socketPath = join(live, "bad.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    await rejectsClean(
      () => workshop.execute("patch", {
        action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "socket",
      }),
      /unsupported file type/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
  assert.equal(await readFile(join(live, "SKILL.md"), "utf8"), original);
  assert.deepEqual(await versions(state), []);

  const oddName = join(live, "references", "back\\slash.txt");
  await writeFile(oddName, "odd\n");
  await rejectsClean(
    () => workshop.execute("patch", {
      action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "odd name",
    }),
    /unsafe path in version manifest/,
  );
  assert.equal(await readFile(join(live, "SKILL.md"), "utf8"), original);
  assert.deepEqual(await versions(state), []);
  await rm(oddName, { force: true });
});

test("a live root manifest.json is ordinary skill content across snapshot, view, restore and undo", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha", skillText("alpha", "Body."));
  const live = join(root, "alpha");
  const userManifest = '{\n  "owner": "skill",\n  "note": "ordinary user content ✓"\n}\n';
  const manifestPath = join(live, "manifest.json");
  await writeFile(manifestPath, userManifest);
  await chmod(manifestPath, 0o640);
  const before = await fingerprint(live);

  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "root manifest",
  });
  const patch = [...await changes(state)].reverse().find((entry) => entry.action === "patch");
  assert.ok(patch);
  const version = String(patch.version);
  assert.match(version, VERSION_RE);

  assert.deepEqual(await readdir(join(state, "versions", "alpha", version)), []);
  assert.equal(await mode(join(state, "versions", "alpha", version)), 0o700);
  assert.equal(await mode(manifestFile(state, "alpha", version)), 0o600);
  const stored = JSON.parse(await readFile(manifestFile(state, "alpha", version), "utf8")) as {
    files: { path: string; size: number }[];
  };
  const entry = stored.files.find((file) => file.path === "manifest.json");
  assert.ok(entry);
  assert.equal(entry.size, Buffer.byteLength(userManifest));

  assert.equal(
    workshop.execute("view", { action: "view", name: "alpha", version, file: "manifest.json" }),
    userManifest,
  );

  await writeFile(manifestPath, "changed user data\n");
  workshop.execute("undo", { action: "undo" });
  assert.deepEqual(await fingerprint(live), before);
  assert.equal(await readFile(manifestPath, "utf8"), userManifest);
  assert.equal(await mode(manifestPath), 0o640);

  await rm(live, { recursive: true });
  workshop.execute("restore", { action: "restore", name: "alpha", version });
  assert.deepEqual(await fingerprint(live), before);
  assert.equal(await readFile(manifestPath, "utf8"), userManifest);
});

test("an empty version marker without a manifest fails closed", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha", skillText());
  const live = join(root, "alpha");
  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "changed",
  });
  const patch = [...await changes(state)].reverse().find((entry) => entry.action === "patch");
  assert.ok(patch);
  const version = String(patch.version);
  await rm(manifestFile(state, "alpha", version));

  const before = await fingerprint(live);
  await rejectsClean(() => workshop.execute("undo", { action: "undo" }), /no files and no manifest/);
  assert.deepEqual(await fingerprint(live), before);

  await rm(live, { recursive: true });
  await rejectsClean(
    () => workshop.execute("restore", { action: "restore", name: "alpha", version }),
    /no files and no manifest/,
  );
  assert.equal(await exists(live), false);
});

test("corrupt, traversing and duplicate manifests fail closed without modifying the live tree", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha", skillText());
  const live = join(root, "alpha");
  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "Body.", new: "Changed.", reason: "changed",
  });
  const patch = [...await changes(state)].reverse().find((entry) => entry.action === "patch");
  assert.ok(patch);
  const version = String(patch.version);
  const path = manifestFile(state, "alpha", version);
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    files: { path: string; hash: string; mode: number; size: number }[];
  };
  const first = parsed.files[0];
  assert.ok(first);
  const variants: [string, RegExp][] = [
    ["{ not json\n", /invalid version manifest/],
    [
      `${JSON.stringify({
        ...parsed,
        files: parsed.files.map((file, index) => index === 0 ? { ...file, path: "../escape.txt" } : file),
      })}\n`,
      /unsafe path in version manifest/,
    ],
    [
      `${JSON.stringify({ ...parsed, files: [...parsed.files, first] })}\n`,
      /duplicate path in version manifest/,
    ],
  ];
  const before = await fingerprint(live);
  for (const [content, pattern] of variants) {
    await writeFile(path, content);
    await rejectsClean(() => workshop.execute("undo", { action: "undo" }), pattern);
    assert.deepEqual(await fingerprint(live), before);
    assert.match(await readFile(join(live, "SKILL.md"), "utf8"), /Changed\./);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".workshop-")), []);
  }

  await rm(live, { recursive: true });
  await writeFile(path, "{ not json\n");
  await rejectsClean(
    () => workshop.execute("restore", { action: "restore", name: "alpha", version }),
    /invalid version manifest/,
  );
  assert.equal(await exists(live), false);
});

test("garbage collection aborts the whole pass on an unexpected manifest entry", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha", skillText("alpha", "orphan body"));
  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "orphan body", new: "current body", reason: "snapshot",
  });
  const patch = [...await changes(state)].reverse().find((entry) => entry.action === "patch");
  assert.ok(patch);
  const version = String(patch.version);
  const orphanHash = sha256(skillText("alpha", "orphan body"));
  await rm(join(state, "versions", "alpha", version), { recursive: true });
  const stray = join(state, "manifests", "alpha", "stray.txt");
  await writeFile(stray, "stray\n");

  collectGarbage(state);
  assert.equal(await exists(manifestFile(state, "alpha", version)), true, "an ambiguous pass must not remove manifests");
  assert.ok(await exists(blobFile(state, orphanHash)), "an ambiguous pass must not remove blobs");

  await rm(stray);
  collectGarbage(state);
  assert.equal(await exists(manifestFile(state, "alpha", version)), false);
  assert.equal(await exists(blobFile(state, orphanHash)), false);
});

test("garbage collection removes orphan manifests and releases only their blobs", async (t) => {
  const { root, state } = await fixture(t);
  const workshop = new SkillWorkshop({ root, state });
  setup(workshop, "alpha", skillText("alpha", "orphan body"));
  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "orphan body", new: "kept body", reason: "first",
  });
  workshop.execute("patch", {
    action: "patch", name: "alpha", old: "kept body", new: "current body", reason: "second",
  });
  const patches = (await changes(state)).filter((entry) => entry.action === "patch");
  assert.equal(patches.length, 2);
  const orphanVersion = String(patches[0]?.version);
  const keptVersion = String(patches[1]?.version);
  assert.match(orphanVersion, VERSION_RE);
  assert.match(keptVersion, VERSION_RE);
  const orphanHash = sha256(skillText("alpha", "orphan body"));
  const keptHash = sha256(skillText("alpha", "kept body"));
  assert.ok(await exists(blobFile(state, orphanHash)));
  assert.ok(await exists(blobFile(state, keptHash)));

  await rm(join(state, "versions", "alpha", orphanVersion), { recursive: true });
  collectGarbage(state);

  assert.equal(await exists(manifestFile(state, "alpha", orphanVersion)), false);
  assert.equal(await exists(join(state, "versions", "alpha", orphanVersion)), false);
  assert.equal(await exists(join(state, "versions", "alpha", keptVersion)), true);
  assert.equal(await exists(manifestFile(state, "alpha", keptVersion)), true);
  assert.equal(await exists(blobFile(state, orphanHash)), false);
  assert.ok(await exists(blobFile(state, keptHash)), "a surviving manifest still pins its blob");
});
