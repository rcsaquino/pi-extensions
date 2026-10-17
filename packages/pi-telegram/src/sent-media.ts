import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";

// Best-effort private index of message-id -> local file copies the bridge itself
// sent or downloaded. It exists only so a later same-chat reply can reference the
// exact local file instead of metadata alone. It never stores bytes, file_ids or URLs,
// and every failure is swallowed: transport results never depend on this index.
const MAX_ENTRIES = 1024;
const MAX_AGE_MS = 90 * 86400_000;

export type SentMediaSource = "outbound" | "inbound";
export interface SentMediaEntry {
  chat: number;
  message: number;
  path: string;
  kind: string;
  source: SentMediaSource;
  at: number;
}
/** A record call may let the registry stamp `at`, then only valid fields are stored. */
export interface SentMediaRecord extends Omit<SentMediaEntry, "at"> { at?: number }

function key(chat: number, message: number): string { return `${chat}:${message}`; }
function id(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function parse(value: unknown): SentMediaEntry | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const chat = id(record.chat), message = id(record.message), at = id(record.at);
  if (chat === undefined || message === undefined || at === undefined) return;
  if (typeof record.path !== "string" || !record.path || !isAbsolute(record.path)) return;
  if (typeof record.kind !== "string" || !/^[a-z][a-z_]{0,31}$/.test(record.kind)) return;
  if (record.source !== "outbound" && record.source !== "inbound") return;
  return { chat, message, path: record.path, kind: record.kind, source: record.source, at };
}

export class SentMediaRegistry {
  private entries = new Map<string, SentMediaEntry>();
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}

  /** Missing, corrupt or unreadable state starts empty; invalid records are dropped. */
  async load(): Promise<void> {
    this.entries.clear();
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      const list = Array.isArray(raw) ? raw
        : raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : [];
      for (const value of list) {
        const entry = parse(value);
        if (entry) this.entries.set(key(entry.chat, entry.message), entry);
      }
      this.prune(Date.now());
    } catch { this.entries.clear(); }
  }

  /** Append valid records, prune, then persist atomically. Never rejects. */
  async record(records: readonly SentMediaRecord[]): Promise<void> {
    try {
      const now = Date.now();
      for (const value of records ?? []) {
        try {
          // One malformed record must not drop the rest of the batch.
          const entry = parse({ ...value, at: (value as { at?: unknown })?.at ?? now });
          if (entry) this.entries.set(key(entry.chat, entry.message), entry);
        } catch { /* skip a hostile or unreadable single record */ }
      }
      this.prune(now);
      const snapshot = [...this.entries.values()];
      this.writes = this.writes.then(() => this.persist(snapshot));
      await this.writes;
    } catch { /* Indexing must never change a send or receive result. */ }
  }

  lookup(chat: number, message: number): SentMediaEntry | undefined {
    const chatId = id(chat), messageId = id(message);
    return chatId === undefined || messageId === undefined ? undefined : this.entries.get(key(chatId, messageId));
  }

  clear(): void { this.entries.clear(); }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) if (now - entry.at > MAX_AGE_MS) this.entries.delete(id);
    if (this.entries.size <= MAX_ENTRIES) return;
    const newest = [...this.entries.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
    this.entries = new Map(newest.map(entry => [key(entry.chat, entry.message), entry]));
  }

  private async persist(entries: SentMediaEntry[]): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      await rename(temp, this.path);
    } catch { await rm(temp, { force: true }).catch(() => {}); }
  }
}
