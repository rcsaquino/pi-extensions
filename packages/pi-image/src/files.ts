import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SafeError } from "./errors.ts";
import { OUTPUT_ESCAPE, rejectSymlinkComponents, within } from "./paths.ts";

export const MIN_IMAGE_BYTES = 1024;

export type SavedMime = "image/png" | "image/jpeg";

/** PNG or JPEG magic only: generated outputs are verified raster bytes, never SVG or text. */
export function detectSavedMime(data: Buffer): SavedMime | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  return undefined;
}

/** Any common raster input magic, for reference images (outputs stay PNG/JPEG). */
export function detectImageMime(data: Buffer): string | undefined {
  const saved = detectSavedMime(data);
  if (saved) return saved;
  if (data.length >= 12 && data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (data.length >= 6 && /^GIF8[79]a/.test(data.subarray(0, 6).toString())) return "image/gif";
  return undefined;
}

/** Lowercase hyphenated slug from prompt words; always non-empty, at most 40 chars. */
export function slugify(prompt: string): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug || "image";
}

export function stampSlug(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Normalize a caller filename to lowercase hyphenated form with a safe image extension. */
export function safeFilename(name: string, mime: SavedMime): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "") || "image";
  return `${base}.${mime === "image/png" ? "png" : "jpg"}`;
}

export interface SavedImage {
  path: string;
  bytes: number;
  mime: SavedMime;
}

export interface SaveImageOptions {
  /** Canonical working directory; when present the created directory is rechecked against it. */
  root?: string;
  /** Replace an existing regular file. Off by default, so a save never destroys an earlier image implicitly. */
  overwrite?: boolean;
}

/**
 * Verify PNG/JPEG bytes and size, then save under the workspace directory.
 * When a root is supplied, the actual destination parent is canonicalized and
 * rechecked after creation; symlink parents and a symlink final component are
 * refused. O_NOFOLLOW closes the final-component check/write race on Linux.
 * Returns the saved path and metadata only, never the bytes.
 */
export async function saveImage(
  directory: string,
  data: Buffer,
  prompt: string,
  filename?: string,
  options: SaveImageOptions = {},
): Promise<SavedImage> {
  const mime = detectSavedMime(data);
  if (!mime) throw new SafeError("The provider did not return PNG or JPEG image bytes.");
  if (data.length < MIN_IMAGE_BYTES) throw new SafeError("The provider returned an image too small to be usable.");
  const root = options.root;
  if (root && !within(root, resolve(directory))) throw new SafeError(OUTPUT_ESCAPE);
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory).catch(() => { throw new SafeError("The output directory could not be resolved."); });
  if (root) {
    if (!within(root, actual)) throw new SafeError(OUTPUT_ESCAPE);
    // Recheck the lexical path after creation so a symlinked parent (including
    // the default artifacts/ directory) is refused even when it points inside.
    await rejectSymlinkComponents(root, resolve(directory));
    await rejectSymlinkComponents(root, actual);
  } else {
    const inspected = await lstat(directory);
    if (inspected.isSymbolicLink()) throw new SafeError("Output paths must not traverse a symbolic link.");
  }
  const extension = mime === "image/png" ? "png" : "jpg";
  const name = filename
    ? safeFilename(filename.replace(/\.[a-z0-9]+$/i, ""), mime)
    : `image-${slugify(prompt)}-${stampSlug()}-${randomBytes(3).toString("hex")}.${extension}`;
  const path = join(actual, name);
  let existing;
  try {
    existing = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink()) throw new SafeError("Output paths must not be symbolic links.");
    if (existing.isDirectory()) throw new SafeError("Output path must be a regular file.");
    if (!existing.isFile()) throw new SafeError("Output path must be a regular file.");
    if (!options.overwrite) throw new SafeError("Output file already exists; pass overwrite: true to replace it.");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  // Never truncate the destination in place: a complete, fsynced temp file is
  // linked (new name) or renamed (explicit overwrite) only after the write.
  const temporary = join(actual, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new SafeError("Output paths must not be symbolic links.");
    throw error;
  }
  try {
    await handle.writeFile(data);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (options.overwrite) {
      await rename(temporary, path);
    } else {
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new SafeError("Output file already exists; pass overwrite: true to replace it.");
        }
        throw error;
      }
      await unlink(temporary);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { path, bytes: data.length, mime };
}
