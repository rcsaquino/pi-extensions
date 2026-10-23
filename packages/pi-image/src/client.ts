import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { OPENROUTER_IMAGES_URL } from "./auth.ts";
import { SafeError } from "./errors.ts";
import type { ReferenceImage } from "./validate.ts";

export type Fetch = typeof globalThis.fetch;
export type ResolveHost = (hostname: string) => Promise<{ address: string; family: number }[]>;

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

const RESOLVE_HOST: ResolveHost = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
};

function privateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19));
}

/** Reject loopback, private, link-local, multicast and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateV4(address);
  if (family !== 6) return true;
  const value = address.toLowerCase();
  if (value === "::" || value === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return privateV4(mapped[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16), low = Number.parseInt(mappedHex[2]!, 16);
    return privateV4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true; // fe80::/10 link-local
  if (/^fe[c-f][0-9a-f]:/.test(value)) return true; // fec0::/10 deprecated site-local
  if (/^ff[0-9a-f]{2}:/.test(value)) return true; // multicast
  return false;
}

/**
 * Validate a provider-supplied download URL. Only HTTPS on the default port is
 * accepted, and every resolved address must be public. Resolution happens
 * before the request; redirects stay disabled and the byte cap still applies.
 */
export async function assertSafeDownloadUrl(raw: string, resolveHost: ResolveHost = RESOLVE_HOST): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeError("Image download URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new SafeError("Image download URL must use HTTPS on the default port.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new SafeError("Image download URL has no host.");
  let addresses: { address: string; family: number }[];
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await resolveHost(hostname);
    } catch {
      throw new SafeError("Image download host could not be resolved safely.");
    }
  }
  if (!addresses.length || addresses.some((record) => isPrivateAddress(record.address))) {
    throw new SafeError("Image download URL resolves to a private, loopback, or link-local address.");
  }
  return url;
}

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

function statusError(status: number): SafeError {
  if (status === 401) return new SafeError("OpenRouter authentication failed. Check OPENROUTER_API_KEY in .env or the stored OpenRouter login (/login for openrouter).");
  if (status === 402) return new SafeError("OpenRouter payment required: image generation needs credits or an active key.");
  if (status === 404) return new SafeError("OpenRouter image model or endpoint not found.");
  if (status === 429) return new SafeError("OpenRouter rate limit reached; try again later.");
  return new SafeError(`OpenRouter image generation failed (HTTP ${status}).`);
}

/**
 * Direct call to POST /api/v1/images/generations with the stored key.
 * pi-ai Models.generateImages() uses chat/completions and returns 404 for
 * image models with a message to use the /api/v1/images endpoint, so this
 * client calls the Images API directly. No key, prompt, or raw body ever
 * appears in thrown errors.
 */
export async function generateImageBytes(
  request: GenerateRequest,
  fetcher: Fetch = globalThis.fetch,
  resolveHost: ResolveHost = RESOLVE_HOST,
): Promise<GeneratedBytes> {
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
    // Provider error text is arbitrary external content and may echo the prompt.
    throw statusError(response.status);
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
  if (typeof item?.url === "string") {
    const downloadUrl = await assertSafeDownloadUrl(item.url, resolveHost);
    let image: Response;
    try {
      image = await fetcher(downloadUrl, {
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
