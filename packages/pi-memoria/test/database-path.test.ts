import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { databasePath } from "../src/database-path.ts";
import { temporary } from "./helpers.ts";

// Inject the precise stat result observed on Linux during SQLite last-close:
// the syscall resolved a regular inode, then unlink made its link count zero.
// Use real unlinked descriptors rather than inventing permissive file metadata.
test("an unlinked companion stat is revalidated as absent, never accepted as a file", async t => {
  const path = join(await temporary(t), "memoria.sqlite");
  fs.writeFileSync(path, "synthetic main");
  const location = databasePath(path), original = fs.lstatSync;
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const name = path + suffix;
    fs.writeFileSync(name, "synthetic companion");
    const fd = fs.openSync(name, "r"); fs.unlinkSync(name);
    const removed = fs.fstatSync(fd); fs.closeSync(fd);
    assert.equal(removed.nlink, 0); assert.ok(removed.isFile());
    let calls = 0;
    t.mock.method(fs, "lstatSync", (input: fs.PathLike) => {
      if (input === name && calls++ === 0) return removed;
      return original(input);
    });
    syncBuiltinESMExports();
    try { assert.ok(location.check()); assert.equal(calls, 2); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.deepEqual(fs.readdirSync(join(path, "..")), ["memoria.sqlite"]);
  }
});

test("main-file unlink and persistently unlinked companions remain fail-closed and bounded", async t => {
  const path = join(await temporary(t), "memoria.sqlite");
  fs.writeFileSync(path, "synthetic main");
  const location = databasePath(path), original = fs.lstatSync;
  const fd = fs.openSync(path, "r"); fs.unlinkSync(path);
  const removed = fs.fstatSync(fd); fs.closeSync(fd);
  fs.writeFileSync(path, "replacement");
  for (const name of [path, path + "-shm"]) {
    let calls = 0;
    t.mock.method(fs, "lstatSync", (input: fs.PathLike) => {
      if (input === name) { calls++; return removed; }
      return original(input);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => location.check(), /Unsafe database/u); assert.equal(calls, name === path ? 1 : 32); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
});

test("companion revalidation rejects symlink, hardlink and nonregular replacements without touching targets", async t => {
  const dir = await temporary(t), path = join(dir, "memoria.sqlite"), outside = join(dir, "outside");
  fs.writeFileSync(path, "synthetic main", { mode: 0o644 }); fs.writeFileSync(outside, "preserve", { mode: 0o644 });
  const location = databasePath(path), original = fs.lstatSync;
  const mode = fs.statSync(outside).mode;
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const name = path + suffix;
    for (const kind of ["symlink", "hardlink", "directory"]) {
      fs.writeFileSync(name, "synthetic companion");
      const fd = fs.openSync(name, "r"); fs.unlinkSync(name);
      const removed = fs.fstatSync(fd); fs.closeSync(fd);
      if (kind === "symlink") fs.symlinkSync(outside, name);
      else if (kind === "hardlink") fs.linkSync(outside, name);
      else fs.mkdirSync(name);
      let calls = 0;
      t.mock.method(fs, "lstatSync", (input: fs.PathLike) => {
        if (input === name && calls++ === 0) return removed;
        return original(input);
      });
      syncBuiltinESMExports();
      try { assert.throws(() => location.check(), /Unsafe database/u); assert.equal(calls, 2); }
      finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(name, { recursive: kind === "directory" }); }
      assert.equal(fs.readFileSync(outside, "utf8"), "preserve"); assert.equal(fs.statSync(outside).mode, mode);
      assert.equal(fs.readFileSync(path, "utf8"), "synthetic main");
    }
  }
});

test("inspection restarts when a companion disappears before open or after opening the same inode", async t => {
  const path = join(await temporary(t), "memoria.sqlite");
  fs.writeFileSync(path, "synthetic main");
  const location = databasePath(path), original = fs.openSync;
  for (const phase of ["before", "after"]) {
    const name = path + "-wal"; fs.writeFileSync(name, "synthetic companion");
    let intercepted = false, copies = 0;
    t.mock.method(fs, "openSync", (input: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (input === name && !intercepted) {
        intercepted = true;
        if (phase === "before") fs.unlinkSync(name);
        const fd = original(input, flags, mode);
        if (phase === "after") fs.unlinkSync(name);
        return fd;
      }
      if (String(input).endsWith("inspect.sqlite")) copies++;
      return original(input, flags, mode);
    });
    syncBuiltinESMExports();
    try {
      location.inspect(snapshot => {
        assert.equal(fs.readFileSync(snapshot, "utf8"), "synthetic main");
        assert.equal(fs.existsSync(snapshot + "-wal"), false);
      });
      assert.ok(intercepted); assert.equal(copies, 2, "a fresh main snapshot must be copied after companion unlink");
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
});

test("inspection does not retry a different inode, hardlinked descriptor or arbitrary open failure", async t => {
  const dir = await temporary(t), path = join(dir, "memoria.sqlite"), name = path + "-wal", outside = join(dir, "outside");
  fs.writeFileSync(path, "main"); fs.writeFileSync(outside, "preserve", { mode: 0o644 });
  const location = databasePath(path), original = fs.openSync;
  for (const kind of ["replacement", "hardlink", "permission"]) {
    fs.writeFileSync(name, "companion");
    let calls = 0;
    t.mock.method(fs, "openSync", (input: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (input === name) {
        calls++;
        if (kind === "permission") throw Object.assign(new Error("denied"), { code: "EACCES" });
        if (kind === "replacement") {
          const held = original(input, flags, mode);
          try { fs.unlinkSync(name); fs.copyFileSync(outside, name); return original(input, flags, mode); }
          finally { fs.closeSync(held); }
        }
        fs.linkSync(name, join(dir, "alias"));
      }
      return original(input, flags, mode);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => location.inspect(() => assert.fail("must not attest an unsafe copy")), kind === "permission" ? /denied/u : /identity/u); assert.equal(calls, 1); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(name); fs.rmSync(join(dir, "alias"), { force: true }); }
    assert.equal(fs.readFileSync(outside, "utf8"), "preserve"); assert.equal(fs.readFileSync(path, "utf8"), "main");
  }
});
