import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isInside } from "./config.ts";
import { fail, messageOf } from "./errors.ts";

export const REASON_FILE = ".workshop-reason";

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** lstat-based existence: a dangling symlink still exists and must not be overwritten. */
export function existsOrLink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isRealFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function writeText(path: string, text: string): void {
  writeFileSync(path, text);
}

/**
 * Replace a file atomically. Without an explicit mode an existing file keeps
 * its permissions and a new file uses 0644.
 */
export function atomicWriteText(path: string, text: string, options: { mode?: number } = {}): void {
  let mode = options.mode ?? 0o644;
  if (options.mode === undefined) {
    try {
      mode = lstatSync(path).mode & 0o777;
    } catch {
      // A new file uses the default mode.
    }
  }
  const temporary = join(dirname(path), `.workshop-write-${randomHex(6)}`);
  try {
    writeFileSync(temporary, text, { mode });
    renameSync(temporary, path);
  } catch (error) {
    removePath(temporary);
    throw error;
  }
}

export function removePath(path: string): void {
  if (isRealDirectory(path) && !isSymlink(path)) {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  if (!existsOrLink(path)) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (existsOrLink(path)) throw error;
  }
}

/** Reject a symlink anywhere between path and its trusted root, inclusive. */
export function refuseSymlinkChain(path: string, root: string): void {
  const trusted = resolve(root);
  let current = resolve(path);
  for (;;) {
    if (isSymlink(current)) fail(`symlink refused: ${current}`);
    if (current === trusted) return;
    const parent = dirname(current);
    if (parent === current || !isInside(trusted, current)) return;
    current = parent;
  }
}

/** Refuse symlinks anywhere in a tree, without following them. */
export function ensureNoSymlinks(path: string): void {
  if (isSymlink(path)) fail(`symlink refused: ${path}`);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) fail(`symlink refused: ${child}`);
    if (entry.isDirectory()) ensureNoSymlinks(child);
  }
}

/**
 * Create missing state directories and force every directory this call created
 * to mode 0700. A pre-existing directory is never chmodded: a mistaken shared
 * state path such as /tmp must not lose its permissions. The final component
 * may not be a symlink, and created parents are chmodded from the top down.
 */
export function privateDir(path: string): string {
  const target = resolve(path);
  if (isSymlink(target)) fail(`symlink refused: ${target}`);
  const missing: string[] = [];
  let current = target;
  while (!existsOrLink(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const directory of missing.reverse()) {
    try {
      chmodSync(directory, 0o700);
    } catch (error) {
      fail(`cannot secure state directory ${directory}: ${messageOf(error)}`);
    }
  }
  return target;
}

const LOCK_STALE_MS = 60_000;

function lockOwnerState(directory: string): "alive" | "dead" | "missing" {
  let text: string;
  try {
    text = readFileSync(join(directory, "owner"), "utf8").trim();
  } catch {
    return "missing";
  }
  const pid = Number(text);
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "alive" : "dead";
  }
}

/**
 * Cross-process advisory lock built from an atomic mkdir. A dead owner is
 * reclaimed immediately; an unreadable or stale lock is removed after the
 * bounded wait. All Skill Workshop mutations are synchronous, so the wait is a
 * short Atomics sleep rather than an event-loop spin.
 */
export function withFileLock<T>(lock: string, work: () => T, timeoutMs = 5_000): T {
  const directory = resolve(lock);
  privateDir(dirname(directory));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(directory, { mode: 0o700 });
      writeText(join(directory, "owner"), `${process.pid}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        fail(`cannot acquire state lock ${directory}: ${messageOf(error)}`);
      }
      let stale = false;
      try {
        const modified = lstatSync(directory).mtimeMs;
        stale = Date.now() - modified > LOCK_STALE_MS;
      } catch {
        continue;
      }
      // A missing owner file means another process is between mkdir and its
      // owner write; only the stale timer may reclaim that window.
      const owner = lockOwnerState(directory);
      if (stale || owner === "dead") {
        try { rmSync(directory, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) fail(`timed out waiting for the Skill Workshop state lock: ${directory}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return work();
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Copy a skill tree. Metadata files are deliberately excluded, symlinks are
 * refused, and sockets/FIFOs/devices fail instead of being silently copied.
 */
export function copySkill(src: string, dst: string): void {
  const source = lstatSync(src);
  if (source.isSymbolicLink()) fail(`symlink refused: ${src}`);
  if (!source.isDirectory()) fail(`not a skill directory: ${src}`);
  mkdirSync(dst, { mode: source.mode & 0o777 });
  try {
    chmodSync(dst, source.mode & 0o777);
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.name === REASON_FILE) continue;
      const from = join(src, entry.name);
      const to = join(dst, entry.name);
      if (entry.isSymbolicLink()) fail(`symlink refused: ${from}`);
      if (entry.isDirectory()) {
        copySkill(from, to);
      } else if (entry.isFile()) {
        copyFileSync(from, to);
        chmodSync(to, lstatSync(from).mode & 0o777);
      } else {
        fail(`unsupported file type in skill: ${from}`);
      }
    }
  } catch (error) {
    removePath(dst);
    throw error;
  }
}

/** Rename within the filesystem, falling back to copy-and-remove across devices. */
export function movePath(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copySkill(src, dst);
    removePath(src);
  }
}

export function assertContained(base: string, target: string): void {
  const root = resolve(base);
  const candidate = resolve(target);
  if (candidate !== root && !isInside(root, candidate)) {
    fail(`path escapes ${base}: ${target}`);
  }
}

/** Resolve a file for viewing without allowing traversal or symlink escapes. */
export function viewTarget(base: string, rel?: string): string {
  const requested = rel && rel.length > 0 ? rel : "SKILL.md";
  const parts = requested.split(/[\\/]/);
  if (isAbsolute(requested) || parts.includes("..")) fail(`unsafe path: ${requested}`);
  let baseReal: string;
  try {
    baseReal = realpathSync(base);
  } catch (error) {
    fail(`invalid path ${requested}: ${messageOf(error)}`);
  }
  const target = resolve(baseReal, requested);
  if (target !== baseReal && !isInside(baseReal, target)) fail(`path escapes ${base}: ${requested}`);
  refuseSymlinkChain(target, baseReal);
  if (existsOrLink(target)) {
    let real: string;
    try {
      real = realpathSync(target);
    } catch (error) {
      fail(`invalid path ${requested}: ${messageOf(error)}`);
    }
    if (!isInside(baseReal, real)) fail(`path escapes ${base}: ${requested}`);
  }
  return target;
}
