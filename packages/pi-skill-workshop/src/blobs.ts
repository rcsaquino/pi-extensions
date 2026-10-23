import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.ts";
import { existsOrLink, isRealFile, isSymlink, privateDir, randomHex, removePath } from "./files.ts";

export const BLOBS_DIR = "blobs";
export const BLOB_HASH_RE = /^[0-9a-f]{64}$/;

export function hashBytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Resolve a validated hash to its sharded blob path. */
export function blobPath(state: string, hash: string): string {
  if (!BLOB_HASH_RE.test(hash)) fail(`invalid blob hash: '${hash}'`);
  return join(state, BLOBS_DIR, hash.slice(0, 2), hash);
}

/**
 * Store bytes under their SHA-256. The write is private and atomic, and an
 * existing blob is never rewritten or replaced.
 */
export function putBlob(state: string, data: Buffer): string {
  const hash = hashBytes(data);
  const target = blobPath(state, hash);
  if (existsOrLink(target)) {
    if (isSymlink(target) || !isRealFile(target)) fail(`blob is not a regular file: ${target}`);
    return hash;
  }
  const shard = privateDir(join(state, BLOBS_DIR, hash.slice(0, 2)));
  const temporary = join(shard, `.tmp-${randomHex(6)}`);
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } catch (error) {
    removePath(temporary);
    throw error;
  }
  return hash;
}

/** Read a blob and verify its content hash before returning it. */
export function readBlob(state: string, hash: string, label: string): Buffer {
  const path = blobPath(state, hash);
  if (isSymlink(path) || !isRealFile(path)) fail(`missing blob ${hash} for ${label}`);
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    fail(`missing blob ${hash} for ${label}`);
  }
  if (hashBytes(data) !== hash) fail(`blob hash mismatch for ${label}: expected ${hash}`);
  return data;
}
