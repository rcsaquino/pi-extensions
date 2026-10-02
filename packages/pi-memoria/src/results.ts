import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Memory, SearchMode } from "./database.ts";
import { ExpectedError } from "./errors.ts";
import type { HotMemory, HotSnapshot } from "./hot-memory.ts";
import { RESULT_BYTES } from "./text.ts";

export interface HotWriteResult extends HotSnapshot {
  cap: number;
  store: "hot";
  memory: HotMemory;
  created?: boolean;
  note?: string;
  ignored_fields?: string[];
  warnings?: string[];
}

export interface HotDeleteResult extends HotSnapshot {
  cap: number;
  store: "hot";
  deleted: HotMemory;
}

export interface LongTermWriteResult {
  store: "long_term";
  memory: Memory;
  created?: boolean;
  note?: string;
}

export interface LongTermDeleteResult { store: "long_term"; deleted: Memory }

export interface SearchRow extends Memory {
  content_characters: number;
  content_clipped: boolean;
}

export interface SearchDetails {
  mode: SearchMode | "browse";
  query: string;
  tags: string[];
  alias_expansion_enabled: boolean;
  expansions: Array<{ term: string; aliases: string[] }>;
  warnings: string[];
  results: SearchRow[];
  next_offset: number | null;
  elapsed_ms: number;
  hint: string;
}

export interface MemoryReadDetails extends Memory {
  content: string;
  next_text_offset: number | null;
  total_characters: number;
}

export interface SessionHit {
  entry_type: string;
  entry_id: string | null;
  parent_id: string | null;
  role: string | null;
  timestamp: string | null;
  text: string;
  text_clipped?: boolean;
  path: string;
  line: number;
  citation: string;
}

export interface SessionSearchDetails {
  results: SessionHit[];
  next_offset: number | null;
  exhausted: boolean;
  roots: string[];
  warnings: string[];
  candidate_entries: number;
  elapsed_ms: number;
  hint: string;
}

export interface SessionReadDetails {
  entry_type: string;
  entry_id: string | null;
  parent_id: string | null;
  role: string | null;
  timestamp: string | null;
  text: string;
  next_text_offset: number | null;
  total_characters: number;
  path: string;
  line: number;
  citation: string;
  next_line: number;
  hint: string;
  warnings?: string[];
}

/** Drop a UTF-8 prefix without splitting a multibyte sequence or surrogate pair. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const encoded = Buffer.from(text, "utf8");
  let end = Math.min(maxBytes, encoded.length);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}

/** Bound model-facing text to RESULT_BYTES, spilling the complete structured payload to a private file. */
async function capped(text: string, details: unknown, purpose: string): Promise<string> {
  if (Buffer.byteLength(text) <= RESULT_BYTES) return text;
  const serialized = JSON.stringify(details, null, 2);
  let notice: string;
  try {
    const directory = await mkdtemp(join(tmpdir(), "pi-memoria-result-"));
    const path = join(directory, "result.json");
    await withFileMutationQueue(path, () => writeFile(path, serialized, { mode: 0o600 }));
    notice = `\n\n[Response clipped to the ${RESULT_BYTES}-byte model-facing budget. ${purpose} (${Buffer.byteLength(serialized)} bytes) is at ${path}. Follow next_offset/next_text_offset or archived IDs in that file to retrieve the rest.]`;
  } catch (error) {
    notice = `\n\n[Response clipped and the complete details could not be saved: ${(error as Error).message}. Use narrower queries and pagination to retrieve the remainder.]`;
  }
  const budget = RESULT_BYTES - Buffer.byteLength(notice) - 1;
  return `${truncateUtf8(text, Math.max(0, budget))}${notice}`;
}

export async function reply(details: unknown, text: string) {
  return { content: [{ type: "text" as const, text: await capped(text, details, "Complete structured result") }], details };
}

/**
 * Boundary renderer for expected errors. Unexpected errors and aborts are
 * rethrown unchanged so Pi still reports their real identity.
 */
export async function toolError(error: unknown): Promise<never> {
  if (!(error instanceof ExpectedError)) throw error;
  const details = { code: error.code, message: error.message, ...error.details };
  const heading = `memoria error [${error.code}]: ${error.message}`;
  const body = Object.keys(error.details).length ? `${heading}\n${JSON.stringify(details, null, 2)}` : heading;
  throw new Error(await capped(body, details, "Complete error details"), { cause: error });
}

function tagList(tags: string[]): string {
  return tags.length ? tags.join(", ") : "(none)";
}

export function renderHotWrite(operation: string, details: HotWriteResult): string {
  const lines = [
    `${operation}: hot${details.created === undefined ? "" : `; created=${details.created}`}`,
    `id=${details.memory.id} priority=${details.memory.priority}`,
    `content: ${details.memory.content}`,
    `budget: ${details.characters}/${details.cap} characters used; ${details.remaining} remaining`,
  ];
  if (details.archived.length) {
    lines.push(`archived: ${details.archived.map((entry) => entry.id).join(", ")} — saved in SQLite with tag hot-archive; retrieve with memoria_search query "hot-archive" or by the archived source IDs.`);
  }
  if (details.backup) lines.push(`backup: ${details.backup}`);
  if (details.ignored_fields?.length) lines.push(`ignored_fields: ${details.ignored_fields.join(", ")} (hot memory stores content and priority only)`);
  for (const warning of details.warnings ?? []) lines.push(`warning: ${warning}`);
  if (details.note) lines.push(`note: ${details.note}`);
  return lines.join("\n");
}

export function renderHotDelete(details: HotDeleteResult): string {
  return [
    "memoria_delete: hot",
    `id=${details.deleted.id} priority=${details.deleted.priority}`,
    `content: ${details.deleted.content}`,
    `budget: ${details.characters}/${details.cap} characters used; ${details.remaining} remaining`,
    "note: Explicit deletion does not archive the entry and does not erase original sessions.",
  ].join("\n");
}

export function renderLongTermWrite(operation: string, details: LongTermWriteResult): string {
  const lines = [
    `${operation}: long_term${details.created === undefined ? "" : `; created=${details.created}`}`,
    `id=${details.memory.id} revision=${details.memory.revision}`,
    `content: ${details.memory.content}`,
    `tags: ${tagList(details.memory.tags)}`,
    `source: ${details.memory.source || "(none)"}`,
    `timestamps: created=${details.memory.created_at}; updated=${details.memory.updated_at}`,
  ];
  if (details.note) lines.push(`note: ${details.note}`);
  return lines.join("\n");
}

export function renderLongTermDelete(details: LongTermDeleteResult): string {
  const item = details.deleted;
  return [
    "memoria_delete: long_term",
    `id=${item.id} revision=${item.revision}`,
    `content: ${item.content}`,
    `tags: ${tagList(item.tags)}`,
    `source: ${item.source || "(none)"}`,
    `timestamps: created=${item.created_at}; updated=${item.updated_at}`,
    "note: Explicit deletion does not erase original sessions or earlier backups.",
  ].join("\n");
}

export function renderSearch(details: SearchDetails): string {
  const lines = [
    `memoria_search:${details.query ? ` query=${JSON.stringify(details.query)}` : ""} ${details.results.length} result(s); mode=${details.mode}; next_offset=${details.next_offset ?? "null"}`,
  ];
  if (details.tags.length) lines.push(`required tags (exact, case-sensitive): ${details.tags.join(", ")}`);
  if (details.alias_expansion_enabled) {
    lines.push(details.expansions.length
      ? `aliases used in query: ${details.expansions.map((value) => `${value.term} -> ${value.aliases.join(", ")}`).join("; ")}`
      : "alias expansion enabled; no configured alternatives applied to this query");
  }
  for (const warning of details.warnings) lines.push(`warning: ${warning}`);
  for (const row of details.results) {
    lines.push(
      `[${row.id}] revision=${row.revision}; tags=[${row.tags.join(", ")}]`,
      `${row.content}${row.content_clipped ? " …" : ""}`,
      `source: ${row.source || "(none)"}; created ${row.created_at}; updated ${row.updated_at}`,
    );
  }
  if (!details.results.length) lines.push("No results on this page. Follow the hint before concluding that nothing is stored.");
  lines.push(`hint: ${details.hint}`);
  return lines.join("\n");
}

export function renderMemoryRead(details: MemoryReadDetails): string {
  return [
    `memoria_search: id=${details.id}; revision=${details.revision}`,
    `tags: ${tagList(details.tags)}; source: ${details.source || "(none)"}`,
    `timestamps: created=${details.created_at}; updated=${details.updated_at}`,
    `content (characters ${details.content.length} of ${details.total_characters}):`,
    details.content,
    `next_text_offset=${details.next_text_offset ?? "null"}`,
  ].join("\n");
}

export function renderSessionSearch(details: SessionSearchDetails): string {
  const lines = [
    `memoria_sessions: ${details.results.length} result(s); next_offset=${details.next_offset ?? "null"}; exhausted=${details.exhausted}; candidate_entries=${details.candidate_entries}`,
    `roots (${details.roots.length}): ${details.roots.join(", ") || "(none)"}`,
  ];
  for (const warning of details.warnings) lines.push(`warning: ${warning}`);
  for (const hit of details.results) {
    const ids = [hit.entry_id ? `entry=${hit.entry_id}` : undefined, hit.parent_id ? `parent=${hit.parent_id}` : undefined].filter(Boolean).join("; ");
    lines.push(
      `[${hit.entry_type}${hit.role ? `/${hit.role}` : ""}] ${hit.citation}${ids ? `; ${ids}` : ""}${hit.timestamp ? `; time=${hit.timestamp}` : ""}${hit.text_clipped ? "; preview clipped" : ""}`,
      hit.text,
    );
  }
  if (!details.results.length) lines.push("No results on this page. An incomplete search is not proof of absence; check warnings and follow the hint.");
  lines.push(`hint: ${details.hint}`);
  return lines.join("\n");
}

export function renderSessionRead(details: SessionReadDetails): string {
  const lines = [
    `memoria_sessions: read ${details.citation}; type=${details.entry_type}; role=${details.role ?? "(none)"}; entry_id=${details.entry_id ?? "(none)"}; parent_id=${details.parent_id ?? "(none)"}; timestamp=${details.timestamp ?? "(none)"}`,
  ];
  for (const warning of details.warnings ?? []) lines.push(`warning: ${warning}`);
  lines.push(
    `text (characters ${details.text.length} of ${details.total_characters}):`,
    details.text,
    `next_text_offset=${details.next_text_offset ?? "null"}; next_line=${details.next_line}`,
    `hint: ${details.hint}`,
  );
  return lines.join("\n");
}
