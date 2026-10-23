import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, posix, sep } from "node:path";
import { BLOB_HASH_RE, BLOBS_DIR, putBlob, readBlob } from "./blobs.ts";
import { fail } from "./errors.ts";
import {
  atomicWriteText, existsOrLink, isRealDirectory, isRealFile, isSymlink, readText, removePath, REASON_FILE,
} from "./files.ts";
import { NAME_RE, VERSION_RE } from "./validation.ts";

export const MANIFESTS_DIR = "manifests";
export const MANIFEST_SCHEMA = 1;

const MANIFEST_SUFFIX = ".json";

export interface ManifestFile {
  path: string;
  hash: string;
  mode: number;
  size: number;
}

export interface ManifestDirectory {
  path: string;
  mode: number;
}

export interface VersionManifest {
  schema: typeof MANIFEST_SCHEMA;
  created: string;
  rootMode: number;
  directories: ManifestDirectory[];
  files: ManifestFile[];
}

/**
 * Manifests live in a workshop-owned sibling store, never inside a version
 * tree, so a skill file can use any legal name, including manifest.json.
 */
export function manifestFile(state: string, skill: string, version: string): string {
  if (!NAME_RE.test(skill) || !VERSION_RE.test(version)) {
    fail(`invalid version manifest path: ${skill}/${version}`);
  }
  return join(state, MANIFESTS_DIR, skill, `${version}${MANIFEST_SUFFIX}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDepth(left: { path: string }, right: { path: string }): number {
  const delta = left.path.split("/").length - right.path.split("/").length;
  return delta !== 0 ? delta : compareText(left.path, right.path);
}

function versionMode(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0o777) {
    fail(`invalid mode in version manifest: ${label}`);
  }
  return value;
}

function pathMode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

/** Validate a manifest-relative path and return it with forward slashes. */
export function manifestRel(requested: string): string {
  if (requested.length === 0 || requested.includes("\0")) fail("invalid path in version manifest");
  if (requested.includes("\\")) fail(`unsafe path in version manifest: ${requested}`);
  const parts = requested.split("/");
  if (isAbsolute(requested) || parts.includes("..")) fail(`unsafe path in version manifest: ${requested}`);
  const normalized = normalize(requested);
  if (normalized === "." || normalized === "" || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    fail(`unsafe path in version manifest: ${requested}`);
  }
  return normalized.split(sep).join("/");
}

export function isHashedVersion(state: string, skill: string, version: string): boolean {
  return existsOrLink(manifestFile(state, skill, version));
}

function readDirectories(value: unknown): ManifestDirectory[] {
  if (!Array.isArray(value)) fail("invalid directories in version manifest");
  const directories: ManifestDirectory[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") fail("invalid directory entry in version manifest");
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string") fail("invalid directory path in version manifest");
    const path = manifestRel(record.path);
    if (seen.has(path)) fail(`duplicate path in version manifest: ${path}`);
    seen.add(path);
    directories.push({ path, mode: versionMode(record.mode, path) });
  }
  return directories;
}

function readFiles(value: unknown): ManifestFile[] {
  if (!Array.isArray(value)) fail("invalid files in version manifest");
  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") fail("invalid file entry in version manifest");
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string") fail("invalid file path in version manifest");
    const path = manifestRel(record.path);
    if (seen.has(path)) fail(`duplicate path in version manifest: ${path}`);
    seen.add(path);
    if (typeof record.hash !== "string" || !BLOB_HASH_RE.test(record.hash)) {
      fail(`invalid blob hash in version manifest: ${path}`);
    }
    if (typeof record.size !== "number" || !Number.isInteger(record.size) || record.size < 0) {
      fail(`invalid size in version manifest: ${path}`);
    }
    files.push({ path, hash: record.hash, mode: versionMode(record.mode, path), size: record.size });
  }
  return files;
}

/** Parse and validate a hashed version manifest without touching its blobs. */
export function readManifest(state: string, skill: string, version: string): VersionManifest {
  const path = manifestFile(state, skill, version);
  if (isSymlink(path)) fail(`symlink refused: ${path}`);
  if (!isRealFile(path)) fail(`missing version manifest: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readText(path));
  } catch {
    fail(`invalid version manifest: ${path}`);
  }
  if (!raw || typeof raw !== "object") fail(`invalid version manifest: ${path}`);
  const record = raw as Record<string, unknown>;
  if (record.schema !== MANIFEST_SCHEMA) fail(`unsupported version manifest schema: ${path}`);
  if (typeof record.created !== "string") fail(`invalid created timestamp in version manifest: ${path}`);
  const directories = readDirectories(record.directories);
  const files = readFiles(record.files);
  const directoryPaths = new Set(directories.map((directory) => directory.path));
  for (const directory of directories) {
    const parent = posix.dirname(directory.path);
    if (parent !== "." && !directoryPaths.has(parent)) {
      fail(`missing directory for ${directory.path} in version manifest`);
    }
  }
  for (const file of files) {
    if (directoryPaths.has(file.path)) fail(`duplicate path in version manifest: ${file.path}`);
    const parent = posix.dirname(file.path);
    if (parent !== "." && !directoryPaths.has(parent)) {
      fail(`missing directory for ${file.path} in version manifest`);
    }
  }
  return {
    schema: MANIFEST_SCHEMA,
    created: record.created,
    rootMode: versionMode(record.rootMode, "root"),
    directories,
    files,
  };
}

/**
 * Snapshot a live tree as one content-addressed manifest. Files are written to
 * the shared blob store first; the version directory stays an empty marker and
 * the manifest is written to its parallel store.
 */
export function writeSnapshot(
  state: string,
  source: string,
  destination: string,
  manifestTarget: string,
  created: string,
): void {
  const root = lstatSync(source);
  if (root.isSymbolicLink()) fail(`symlink refused: ${source}`);
  if (!root.isDirectory()) fail(`not a skill directory: ${source}`);
  const directories: ManifestDirectory[] = [];
  const files: ManifestFile[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === REASON_FILE) continue;
      const from = join(current, entry.name);
      const raw = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const rel = manifestRel(raw);
      if (entry.isSymbolicLink()) fail(`symlink refused: ${from}`);
      if (entry.isDirectory()) {
        directories.push({ path: rel, mode: pathMode(from) });
        walk(from, rel);
        continue;
      }
      if (entry.isFile()) {
        const data = readFileSync(from);
        files.push({ path: rel, hash: putBlob(state, data), mode: pathMode(from), size: data.length });
        continue;
      }
      fail(`unsupported file type in skill: ${from}`);
    }
  };
  walk(source, "");
  directories.sort((left, right) => compareText(left.path, right.path));
  files.sort((left, right) => compareText(left.path, right.path));
  const manifest: VersionManifest = {
    schema: MANIFEST_SCHEMA,
    created,
    rootMode: root.mode & 0o777,
    directories,
    files,
  };
  mkdirSync(destination, { mode: 0o700 });
  chmodSync(destination, 0o700);
  atomicWriteText(
    manifestTarget,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/**
 * Rebuild a real tree from a hashed version. Every blob is hash-checked before
 * use, and the version directory must be an empty marker.
 */
export function materializeVersion(state: string, skill: string, version: string, destination: string): void {
  const manifest = readManifest(state, skill, version);
  const versionDir = join(state, "versions", skill, version);
  if (!isRealDirectory(versionDir)) fail(`missing version directory: ${versionDir}`);
  const extras = readdirSync(versionDir);
  if (extras.length > 0) fail(`unexpected entry in version ${version}: ${extras[0]}`);
  if (existsOrLink(destination)) fail(`staging directory already exists: ${destination}`);
  mkdirSync(destination, { mode: 0o700 });
  chmodSync(destination, 0o700);
  const directories = [...manifest.directories].sort(compareDepth);
  for (const directory of directories) {
    const target = join(destination, ...directory.path.split("/"));
    mkdirSync(target, { recursive: true, mode: 0o700 });
    chmodSync(target, 0o700);
  }
  for (const file of manifest.files) {
    const target = join(destination, ...file.path.split("/"));
    const label = `${file.path} in version ${version}`;
    const data = readBlob(state, file.hash, label);
    if (data.length !== file.size) fail(`blob size mismatch for ${label}`);
    writeFileSync(target, data, { mode: file.mode, flag: "wx" });
    chmodSync(target, file.mode);
  }
  for (const directory of [...directories].sort(compareDepth).reverse()) {
    chmodSync(join(destination, ...directory.path.split("/")), directory.mode);
  }
  chmodSync(destination, manifest.rootMode);
}

/** Read one file out of a hashed version, verifying the blob first. */
export function readVersionFile(
  state: string,
  skill: string,
  version: string,
  requested: string | undefined,
): string {
  const manifest = readManifest(state, skill, version);
  const path = manifestRel(requested && requested.length > 0 ? requested : "SKILL.md");
  const entry = manifest.files.find((file) => file.path === path);
  if (!entry) fail(`not found: ${join(state, "versions", skill, version, path)}`);
  const label = `${entry.path} in version ${version}`;
  const data = readBlob(state, entry.hash, label);
  if (data.length !== entry.size) fail(`blob size mismatch for ${label}`);
  return data.toString("utf8");
}

/**
 * Delete blobs no surviving version manifest references, plus manifests whose
 * version directory no longer exists. Any unreadable manifest or unexpected
 * entry in the manifest or blob stores disables every deletion in the pass.
 */
export function collectGarbage(state: string): void {
  const manifests = join(state, MANIFESTS_DIR);
  if (!isRealDirectory(manifests)) return;
  const versions = join(state, "versions");
  if (existsOrLink(versions) && !isRealDirectory(versions)) return;
  if (isRealDirectory(versions)) {
    for (const skill of readdirSync(versions, { withFileTypes: true })) {
      const skillDir = join(versions, skill.name);
      if (isSymlink(skillDir) || !skill.isDirectory()) return;
      for (const entry of readdirSync(skillDir, { withFileTypes: true })) {
        const versionDir = join(skillDir, entry.name);
        if (isSymlink(versionDir) || !entry.isDirectory()) return;
      }
    }
  }
  const referenced = new Set<string>();
  const orphanManifests: string[] = [];
  const manifestSkillDirs: string[] = [];
  for (const skill of readdirSync(manifests, { withFileTypes: true })) {
    const skillDir = join(manifests, skill.name);
    if (isSymlink(skillDir) || !skill.isDirectory() || !NAME_RE.test(skill.name)) return;
    manifestSkillDirs.push(skillDir);
    const versionsSkill = join(versions, skill.name);
    if (existsOrLink(versionsSkill) && !isRealDirectory(versionsSkill)) return;
    for (const entry of readdirSync(skillDir, { withFileTypes: true })) {
      const path = join(skillDir, entry.name);
      if (isSymlink(path) || !entry.isFile()) return;
      if (!entry.name.endsWith(MANIFEST_SUFFIX)) return;
      const version = entry.name.slice(0, -MANIFEST_SUFFIX.length);
      if (!VERSION_RE.test(version)) return;
      let manifest: VersionManifest;
      try {
        manifest = readManifest(state, skill.name, version);
      } catch {
        return;
      }
      const versionDir = join(versionsSkill, version);
      if (!existsOrLink(versionDir)) {
        orphanManifests.push(path);
        continue;
      }
      if (isSymlink(versionDir) || !isRealDirectory(versionDir)) return;
      if (readdirSync(versionDir).length > 0) return;
      for (const file of manifest.files) referenced.add(file.hash);
    }
  }

  const blobs = join(state, BLOBS_DIR);
  if (existsOrLink(blobs) && !isRealDirectory(blobs)) return;
  const stale: string[] = [];
  const shards: string[] = [];
  if (isRealDirectory(blobs)) {
    for (const shard of readdirSync(blobs, { withFileTypes: true })) {
      const shardDir = join(blobs, shard.name);
      if (isSymlink(shardDir) || !shard.isDirectory()) return;
      if (!/^[0-9a-f]{2}$/.test(shard.name)) return;
      for (const entry of readdirSync(shardDir, { withFileTypes: true })) {
        const path = join(shardDir, entry.name);
        if (entry.name.startsWith(".tmp-")) continue;
        if (isSymlink(path) || !entry.isFile()) return;
        if (!BLOB_HASH_RE.test(entry.name) || !entry.name.startsWith(shard.name)) return;
        if (!referenced.has(entry.name)) stale.push(path);
      }
      shards.push(shardDir);
    }
  }

  for (const path of orphanManifests) removePath(path);
  for (const path of stale) removePath(path);
  for (const shard of shards) {
    try {
      rmdirSync(shard);
    } catch {
      // A surviving or temporary entry keeps the shard.
    }
  }
  for (const skillDir of manifestSkillDirs) {
    try {
      rmdirSync(skillDir);
    } catch {
      // A surviving manifest keeps the skill directory.
    }
  }
}
