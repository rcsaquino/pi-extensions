import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeError } from "./errors.ts";

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

/**
 * Verify PNG/JPEG bytes and size, then save under the workspace directory.
 * Returns the saved path and metadata only, never the bytes.
 */
export async function saveImage(directory: string, data: Buffer, prompt: string, filename?: string): Promise<SavedImage> {
  const mime = detectSavedMime(data);
  if (!mime) throw new SafeError("The provider did not return PNG or JPEG image bytes.");
  if (data.length < MIN_IMAGE_BYTES) throw new SafeError("The provider returned an image too small to be usable.");
  await mkdir(directory, { recursive: true });
  const name = filename ? safeFilename(filename.replace(/\.[a-z0-9]+$/i, ""), mime) : `image-${slugify(prompt)}-${stampSlug()}.${mime === "image/png" ? "png" : "jpg"}`;
  const path = join(directory, name);
  await writeFile(path, data, { mode: 0o600 });
  return { path, bytes: data.length, mime };
}
