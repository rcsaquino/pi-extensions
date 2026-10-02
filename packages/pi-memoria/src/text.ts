import { ExpectedError } from "./errors.ts";

export const HOT_LIMIT = 5_000;
export const MEMORY_LIMIT = 20_000;
export const RESULT_BYTES = 32_000;

export function nonempty(value: string, name: string, max = MEMORY_LIMIT): string {
  const text = value.trim();
  if (!text || text.includes("\0") || text.length > max) {
    throw new ExpectedError("invalid_input", `${name} must contain 1–${max} characters and no NUL bytes.`, { field: name });
  }
  return text;
}

export function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ExpectedError("invalid_input", `${name} must be an integer from ${min} to ${max}.`, { field: name, min, max });
  }
  return value;
}

export function tags(value: string[] = []): string[] {
  if (value.length > 30) throw new ExpectedError("invalid_input", "Use at most 30 tags.", { field: "tags", max_items: 30 });
  return [...new Set(value.map((tag) => nonempty(tag, "tag", 80)))];
}

/** Hot content must be one literal line; internal spacing is preserved exactly. */
export function singleLine(value: string, name = "content", max = MEMORY_LIMIT): string {
  if (/[\r\n\u2028\u2029]/u.test(value)) {
    throw new ExpectedError("invalid_input", `${name} must be a single line. Replace the line break with a space, or save multiline content in SQLite.`, { field: name });
  }
  return nonempty(value, name, max);
}

/** Do not split a surrogate pair when clipping or paging text. */
export function chunk(text: string, offset = 0, limit = 6_000) {
  integer(offset, "text_offset", 0, Number.MAX_SAFE_INTEGER);
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  return { text: text.slice(offset, end), next_text_offset: end < text.length ? end : null, total_characters: text.length };
}

export function excerpt(text: string, needle = "", limit = 600): string {
  const index = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : 0;
  const start = Math.max(0, index - 120);
  const part = chunk(text, start, limit);
  return `${start ? "…" : ""}${part.text}${part.next_text_offset === null ? "" : "…"}`;
}
