import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { SafeError } from "./config.ts";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Walk the canonical chain using held directory descriptors, not a second pathname
 * check followed by a pathname read. /proc's descriptor link is intentional; each
 * subsequent component is opened relative to that held inode with O_NOFOLLOW.
 */
async function directory(path: string, signal?: AbortSignal): Promise<FileHandle> {
  let held = await open("/", directoryFlags);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      signal?.throwIfAborted();
      const next = await open(`/proc/self/fd/${held.fd}/${part}`, directoryFlags);
      await held.close(); held = next;
    }
    return held;
  } catch (error) { await held.close().catch(() => {}); throw error; }
}

export async function readAttachment(path: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  // Node has no public openat/openat2 API. Never fall back to unsafe pathname reads.
  if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new SafeError("Secure attachment reads require Linux with procfs.");
  }
  signal?.throwIfAborted();
  let parent: FileHandle | undefined, file: FileHandle | undefined;
  try {
    parent = await directory(dirname(path), signal);
    const entry = `/proc/self/fd/${parent.fd}/${basename(path)}`;
    file = await open(entry, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw new SafeError("Outgoing file must be a regular file of at most 50 MB.");
    const buffers: Buffer[] = [];
    let size = 0;
    for (;;) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new SafeError("Outgoing file exceeds the supported size limit.");
      buffers.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat(), namedFile = await lstat(entry);
    if (namedFile.isSymbolicLink() || namedFile.ino !== after.ino || namedFile.dev !== after.dev || after.size !== before.size || size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new SafeError("Outgoing file changed during read.");
    }
    // Detect an ancestor rename without ever following its replacement to read bytes.
    const current = await directory(dirname(path), signal);
    try {
      const held = await parent.stat(), named = await current.stat();
      if (held.ino !== named.ino || held.dev !== named.dev) throw new SafeError("Outgoing directory changed during read.");
    } finally { await current.close(); }
    signal?.throwIfAborted();
    return Buffer.concat(buffers, size);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof SafeError) throw error;
    throw new SafeError("Outgoing file could not be securely opened or its directory changed.");
  } finally { await file?.close().catch(() => {}); await parent?.close().catch(() => {}); }
}
