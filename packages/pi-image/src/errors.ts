/** Credential-safe errors. Never carries keys, tokens, URLs, or raw provider bodies. */
export class SafeError extends Error {}

export function safeError(error: unknown): string {
  return error instanceof SafeError ? error.message : "Image generation failed. Check the stored OpenRouter login and connectivity.";
}

/** Remove every occurrence of the key from text; safe to call with an undefined key. */
export function redactKey(text: string, key?: string): string {
  if (key) text = text.split(key).join("[REDACTED]");
  return text;
}
