import { closeSync, openSync, readSync } from "node:fs";
import { isMissing } from "./files.ts";

export const MAX_ALIAS_FILE_BYTES = 64 * 1024;
export const MAX_ALIAS_KEYS = 256;
export const MAX_ALIAS_TARGETS = 8;
export const MAX_ALIAS_TOKEN_UNITS = 80;
export const MAX_ADDED_ALTERNATIVES = 128;

const TOKEN = /^[\p{L}\p{N}\p{M}_]+$/u;

/** Directional, one-hop terminology alternatives. User keys replace these entries wholesale. */
const BUILT_IN: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["k8s", ["kubernetes"]],
  ["db", ["database"]],
  ["repo", ["repository"]],
  ["prefs", ["preferences"]],
];

export interface AliasConfiguration { aliases: Map<string, string[]>; warning?: string }
export interface QueryExpansion { expansions: Array<{ term: string; aliases: string[] }>; warning?: string }

function boundedRead(path: string): { text: string; bytes: number } {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_ALIAS_FILE_BYTES + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytes).toString("utf8"), bytes };
  } finally {
    closeSync(descriptor);
  }
}

function invalid(aliases: Map<string, string[]>, reason: string): AliasConfiguration {
  return { aliases, warning: `${reason} Built-in aliases remain active; fix or remove the file and restart Pi or /reload.` };
}

/**
 * Load optional `synonyms.json` from the global memory directory. A missing
 * file is normal. Any malformed, unreadable, or oversized file is ignored
 * whole so a partial configuration is never merged.
 */
export function loadAliases(path?: string): AliasConfiguration {
  const aliases = new Map<string, string[]>(BUILT_IN.map(([key, targets]) => [key, [...targets]]));
  if (!path) return { aliases };
  let text: string;
  try {
    const read = boundedRead(path);
    if (read.bytes > MAX_ALIAS_FILE_BYTES) return invalid(aliases, `synonyms.json is larger than ${MAX_ALIAS_FILE_BYTES} bytes and was ignored.`);
    text = read.text;
  } catch (error) {
    if (isMissing(error)) return { aliases };
    return invalid(aliases, `synonyms.json could not be read (${(error as Error).message}) and was ignored.`);
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return invalid(aliases, "synonyms.json is not valid JSON and was ignored."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(aliases, "synonyms.json must be a JSON object mapping single tokens to arrays of single tokens.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ALIAS_KEYS) return invalid(aliases, `synonyms.json has more than ${MAX_ALIAS_KEYS} keys and was ignored.`);
  const user = new Map<string, string[]>();
  for (const [key, targets] of entries) {
    const normalized = key.trim().toLowerCase();
    if (!TOKEN.test(normalized) || normalized.length > MAX_ALIAS_TOKEN_UNITS) {
      return invalid(aliases, `synonyms.json key ${JSON.stringify(key)} is invalid: keys must be single tokens of at most ${MAX_ALIAS_TOKEN_UNITS} characters.`);
    }
    if (user.has(normalized)) return invalid(aliases, `synonyms.json contains duplicate key ${JSON.stringify(normalized)} after lowercasing and was ignored.`);
    if (!Array.isArray(targets) || targets.length > MAX_ALIAS_TARGETS) {
      return invalid(aliases, `synonyms.json key ${JSON.stringify(key)} must map to an array of at most ${MAX_ALIAS_TARGETS} tokens.`);
    }
    const list: string[] = [];
    for (const target of targets) {
      if (typeof target !== "string") {
        return invalid(aliases, `synonyms.json key ${JSON.stringify(key)} contains a non-string alternative.`);
      }
      const normalizedTarget = target.trim().toLowerCase();
      if (!TOKEN.test(normalizedTarget) || normalizedTarget.length > MAX_ALIAS_TOKEN_UNITS) {
        return invalid(aliases, `synonyms.json alternative ${JSON.stringify(target)} is invalid: alternatives must be single tokens of at most ${MAX_ALIAS_TOKEN_UNITS} characters.`);
      }
      if (normalizedTarget !== normalized && !list.includes(normalizedTarget)) list.push(normalizedTarget);
    }
    user.set(normalized, list);
  }
  for (const [key, targets] of user) aliases.set(key, targets);
  return { aliases };
}

/** One-hop expansion for the original query tokens, bounded in total added alternatives. */
export function expandQuery(terms: string[], aliases: Map<string, string[]>): QueryExpansion {
  const expansions: Array<{ term: string; aliases: string[] }> = [];
  let added = 0;
  for (const term of terms) {
    const alternatives = aliases.get(term.toLowerCase()) ?? [];
    if (!alternatives.length) continue;
    added += alternatives.length;
    expansions.push({ term, aliases: alternatives });
  }
  if (added > MAX_ADDED_ALTERNATIVES) {
    return { expansions: [], warning: `Alias expansion adds ${added} alternatives, over the ${MAX_ADDED_ALTERNATIVES}-term limit; the original terms were searched unexpanded.` };
  }
  return { expansions };
}
