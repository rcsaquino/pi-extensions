import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_MODEL } from "./auth.ts";
import { SafeError } from "./errors.ts";
import { detectImageMime } from "./files.ts";

export const MAX_PROMPT_LENGTH = 4000;
export const MAX_REFERENCE_IMAGES = 3;
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
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

/** Resolve a workspace-relative path to its real location, refusing escapes via .. or symlinks. */
async function insideRoot(root: string, candidate: string): Promise<string> {
  const base = await realpath(root);
  const resolved = await realpath(resolve(base, candidate));
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || rel === "") {
    throw new SafeError("Reference images must be existing files inside the Pi working directory.");
  }
  return resolved;
}

const outsideWorkspace = new SafeError("Reference images must be existing files inside the Pi working directory.");

/** Read reference images for image-to-image: bounded count/size, workspace-contained, real image bytes. */
export async function readReferenceImages(cwd: string, paths: unknown): Promise<ReferenceImage[]> {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw new SafeError("inputPaths must be an array of file paths.");
  if (paths.length > MAX_REFERENCE_IMAGES) throw new SafeError(`At most ${MAX_REFERENCE_IMAGES} reference images are supported.`);
  const images: ReferenceImage[] = [];
  for (const entry of paths) {
    if (typeof entry !== "string" || !entry.trim()) throw new SafeError("Reference image paths must be non-empty strings.");
    let resolved: string;
    try {
      resolved = await insideRoot(cwd, entry.trim());
    } catch {
      throw outsideWorkspace;
    }
    let size = 0;
    try {
      size = (await stat(resolved)).size;
    } catch {
      throw outsideWorkspace;
    }
    if (size <= 0 || size > MAX_REFERENCE_BYTES) throw new SafeError("Reference images are limited to 20 MB each.");
    let data: Buffer;
    try {
      data = await readFile(resolved);
    } catch {
      throw outsideWorkspace;
    }
    if (data.length > MAX_REFERENCE_BYTES) throw new SafeError("Reference images are limited to 20 MB each.");
    const mime = detectImageMime(data);
    if (!mime) throw new SafeError("Reference images must be PNG, JPEG, WebP, or GIF files.");
    images.push({ dataUrl: `data:${mime};base64,${data.toString("base64")}`, mime, bytes: data.length, filename: basename(resolved) });
  }
  return images;
}

/** Resolve the output path: caller-specified or the workspace artifacts default. Always inside cwd. */
export async function resolveOutputPath(cwd: string, outputPath: unknown): Promise<{ directory: string; filename?: string }> {
  if (outputPath === undefined || outputPath === null) return { directory: resolve(cwd, "artifacts") };
  if (typeof outputPath !== "string" || !outputPath.trim()) throw new SafeError("outputPath must be a non-empty string.");
  const base = await realpath(cwd).catch(() => resolve(cwd));
  const resolved = resolve(base, outputPath.trim());
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || !rel) {
    throw new SafeError("Output must stay inside the Pi working directory.");
  }
  return { directory: dirname(resolved), filename: basename(resolved) };
}
