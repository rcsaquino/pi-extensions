import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_MODEL } from "./auth.ts";
import { SafeError } from "./errors.ts";
import { detectImageMime } from "./files.ts";
import { canonicalRoot, OUTPUT_ESCAPE, rejectSymlinkComponents, within } from "./paths.ts";

export const MAX_PROMPT_LENGTH = 4000;
export const MAX_REFERENCE_IMAGES = 3;
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_MODEL_LENGTH = 128;

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/;
/** Explicit pixel sizes plus OpenRouter dimension tiers; "auto" omits the field. */
const SIZE_PATTERN = /^\d+x\d+$/;
const SIZE_TIERS = new Set(["1K", "2K", "4K"]);

export function validatePrompt(prompt: unknown): string {
  if (typeof prompt !== "string" || !prompt.trim()) throw new SafeError("A non-empty prompt is required.");
  const text = prompt.trim();
  if (text.length > MAX_PROMPT_LENGTH) throw new SafeError(`Prompt exceeds ${MAX_PROMPT_LENGTH} characters.`);
  return text;
}

export function validateModel(model: unknown): string {
  if (model === undefined || model === null) return DEFAULT_MODEL;
  if (typeof model !== "string" || !model.trim()) return DEFAULT_MODEL;
  const id = model.trim();
  if (id.length > MAX_MODEL_LENGTH || !MODEL_PATTERN.test(id)) {
    throw new SafeError("Model must be a valid OpenRouter image model id.");
  }
  return id;
}

export function validateSize(size: unknown): string | undefined {
  if (size === undefined || size === null) return undefined;
  if (typeof size !== "string" || !size.trim()) return undefined;
  const value = size.trim();
  if (value.toLowerCase() === "auto") return undefined;
  if (SIZE_TIERS.has(value.toUpperCase())) return value.toUpperCase();
  if (!SIZE_PATTERN.test(value)) throw new SafeError("Size must be WIDTHxHEIGHT (256–4096 per side), a tier (1K, 2K, 4K), or auto.");
  const [width, height] = value.split("x").map(Number);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 256 || height < 256 || width > 4096 || height > 4096) {
    throw new SafeError("Size dimensions must each be between 256 and 4096 pixels.");
  }
  return `${width}x${height}`;
}

export interface ReferenceImage {
  dataUrl: string;
  mime: string;
  bytes: number;
  filename: string;
}

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Walk the canonical chain with held directory descriptors, not a rechecked pathname. */
async function openDirectory(path: string): Promise<FileHandle> {
  let held = await open("/", directoryFlags);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = await open(`/proc/self/fd/${held.fd}/${part}`, directoryFlags);
      await held.close();
      held = next;
    }
    return held;
  } catch (error) {
    await held.close().catch(() => {});
    throw error;
  }
}

const outsideWorkspace = new SafeError("Reference images must be existing files inside the Pi working directory.");

async function readBounded(file: FileHandle, maxBytes: number): Promise<Buffer> {
  const before = await file.stat();
  if (!before.isFile()) throw outsideWorkspace;
  if (before.size > maxBytes) throw new SafeError("Reference images are limited to 20 MB each.");
  const buffers: Buffer[] = [];
  let size = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - size));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > maxBytes) throw new SafeError("Reference images are limited to 20 MB each.");
    buffers.push(chunk.subarray(0, bytesRead));
  }
  const after = await file.stat();
  if (after.size !== before.size || size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new SafeError("Reference image changed during read.");
  }
  return Buffer.concat(buffers, size);
}

/** Read a workspace-contained reference without following a swapped symlink or renaming its parent. */
async function readReferenceFile(root: string, candidate: string, maxBytes: number): Promise<{ path: string; data: Buffer }> {
  let base: string, resolved: string;
  try {
    base = await realpath(root);
    resolved = await realpath(resolve(base, candidate));
  } catch {
    throw outsideWorkspace;
  }
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || rel === "") throw outsideWorkspace;

  // The held-descriptor path needs procfs. Elsewhere use O_NOFOLLOW and a post-read realpath check.
  if (process.platform !== "linux" || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) {
    // shortcut: ancestor swaps are unchecked off Linux, harden when non-Linux reference reads are supported.
    let handle: FileHandle | undefined;
    try {
      handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const data = await readBounded(handle, maxBytes);
      const again = await realpath(resolve(base, candidate)).catch(() => undefined);
      if (again !== resolved) throw new SafeError("Reference image changed during read.");
      return { path: resolved, data };
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw outsideWorkspace;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  let parent: FileHandle | undefined, file: FileHandle | undefined;
  try {
    parent = await openDirectory(dirname(resolved));
    const entry = `/proc/self/fd/${parent.fd}/${basename(resolved)}`;
    file = await open(entry, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const data = await readBounded(file, maxBytes);
    const after = await file.stat(), named = await lstat(entry);
    if (named.isSymbolicLink() || named.ino !== after.ino || named.dev !== after.dev) {
      throw new SafeError("Reference image changed during read.");
    }
    // Detect an ancestor rename without ever following its replacement to read bytes.
    const current = await openDirectory(dirname(resolved));
    try {
      const held = await parent.stat(), replaced = await current.stat();
      if (held.ino !== replaced.ino || held.dev !== replaced.dev) throw new SafeError("Reference image directory changed during read.");
    } finally {
      await current.close();
    }
    return { path: resolved, data };
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw outsideWorkspace;
  } finally {
    await file?.close().catch(() => {});
    await parent?.close().catch(() => {});
  }
}

/** Read reference images for image-to-image: bounded count/size, workspace-contained, real image bytes. */
export async function readReferenceImages(cwd: string, paths: unknown): Promise<ReferenceImage[]> {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw new SafeError("inputPaths must be an array of file paths.");
  if (paths.length > MAX_REFERENCE_IMAGES) throw new SafeError(`At most ${MAX_REFERENCE_IMAGES} reference images are supported.`);
  const images: ReferenceImage[] = [];
  let total = 0;
  for (const entry of paths) {
    if (typeof entry !== "string" || !entry.trim()) throw new SafeError("Reference image paths must be non-empty strings.");
    const file = await readReferenceFile(cwd, entry.trim(), MAX_REFERENCE_BYTES);
    const data = file.data;
    if (!data.length) throw new SafeError("Reference images are limited to 20 MB each.");
    if (total + data.length > MAX_REFERENCE_TOTAL_BYTES) throw new SafeError("Reference images are limited to 32 MB in total.");
    total += data.length;
    if (total > MAX_REFERENCE_TOTAL_BYTES) throw new SafeError("Reference images are limited to 32 MB in total.");
    const mime = detectImageMime(data);
    if (!mime) throw new SafeError("Reference images must be PNG, JPEG, WebP, or GIF files.");
    images.push({ dataUrl: `data:${mime};base64,${data.toString("base64")}`, mime, bytes: data.length, filename: basename(file.path) });
  }
  return images;
}

export interface ResolvedOutput {
  /** Canonical working directory used for the final containment check. */
  root: string;
  directory: string;
  /** Present for a file target; absent when the target is a directory. */
  filename?: string;
}

/**
 * Resolve the output path: caller-specified file/directory or the workspace
 * artifacts default. The lexical target is contained in realpath(cwd), and no
 * existing component may be a symlink. Directory targets keep the generated
 * timestamped filename; saveImage rechecks containment after creating them.
 */
export async function resolveOutputPath(cwd: string, outputPath: unknown): Promise<ResolvedOutput> {
  const root = await canonicalRoot(cwd);
  const requested = outputPath === undefined || outputPath === null ? undefined : outputPath;
  if (requested !== undefined && (typeof requested !== "string" || !requested.trim())) {
    throw new SafeError("outputPath must be a non-empty string.");
  }
  const raw = requested === undefined ? "artifacts" : requested.trim();
  const target = resolve(root, raw);
  if (!within(root, target) || target === root) throw new SafeError(OUTPUT_ESCAPE);
  await rejectSymlinkComponents(root, target);

  let info: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SafeError("Output paths could not be inspected safely.");
  }
  const directoryIntent = requested === undefined || raw.endsWith("/");
  if (info) {
    if (info.isSymbolicLink()) throw new SafeError("Output paths must not be symbolic links.");
    if (info.isDirectory()) return { root, directory: target };
    if (directoryIntent) throw new SafeError("outputPath refers to an existing file, not a directory.");
    if (!info.isFile()) throw new SafeError("Output path must be a regular file or directory.");
    return { root, directory: dirname(target), filename: basename(target) };
  }
  if (directoryIntent) return { root, directory: target };
  return { root, directory: dirname(target), filename: basename(target) };
}
