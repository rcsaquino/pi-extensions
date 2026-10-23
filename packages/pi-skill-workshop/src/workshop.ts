import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertDirectoryNotSymlink, canonicalPath, isInside, workshopPaths, type WorkshopPaths } from "./config.ts";
import { fail, messageOf, WorkshopError } from "./errors.ts";
import {
  assertContained, atomicWriteText, copySkill, ensureNoSymlinks, existsOrLink, isRealDirectory, isRealFile, isSymlink,
  movePath, privateDir, randomHex, readText, refuseSymlinkChain, removePath, viewTarget, withFileLock, writeText,
} from "./files.ts";
import {
  IDLE_DAYS, KEEP_CHANGES, KEEP_VERSIONS, MAX_SUPPORT_BYTES,
  parseFrontmatter, requireChangeId, requireName, requireVersion, safeRel, scanTree, secretLines, splitLines,
  validate, VERSION_RE,
} from "./validation.ts";
import {
  collectGarbage, isHashedVersion, MANIFESTS_DIR, manifestFile, materializeVersion, readVersionFile, writeSnapshot,
} from "./snapshots.ts";

export const ACTIONS = [
  "list", "view", "create", "patch", "write_file", "remove_file",
  "archive", "restore", "undo", "changes", "cleanup",
] as const;

export type WorkshopAction = (typeof ACTIONS)[number];

export interface WorkshopRequest {
  action: WorkshopAction;
  name?: string;
  version?: string;
  file?: string;
  path?: string;
  content?: string;
  content_path?: string;
  old?: string;
  new?: string;
  old_file?: string;
  new_file?: string;
  reason?: string;
  absorbed_into?: string;
  id?: string;
  days?: number;
  dry_run?: boolean;
  force?: boolean;
  archived?: boolean;
  limit?: number;
  skill?: string;
}

interface ChangeEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  skill: string;
  reason: string;
  version?: string;
  absorbed_into?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CHANGE_TRIM_SLACK = 100;

/** Append one line with O_APPEND and flush it before releasing the state lock. */
function appendDurableLine(path: string, line: string): void {
  const descriptor = openSync(path, "a", 0o600);
  try {
    writeSync(descriptor, line);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function iso(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function versionStamp(date: Date): string {
  return iso(date).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function today(): string {
  return iso().slice(0, 10);
}

function parseUsage(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(text.trim());
  if (!match) return undefined;
  const value = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  );
  return Number.isFinite(value) ? value : undefined;
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return text.length + 1;
  let count = 0;
  let at = 0;
  for (;;) {
    const found = text.indexOf(needle, at);
    if (found === -1) return count;
    count++;
    at = found + needle.length;
  }
}

export class SkillWorkshop {
  readonly root: string;
  readonly state: string;

  constructor(paths: WorkshopPaths) {
    this.root = resolve(paths.root);
    this.state = resolve(paths.state);
    assertDirectoryNotSymlink(this.root, "managed root");
    assertDirectoryNotSymlink(this.state, "state root");
    if (isInside(this.root, this.state) || isInside(this.state, this.root)) {
      fail("state must stay outside the managed skills root");
    }
    const canonicalRoot = canonicalPath(this.root);
    const canonicalState = canonicalPath(this.state);
    if (isInside(canonicalRoot, canonicalState) || isInside(canonicalState, canonicalRoot)) {
      fail("state must stay outside the managed skills root after resolving symlinks");
    }
  }

  execute(action: WorkshopAction, input: WorkshopRequest): string {
    switch (action) {
      case "list": return this.list(input);
      case "view": return this.view(input);
      case "create": return this.create(input);
      case "patch": return this.patch(input);
      case "write_file": return this.writeFile(input);
      case "remove_file": return this.removeFile(input);
      case "archive": return this.archive(input);
      case "restore": return this.restore(input);
      case "undo": return this.undo(input);
      case "changes": return this.changes(input);
      case "cleanup": return this.cleanup(input);
      default: {
        const exhaustive: never = action;
        fail(`unknown action: ${String(exhaustive)}`);
      }
    }
  }

  liveDir(name: string): string {
    return join(this.root, name);
  }

  // ---------------------------------------------------------------- read actions

  list(input: WorkshopRequest): string {
    const lines = [`root: ${this.root}`];
    const skills = this.listSkills();
    for (const path of skills) {
      const name = basename(path);
      const meta = parseFrontmatter(readText(join(path, "SKILL.md")));
      const age = Math.floor((Date.now() - this.lastActivity(name).getTime()) / DAY_MS);
      lines.push(`${name.padEnd(32)} ${String(age).padStart(3)}d  ${(meta.description ?? "").slice(0, 90)}`);
    }
    if (input.archived || skills.length === 0) {
      const names = this.archivedNames();
      if (names.length) {
        lines.push("archived:");
        for (const name of names) lines.push(`  ${name}`);
      }
    }
    return lines.join("\n");
  }

  view(input: WorkshopRequest): string {
    const name = requireName(input.name ?? fail("view requires name"));
    let base: string;
    if (input.version !== undefined) {
      const version = requireVersion(input.version);
      base = join(this.state, "versions", name, version);
      if (!isRealDirectory(base)) fail(`no version '${version}' for '${name}'`);
      refuseSymlinkChain(base, this.state);
      if (isHashedVersion(this.state, name, version)) {
        return readVersionFile(this.state, name, version, input.file ?? input.path);
      }
    } else {
      base = this.liveDir(name);
      if (!isRealDirectory(base)) fail(`skill '${name}' is not live`);
      refuseSymlinkChain(base, this.root);
    }
    const target = viewTarget(base, input.file ?? input.path);
    if (!isRealFile(target)) fail(`not found: ${target}`);
    const text = readText(target);
    if (input.version === undefined) this.touchUsage(name);
    return text;
  }

  changes(input: WorkshopRequest): string {
    const feed = join(this.state, "changes.jsonl");
    if (!existsOrLink(feed)) return "no changes recorded";
    const entries = this.readChanges(feed);
    const filter = input.skill ?? input.name;
    const skill = filter === undefined ? undefined : requireName(filter);
    const selected = entries.filter((entry) => skill === undefined || entry.skill === skill);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 0) fail("limit must be a non-negative integer");
    const page = limit === 0 ? selected : selected.slice(-limit);
    return page.reverse().map((entry) => formatChange(entry)).join("\n");
  }

  // ---------------------------------------------------------------- mutations

  create(input: WorkshopRequest): string {
    const name = requireName(input.name ?? fail("create requires name"));
    const destination = this.liveDir(name);
    if (existsOrLink(destination)) fail(`skill '${name}' already exists; patch it instead`);
    const text = this.resolveContent(input, "create");
    const { errors, advisories } = validate(name, text);
    if (errors.length) fail(errors.join("; "));
    this.ensureRoot();
    mkdirSync(destination, { recursive: true });
    atomicWriteText(join(destination, "SKILL.md"), text);
    const problems = scanTree(destination, this.root);
    if (problems.length) {
      removePath(destination);
      fail(problems.join("; "));
    }
    try {
      this.record("create", name, input.reason || "created learned skill");
    } catch (error) {
      removePath(destination);
      throw error;
    }
    return [ `created ${name}`, ...advisories.map(advisory) ].join("\n");
  }

  patch(input: WorkshopRequest): string {
    const name = requireName(input.name ?? fail("patch requires name"));
    const skill = this.requireLive(name);
    let rel = input.file ?? input.path ?? "SKILL.md";
    if (rel !== "SKILL.md") rel = safeRel(rel);
    const target = join(skill, rel);
    assertContained(skill, target);
    refuseSymlinkChain(target, skill);
    if (!isRealFile(target)) fail(`not found: ${rel}`);
    const text = readText(target);
    const old = this.resolvePair(input.old, input.old_file, "patch", "old");
    const replacement = this.resolvePair(input.new, input.new_file, "patch", "new");
    const count = countOccurrences(text, old);
    if (count !== 1) fail(`old text must occur exactly once in ${rel} (found ${count})`);
    const at = text.indexOf(old);
    const updated = text.slice(0, at) + replacement + text.slice(at + old.length);
    let advisories: string[] = [];
    if (rel === "SKILL.md") {
      const result = validate(name, updated);
      if (result.errors.length) fail(result.errors.join("; "));
      advisories = result.advisories;
    } else {
      if (Buffer.byteLength(updated) > MAX_SUPPORT_BYTES) fail(`support file exceeds ${MAX_SUPPORT_BYTES} bytes`);
      const secrets = secretLines(updated);
      if (secrets.length) fail(`possible literal secret at input line ${secrets[0]}`);
    }
    const version = this.snapshot(name, input.reason || "patched skill");
    this.publish(name, rel, target, updated, "patch", input.reason || "patched skill", version);
    return [ `patched ${name}/${rel}`, ...advisories.map(advisory) ].join("\n");
  }

  /**
   * Full rewrite of SKILL.md or a support file. SKILL.md gets the same
   * validation as create/patch; support files use the 256 KiB cap and secret
   * scan. The previous tree is snapshotted before either mutation.
   */
  writeFile(input: WorkshopRequest): string {
    const name = requireName(input.name ?? fail("write_file requires name"));
    const skill = this.requireLive(name);
    const requestedPath = input.path ?? input.file;
    let rel = requestedPath === undefined || requestedPath.length === 0 ? "SKILL.md" : requestedPath;
    if (rel !== "SKILL.md") rel = safeRel(rel);
    const text = this.resolveContent(input, "write_file");
    let advisories: string[] = [];
    if (rel === "SKILL.md") {
      const result = validate(name, text);
      if (result.errors.length) fail(result.errors.join("; "));
      advisories = result.advisories;
    } else {
      if (Buffer.byteLength(text) > MAX_SUPPORT_BYTES) fail(`support file exceeds ${MAX_SUPPORT_BYTES} bytes`);
      const secrets = secretLines(text);
      if (secrets.length) fail(`possible literal secret at input line ${secrets[0]}`);
    }
    const target = join(skill, rel);
    assertContained(skill, target);
    const version = this.snapshot(name, input.reason || (rel === "SKILL.md" ? "rewrote SKILL.md" : `wrote ${rel}`));
    this.publish(name, rel, target, text, "write_file", input.reason || (rel === "SKILL.md" ? "rewrote SKILL.md" : `wrote ${rel}`), version);
    return [ `wrote ${name}/${rel}`, ...advisories.map(advisory) ].join("\n");
  }

  removeFile(input: WorkshopRequest): string {
    const name = requireName(input.name ?? fail("remove_file requires name"));
    const skill = this.requireLive(name);
    const rel = safeRel(input.path ?? input.file ?? fail("remove_file requires path or file"));
    const target = join(skill, rel);
    assertContained(skill, target);
    if (!isRealFile(target)) fail(`not found: ${rel}`);
    const version = this.snapshot(name, input.reason || `removed ${rel}`);
    unlinkSync(target);
    try {
      this.record("remove_file", name, input.reason || `removed ${rel}`, version);
    } catch (error) {
      this.rollbackVersion(name, version);
      throw error;
    }
    return `removed ${name}/${rel}`;
  }

  archive(input: WorkshopRequest): string {
    const name = requireName(input.name ?? fail("archive requires name"));
    const skill = this.requireLive(name);
    if (!input.reason && !input.absorbed_into) fail("archive needs reason or absorbed_into");
    const reason = input.reason || `absorbed into ${input.absorbed_into}`;
    const version = this.snapshot(name, reason);
    const destination = join(this.state, "archive", name);
    if (existsOrLink(destination)) fail(`archive already holds '${name}'; restore it first`);
    privateDir(dirname(destination));
    movePath(skill, destination);
    secureArchiveDir(destination);
    this.collectGarbageQuietly();
    try {
      this.record("archive", name, reason, version, "eve", input.absorbed_into);
    } catch (error) {
      try {
        movePath(destination, skill);
        secureLiveDir(skill);
      } catch { /* The original record failure remains the reported error. */ }
      throw error;
    }
    return `archived ${name}`;
  }

  restore(input: WorkshopRequest): string {
    const name = requireName(input.name ?? fail("restore requires name"));
    const version = input.version === undefined ? undefined : requireVersion(input.version);
    const live = this.liveDir(name);
    if (existsOrLink(live)) fail(`skill '${name}' is already live`);
    if (version !== undefined) {
      const previous = existsOrLink(live) ? this.snapshot(name, "before restore") : undefined;
      const source = this.versionSource(name, version);
      this.installVersion(name, source, version);
      try {
        this.record("restore", name, `restored version ${version}`);
      } catch (error) {
        this.rollbackTo(name, previous);
        throw error;
      }
    } else {
      const source = this.archiveSource(name);
      movePath(source, live);
      secureLiveDir(live);
      removeReasonFile(live);
      try {
        this.record("restore", name, "restored archived skill");
      } catch (error) {
        try {
          movePath(live, source);
          secureArchiveDir(source);
        } catch { /* The original record failure remains the reported error. */ }
        throw error;
      }
    }
    this.touchUsage(name);
    return `restored ${name}`;
  }

  undo(input: WorkshopRequest): string {
    const changeId = input.id === undefined ? undefined : requireChangeId(input.id);
    const feed = join(this.state, "changes.jsonl");
    if (!existsOrLink(feed)) fail("no changes recorded");
    const entries = this.readChanges(feed);
    let entry: ChangeEntry | undefined;
    if (changeId !== undefined) {
      for (let index = entries.length - 1; index >= 0; index--) {
        const candidate = entries[index];
        if (candidate && candidate.id === changeId) {
          entry = candidate;
          break;
        }
      }
      if (!entry) fail(`change not found: ${changeId}`);
    } else {
      for (let index = entries.length - 1; index >= 0; index--) {
        const candidate = entries[index];
        if (candidate && candidate.action !== "undo" && candidate.action !== "restore") {
          entry = candidate;
          break;
        }
      }
      if (!entry) fail("change not found");
    }
    const name = requireName(entry.skill);
    const action = entry.action;
    if (action === "create") {
      const live = this.liveDir(name);
      const archive = join(this.state, "archive", name);
      let moved = false;
      if (existsOrLink(live)) {
        if (existsOrLink(archive)) fail(`archive already holds '${name}'`);
        privateDir(dirname(archive));
        movePath(live, archive);
        secureArchiveDir(archive);
        moved = true;
      }
      try {
        this.record("undo", name, `undid create ${entry.id}`, undefined, "sir");
      } catch (error) {
        if (moved && existsOrLink(archive)) {
          try { movePath(archive, live); secureLiveDir(live); } catch { /* keep the record error */ }
        }
        throw error;
      }
      return `undid create of ${name}`;
    }
    if (action === "archive") {
      const live = this.liveDir(name);
      if (existsOrLink(live)) fail(`skill '${name}' is already live`);
      const source = this.archiveSource(name);
      movePath(source, live);
      secureLiveDir(live);
      removeReasonFile(live);
      try {
        this.record("undo", name, `undid archive ${entry.id}`, undefined, "sir");
      } catch (error) {
        try { movePath(live, source); secureArchiveDir(source); } catch { /* keep the record error */ }
        throw error;
      }
      this.touchUsage(name);
      return `undid archive of ${name}`;
    }
    if (!entry.version) fail(`change ${entry.id} has no saved version`);
    const source = this.versionSource(name, entry.version);
    const live = this.liveDir(name);
    const previous = existsOrLink(live) ? this.snapshot(name, `before undo of ${entry.id}`) : undefined;
    this.installVersion(name, source, entry.version);
    try {
      this.record("undo", name, `undid ${action} ${entry.id}`, undefined, "sir");
    } catch (error) {
      this.rollbackTo(name, previous);
      throw error;
    }
    this.touchUsage(name);
    return `undid ${action} of ${name}`;
  }

  cleanup(input: WorkshopRequest): string {
    const days = input.days ?? IDLE_DAYS;
    if (!Number.isInteger(days) || days < 1) fail("days must be a positive integer");
    const marker = join(this.state, "last-cleanup");
    if (!input.force && existsOrLink(marker) && readText(marker).trim() === today()) {
      return "cleanup already ran today";
    }
    const cutoff = Date.now() - days * DAY_MS;
    const lines: string[] = [];
    for (const skill of this.listSkills()) {
      const name = basename(skill);
      const meta = parseFrontmatter(readText(join(skill, "SKILL.md")));
      const pinned = (meta.pinned ?? "").toLowerCase();
      if (pinned === "true" || pinned === "yes" || pinned === "1") continue;
      if (this.lastActivity(name).getTime() > cutoff) continue;
      if (input.dry_run) {
        lines.push(`would archive ${name} (idle)`);
        continue;
      }
      const destination = join(this.state, "archive", name);
      if (existsOrLink(destination)) continue;
      const reason = `unused for ${days} days`;
      const version = this.snapshot(name, reason);
      privateDir(dirname(destination));
      movePath(skill, destination);
      secureArchiveDir(destination);
      try {
        this.record("archive", name, reason, version, "curator");
      } catch (error) {
        try {
          movePath(destination, skill);
          secureLiveDir(skill);
        } catch { /* The original record failure remains the reported error. */ }
        throw error;
      }
      lines.push(`archived ${name} (unused for ${days} days)`);
    }
    if (!input.dry_run) {
      privateDir(dirname(marker));
      writeText(marker, `${today()}\n`);
      this.collectGarbageQuietly();
    }
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- internals

  private ensureRoot(): void {
    if (existsOrLink(this.root)) {
      if (!isRealDirectory(this.root)) fail(`managed root is not a directory: ${this.root}`);
      return;
    }
    mkdirSync(this.root, { recursive: true });
  }

  /**
   * Publish one validated file and record the change. Any failure after the
   * write restores the snapshot taken before it, so a rejected patch cannot
   * persist a secret, an oversized support file, or an unrecorded mutation.
   */
  private publish(
    name: string,
    rel: string,
    target: string,
    text: string,
    action: string,
    reason: string,
    version: string,
  ): void {
    let written = false;
    try {
      if (rel !== "SKILL.md") mkdirSync(dirname(target), { recursive: true });
      refuseSymlinkChain(target, this.liveDir(name));
      atomicWriteText(target, text);
      written = true;
      const problems = scanTree(this.liveDir(name), this.root);
      if (problems.length) fail(problems.join("; "));
      this.record(action, name, reason, version);
    } catch (error) {
      if (written) this.rollbackVersion(name, version);
      throw error instanceof WorkshopError ? error : new WorkshopError(messageOf(error));
    }
  }

  /** Best-effort restoration of the pre-mutation tree and removal of its snapshot. */
  private rollbackVersion(name: string, version: string): void {
    this.rollbackTo(name, version);
  }

  private rollbackTo(name: string, version: string | undefined): void {
    try {
      const live = this.liveDir(name);
      if (version === undefined) {
        removePath(live);
        return;
      }
      const source = this.versionSource(name, version);
      this.installVersion(name, source, version);
      removePath(join(this.state, "versions", name, version));
      removePath(manifestFile(this.state, name, version));
      this.collectGarbageQuietly();
    } catch {
      // Keep the primary validation/record error; the snapshot remains available.
    }
  }

  private requireLive(name: string): string {
    const skill = this.liveDir(name);
    if (!isRealDirectory(skill)) fail(`skill '${name}' is not live`);
    refuseSymlinkChain(skill, this.root);
    return skill;
  }

  private resolveContent(input: WorkshopRequest, action: string): string {
    const inline = input.content;
    const file = input.content_path;
    if (inline !== undefined && file !== undefined) fail(`${action} accepts content or content_path, not both`);
    if (inline !== undefined) return inline;
    if (file !== undefined) {
      if (!isRealFile(file)) fail(`file not found: ${file}`);
      return readText(file);
    }
    fail(`${action} requires content or content_path`);
  }

  private resolvePair(
    inline: string | undefined,
    file: string | undefined,
    action: string,
    label: string,
  ): string {
    if ((inline === undefined) === (file === undefined)) {
      fail(`${action} requires exactly one of ${label} or ${label}_file`);
    }
    if (inline !== undefined) return inline;
    if (!isRealFile(file!)) fail(`file not found: ${file}`);
    return readText(file!);
  }

  private versionSource(name: string, version: string): string {
    requireVersion(version);
    const source = join(this.state, "versions", name, version);
    if (!isRealDirectory(source) || isSymlink(source)) fail(`no version '${version}' for '${name}'`);
    refuseSymlinkChain(source, this.state);
    ensureNoSymlinks(source);
    if (!isHashedVersion(this.state, name, version) && readdirSync(source).length === 0) {
      fail(`version '${version}' for '${name}' has no files and no manifest`);
    }
    return source;
  }

  private archiveSource(name: string): string {
    const source = join(this.state, "archive", name);
    if (!isRealDirectory(source) || isSymlink(source)) fail(`no archived skill '${name}'`);
    refuseSymlinkChain(source, this.state);
    ensureNoSymlinks(source);
    return source;
  }

  private snapshot(name: string, _reason: string): string {
    const source = this.liveDir(name);
    if (!isRealDirectory(source)) fail(`skill '${name}' is not live`);
    refuseSymlinkChain(source, this.root);
    ensureNoSymlinks(source);
    const now = new Date();
    const id = `${versionStamp(now)}-${randomHex(3)}`;
    const versionsParent = privateDir(join(this.state, "versions"));
    const versionsRoot = privateDir(join(versionsParent, name));
    const destination = join(versionsRoot, id);
    const manifestsParent = privateDir(join(this.state, MANIFESTS_DIR));
    privateDir(join(manifestsParent, name));
    const manifest = manifestFile(this.state, name, id);
    try {
      writeSnapshot(this.state, source, destination, manifest, iso(now));
    } catch (error) {
      removePath(destination);
      removePath(manifest);
      this.collectGarbageQuietly();
      fail(`could not snapshot '${name}': ${messageOf(error)}`);
    }
    try {
      chmodSync(destination, 0o700);
    } catch {
      // Best effort, matching the legacy CLI.
    }
    removeReasonFile(source);
    const versions = readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // Same-second version ids sort arbitrarily, so never let retention remove
    // the snapshot this call just wrote.
    const pruned = versions
      .filter((version) => version !== id)
      .slice(0, Math.max(0, versions.length - KEEP_VERSIONS));
    for (const old of pruned) {
      removePath(join(versionsRoot, old));
      // Legacy version directories may predate the version id format and have no manifest.
      if (VERSION_RE.test(old)) removePath(manifestFile(this.state, name, old));
    }
    if (pruned.length > 0) this.collectGarbageQuietly();
    return id;
  }

  private collectGarbageQuietly(): void {
    try {
      collectGarbage(this.state);
    } catch {
      // Retention and archive must succeed even if garbage collection cannot.
    }
  }

  private installVersion(name: string, source: string, version?: string): void {
    this.ensureRoot();
    const temporary = join(this.root, `.workshop-tmp-${name}-${randomHex(4)}`);
    const backup = join(this.root, `.workshop-old-${name}-${randomHex(4)}`);
    try {
      if (version !== undefined && isHashedVersion(this.state, name, version)) {
        materializeVersion(this.state, name, version, temporary);
      } else {
        copySkill(source, temporary);
      }
    } catch (error) {
      removePath(temporary);
      fail(`could not stage restore of '${name}': ${messageOf(error)}`);
    }
    const live = this.liveDir(name);
    let moved = false;
    try {
      if (existsOrLink(live)) {
        movePath(live, backup);
        moved = true;
      }
      movePath(temporary, live);
    } catch (error) {
      removePath(temporary);
      if (moved && !existsOrLink(live)) {
        try {
          movePath(backup, live);
        } catch {
          // Preserve the original failure; the backup path is reported in the message context.
        }
      }
      fail(`could not restore '${name}': ${messageOf(error)}`);
    }
    if (moved) removePath(backup);
    secureLiveDir(live);
  }

  private record(
    action: string,
    name: string,
    reason: string,
    version?: string,
    actor = "eve",
    absorbedInto?: string,
  ): string {
    const id = randomHex(6);
    const entry: ChangeEntry = {
      id,
      ts: iso(),
      actor,
      action,
      skill: name,
      reason,
      ...(version ? { version } : {}),
      ...(absorbedInto ? { absorbed_into: absorbedInto } : {}),
    };
    const feed = join(this.state, "changes.jsonl");
    privateDir(dirname(feed));
    withFileLock(join(this.state, ".changes.lock"), () => {
      if (isSymlink(feed)) fail(`symlink refused: ${feed}`);
      // Append one durable line. A crash cannot truncate the existing feed, and
      // the bounded trim happens only while the cross-process lock is held.
      appendDurableLine(feed, `${JSON.stringify(entry)}\n`);
      const lines = splitLines(readText(feed));
      if (lines.length > KEEP_CHANGES + CHANGE_TRIM_SLACK) {
        atomicWriteText(feed, `${lines.slice(-KEEP_CHANGES).join("\n")}\n`, { mode: 0o600 });
      }
    });
    return id;
  }

  private touchUsage(name: string): void {
    const path = join(this.state, "usage", name);
    privateDir(dirname(path));
    writeText(path, `${iso()}\n`);
  }

  private lastActivity(name: string): Date {
    const times: number[] = [];
    const usage = join(this.state, "usage", name);
    if (existsOrLink(usage)) {
      try {
        const value = parseUsage(readText(usage));
        if (value !== undefined) times.push(value);
      } catch {
        // An unreadable usage marker is ignored; filesystem mtimes still count.
      }
    }
    const skill = join(this.liveDir(name), "SKILL.md");
    if (isRealFile(skill)) times.push(statSync(skill).mtimeMs);
    const versions = join(this.state, "versions", name);
    if (isRealDirectory(versions)) {
      for (const entry of readdirSync(versions)) {
        try {
          times.push(statSync(join(versions, entry)).mtimeMs);
        } catch {
          // Concurrent retention may remove an old version.
        }
      }
    }
    return new Date(times.length ? Math.max(...times) : Date.now());
  }

  private listSkills(): string[] {
    if (!isRealDirectory(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && isRealFile(join(this.root, entry.name, "SKILL.md")))
      .map((entry) => join(this.root, entry.name))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  }

  private archivedNames(): string[] {
    const archive = join(this.state, "archive");
    if (!isRealDirectory(archive)) return [];
    return readdirSync(archive, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  private readChanges(feed: string): ChangeEntry[] {
    if (isSymlink(feed)) fail(`symlink refused: ${feed}`);
    const entries: ChangeEntry[] = [];
    for (const line of splitLines(readText(feed))) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        fail("invalid changes feed");
      }
      if (!value || typeof value !== "object") fail("invalid changes feed");
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.ts !== "string" || typeof record.action !== "string" ||
          typeof record.skill !== "string" || typeof record.reason !== "string") {
        fail("invalid changes feed");
      }
      entries.push({
        id: record.id,
        ts: record.ts,
        actor: typeof record.actor === "string" ? record.actor : "eve",
        action: record.action,
        skill: record.skill,
        reason: record.reason,
        ...(typeof record.version === "string" ? { version: record.version } : {}),
        ...(typeof record.absorbed_into === "string" ? { absorbed_into: record.absorbed_into } : {}),
      });
    }
    return entries;
  }
}

function advisory(text: string): string {
  return `Advisory (not blocking): ${text}`;
}

function formatChange(entry: ChangeEntry): string {
  const bits = [entry.ts, entry.action, entry.skill];
  if (entry.absorbed_into) bits.push(`-> ${entry.absorbed_into}`);
  if (entry.version) bits.push(`v${entry.version}`);
  return `${bits.join("  ")}  (${entry.reason})  [${entry.id}]`;
}

function secureArchiveDir(path: string): void {
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort, matching the legacy CLI.
  }
}

function secureLiveDir(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch {
    // Best effort, matching the legacy CLI.
  }
}

function removeReasonFile(path: string): void {
  const reason = join(path, ".workshop-reason");
  if (isRealFile(reason) || isSymlink(reason)) {
    try {
      unlinkSync(reason);
    } catch {
      // Best effort.
    }
  }
}

export function openWorkshop(env: NodeJS.ProcessEnv = process.env): SkillWorkshop {
  return new SkillWorkshop(workshopPaths(env));
}

export function runWorkshop(action: WorkshopAction, input: WorkshopRequest, env: NodeJS.ProcessEnv = process.env): string {
  return openWorkshop(env).execute(action, input);
}
