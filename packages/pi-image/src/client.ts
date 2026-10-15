import { OPENROUTER_IMAGES_URL } from "./auth.ts";
import { redactKey, SafeError } from "./errors.ts";
import type { ReferenceImage } from "./validate.ts";

export type Fetch = typeof globalThis.fetch;

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

export interface GenerateRequest {
  key: string;
  model: string;
  prompt: string;
  size?: string;
  references?: ReferenceImage[];
  signal?: AbortSignal;
}

export interface GeneratedBytes {
  data: Buffer;
  /** Provider-declared media type, when identifiable. */
  mediaType?: string;
}

interface InputReference {
  type: "image_url";
  image_url: { url: string };
}

/** Read a response body with a hard byte cap; never returns partial over-limit data. */
async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const announced = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(announced) && announced > limit) {
    await response.body?.cancel().catch(() => {});
    throw new SafeError("Provider response exceeds the supported size limit.");
  }
  if (!response.body) throw new SafeError("Empty provider response.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new SafeError("Provider response exceeds the supported size limit.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Extract a short, credential-free provider error message when the API supplies one. */
async function providerMessage(response: Response, key: string): Promise<string | undefined> {
  try {
    const body = JSON.parse((await readCapped(response, 64 * 1024)).toString());
    const message = body?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return redactKey(message.trim().slice(0, 200), key);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function statusError(status: number, detail?: string): SafeError {
  const suffix = detail ? ` ${detail}` : "";
  if (status === 401) return new SafeError(`OpenRouter authentication failed. Check the stored OpenRouter login (/login for openrouter).${suffix}`);
  if (status === 402) return new SafeError(`OpenRouter payment required: image generation needs credits or an active key.${suffix}`);
  if (status === 404) return new SafeError(`OpenRouter image model or endpoint not found.${suffix}`);
  if (status === 429) return new SafeError(`OpenRouter rate limit reached; try again later.${suffix}`);
  return new SafeError(`OpenRouter image generation failed (HTTP ${status}).${suffix}`);
}

/**
 * Direct call to POST /api/v1/images/generations with the stored key.
 * pi-ai Models.generateImages() uses chat/completions and returns 404 for
 * image models with a message to use the /api/v1/images endpoint, so this
 * client calls the Images API directly. No key, prompt, or raw body ever
 * appears in thrown errors.
 */
export async function generateImageBytes(request: GenerateRequest, fetcher: Fetch = globalThis.fetch): Promise<GeneratedBytes> {
  const { key, model, prompt, size, references, signal } = request;
  const body: Record<string, unknown> = { model, prompt };
  if (size) body["size"] = size;
  if (references?.length) {
    const inputReferences: InputReference[] = references.map(image => ({ type: "image_url", image_url: { url: image.dataUrl } }));
    body["input_references"] = inputReferences;
  }
  let response: Response;
  try {
    signal?.throwIfAborted();
    response = await fetcher(OPENROUTER_IMAGES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError(signal?.aborted ? "Image generation was cancelled." : "Image generation request failed. Check connectivity and try again.");
  }
  if (!response.ok) {
    throw statusError(response.status, await providerMessage(response, key));
  }
  const raw = await readCapped(response, MAX_RESPONSE_BYTES);
  let parsed: { data?: { b64_json?: unknown; url?: unknown; media_type?: unknown }[] };
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    throw new SafeError("OpenRouter returned an unreadable image response.");
  }
  const item = Array.isArray(parsed?.data) ? parsed.data[0] : undefined;
  const mediaType = typeof item?.media_type === "string" ? item.media_type : undefined;
  if (typeof item?.b64_json === "string" && item.b64_json.length) {
    let data: Buffer;
    try {
      data = Buffer.from(item.b64_json, "base64");
    } catch {
      throw new SafeError("OpenRouter returned unreadable image bytes.");
    }
    if (!data.length) throw new SafeError("OpenRouter returned unreadable image bytes.");
    return { data, mediaType };
  }
  // Some models return a URL instead of inline bytes; fetch it without credentials.
  if (typeof item?.url === "string" && item.url.startsWith("https://")) {
    let image: Response;
    try {
      image = await fetcher(item.url, {
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SafeError("Image download failed. Check connectivity and try again.");
    }
    if (!image.ok) throw new SafeError(`Image download failed (HTTP ${image.status}).`);
    const type = image.headers.get("content-type") || mediaType;
    if (type && !type.startsWith("image/")) throw new SafeError("Image download did not return image bytes.");
    return { data: await readCapped(image, MAX_RESPONSE_BYTES), mediaType: type || undefined };
  }
  throw new SafeError("OpenRouter returned no image data.");
}
