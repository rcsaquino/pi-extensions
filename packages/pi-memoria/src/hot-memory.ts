import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { atomicWrite, isMissing } from "./files.ts";
import { ExpectedError } from "./errors.ts";
import { HOT_LIMIT, integer, singleLine } from "./text.ts";

export interface HotMemory { id: string; priority: number; content: string }
export interface HotSnapshot { text: string; entries: HotMemory[]; characters: number; remaining: number; archived: HotMemory[]; backup?: string }
export interface HotAddResult extends HotSnapshot { memory: HotMemory; created: boolean; note?: string }
export interface HotEditResult extends HotSnapshot { memory: HotMemory }
export interface HotDeleteResult extends HotSnapshot { deleted: HotMemory }
type Queue = <T>(path: string, operation: () => Promise<T>) => Promise<T>;

function serialize(entries: HotMemory[]): string {
  return entries.map((entry) => `- [${entry.id}] [p=${entry.priority}] ${entry.content}\n`).join("");
}

function parse(text: string): HotMemory[] {
  const entries: HotMemory[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || /^#\s+MEMORY(?:\.md)?\s*$/iu.test(line)) continue;
    if (/^\s+\S/u.test(line) && entries.length) {
      entries[entries.length - 1]!.content += ` ${line.trim()}`;
      continue;
    }
    const body = line.replace(/^\s*[-*+]\s+/u, "").trim();
    const match = /^\[(h_[a-zA-Z0-9_-]+)\]\s+\[p=(\d+)\]\s+(.+)$/u.exec(body);
    const content = match ? match[3]! : body;
    const id = match ? match[1]! : `h_${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
    if (entries.some((entry) => entry.id === id)) throw new Error(`Duplicate hot memory ID ${id}; repair MEMORY.md before editing.`);
    entries.push({ id, priority: match ? integer(Number(match[2]), "priority", 0, 100) : 50, content });
  }
  return entries;
}

interface CapacityEntry { id: string; priority: number; characters: number; content: string }

function described(entry: HotMemory): CapacityEntry {
  return { id: entry.id, priority: entry.priority, characters: serialize([entry]).length, content: entry.content };
}

/**
 * Exact serialized diagnostics for a refused hot operation. `current` is the
 * pre-change list, `proposed` includes the requested add/edit, and `entry` is
 * the proposed or duplicated bullet.
 */
function capacityDetails(reason: string, operation: string, current: HotMemory[], proposed: HotMemory[], entry: HotMemory) {
  const currentCharacters = serialize(current).length;
  const proposedCharacters = serialize(proposed).length;
  const eligible = current
    .filter((item) => item.id !== entry.id && item.priority < entry.priority)
    .sort((a, b) => a.priority - b.priority)
    .map(described);
  const eligibleCharacters = eligible.reduce((sum, item) => sum + item.characters, 0);
  return {
    reason,
    operation,
    limit: HOT_LIMIT,
    current_characters: currentCharacters,
    proposed_characters: proposedCharacters,
    over_by: Math.max(0, proposedCharacters - HOT_LIMIT),
    remaining: Math.max(0, HOT_LIMIT - currentCharacters),
    proposed_entry: described(entry),
    entries: current.map(described),
    eligible,
    eligible_characters: eligibleCharacters,
    shortfall_after_eligible_eviction: Math.max(0, proposedCharacters - eligibleCharacters - HOT_LIMIT),
    live_file_unchanged: true,
    next_actions: [
      "Shorten the bullet or explicitly delete lower-value bullets with memoria_delete.",
      "Save the fact in SQLite long-term memory instead.",
      "Use memoria_edit to raise the priority of an important entry only when justified.",
    ],
  };
}

export class HotMemoryStore {
  constructor(
    readonly path: string,
    private archive: (entries: HotMemory[]) => void,
    private queue: Queue = async (_path, operation) => operation(),
  ) {}

  private async locked<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.queue(this.path, async () => {
      signal?.throwIfAborted();
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      let release: () => Promise<void>;
      try {
        release = await lockfile.lock(this.path, {
          realpath: false, stale: 10_000, update: 2_000,
          retries: { retries: 80, minTimeout: 10, maxTimeout: 100, randomize: true },
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ELOCKED") {
          throw new ExpectedError("hot_locked", `Could not lock MEMORY.md within the retry window (ELOCKED). Another process is mutating it; retry shortly.`, { path: this.path, lock_code: code });
        }
        throw error;
      }
      try { signal?.throwIfAborted(); return await operation(); } finally { await release(); }
    });
  }

  private async read(): Promise<string | undefined> {
    try { return await readFile(this.path, "utf8"); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  private snapshot(entries: HotMemory[], archived: HotMemory[], backup?: string): HotSnapshot {
    const text = serialize(entries);
    return { text, entries, characters: text.length, remaining: HOT_LIMIT - text.length, archived, ...(backup ? { backup } : {}) };
  }

  private capacityError(reason: string, operation: string, current: HotMemory[], proposed: HotMemory[], entry: HotMemory): ExpectedError {
    const details = capacityDetails(reason, operation, current, proposed, entry);
    const prefix = reason === "bullet_too_large"
      ? `A single hot bullet serializes to ${details.proposed_entry.characters} characters including metadata, over the ${HOT_LIMIT}-character total limit.`
      : reason === "existing_over_limit"
        ? `MEMORY.md is already over the ${HOT_LIMIT}-character limit and must be repaired before duplicate content can be returned safely.`
        : `MEMORY.md is ${details.over_by} characters over budget even after evicting every eligible lower-priority entry (shortfall ${details.shortfall_after_eligible_eviction}).`;
    return new ExpectedError("hot_capacity", `${prefix} The live file was not changed. Shorten the content, delete a bullet, use SQLite, or adjust priority.`, details);
  }

  /** Normalize manual edits; preserve a backup before any automatic capacity repair. */
  async load(): Promise<HotSnapshot> {
    return this.locked(async () => {
      const original = await this.read();
      const previous = original ?? "";
      const entries = parse(previous);
      const archived: HotMemory[] = [];
      while (serialize(entries).length > HOT_LIMIT) {
        const victim = entries.reduce((a, b) => b.priority < a.priority ? b : a);
        archived.push(victim);
        entries.splice(entries.indexOf(victim), 1);
      }
      let backup: string | undefined;
      if (archived.length) {
        const backups = join(dirname(this.path), "backups");
        await mkdir(backups, { recursive: true, mode: 0o700 });
        backup = join(backups, `MEMORY-${Date.now()}-${randomUUID()}.md`);
        await writeFile(backup, previous, { flag: "wx", mode: 0o600, flush: true });
        this.archive(archived);
      }
      const result = this.snapshot(entries, archived, backup);
      // Ensure a real file exists even when the store is empty.
      if (result.text !== previous || original === undefined) await atomicWrite(this.path, result.text);
      return result;
    });
  }

  async add(content: string, priority = 50, signal?: AbortSignal): Promise<HotAddResult> {
    const normalized = singleLine(content);
    const requested = integer(priority, "priority", 0, 100);
    return this.locked(async () => {
      const entries = parse((await this.read()) ?? "");
      const existing = entries.find((entry) => entry.content === normalized);
      if (existing) {
        // An oversized live state must not be reported as a successful snapshot.
        if (serialize(entries).length > HOT_LIMIT) throw this.capacityError("existing_over_limit", "add", entries, entries, existing);
        return {
          ...this.snapshot(entries, []), memory: existing, created: false,
          note: `Reused existing hot memory ${existing.id}; its content, priority ${existing.priority}, and file position were preserved. Use memoria_edit to change its content or priority.`,
        };
      }
      const entry: HotMemory = { id: `h_${randomUUID().replaceAll("-", "").slice(0, 16)}`, priority: requested, content: normalized };
      return { ...await this.commit(entries, entry, undefined, "add", signal), created: true };
    }, signal);
  }

  async edit(id: string, content?: string, priority?: number, expectedContent?: string, signal?: AbortSignal): Promise<HotEditResult> {
    const normalized = content === undefined ? undefined : singleLine(content);
    const requested = priority === undefined ? undefined : integer(priority, "priority", 0, 100);
    return this.locked(async () => {
      const entries = parse((await this.read()) ?? "");
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) throw new ExpectedError("not_found", `Hot memory ${id} does not exist. Read MEMORY.md again.`, { id });
      const previous = entries[index]!;
      if (expectedContent !== undefined && previous.content !== expectedContent) {
        throw new ExpectedError("conflict", `Hot memory ${id} changed (stored content differs from expected_content). Read MEMORY.md again before editing.`, { id, expected_content: expectedContent, current_content: previous.content });
      }
      const entry: HotMemory = { id, content: normalized ?? previous.content, priority: requested ?? previous.priority };
      if (normalized !== undefined && normalized !== previous.content) {
        const duplicate = entries.find((item) => item.id !== id && item.content === normalized);
        if (duplicate) {
          throw new ExpectedError("duplicate_hot_content", `Edit rejected: setting ${id} to that content would duplicate hot memory ${duplicate.id}. Neither entry was changed; keep one entry or choose distinct content.`, { id, existing_id: duplicate.id });
        }
      }
      return this.commit(entries, entry, index, "edit", signal);
    }, signal);
  }

  private async commit(entriesBefore: HotMemory[], entry: HotMemory, index: number | undefined, operation: string, signal?: AbortSignal): Promise<HotEditResult> {
    signal?.throwIfAborted();
    const proposed = index === undefined ? [...entriesBefore, entry] : entriesBefore.map((item, current) => current === index ? entry : item);
    if (serialize([entry]).length > HOT_LIMIT) throw this.capacityError("bullet_too_large", operation, entriesBefore, proposed, entry);
    const entries = proposed.slice();
    const archived: HotMemory[] = [];
    if (serialize(entries).length > HOT_LIMIT) {
      const candidates = entriesBefore.filter((item) => item.id !== entry.id && item.priority < entry.priority).sort((a, b) => a.priority - b.priority);
      while (serialize(entries).length > HOT_LIMIT) {
        const victim = candidates.shift();
        if (!victim) throw this.capacityError("cannot_free_space", operation, entriesBefore, proposed, entry);
        archived.push(victim);
        entries.splice(entries.indexOf(victim), 1);
      }
    }
    if (archived.length) this.archive(archived);
    const result = this.snapshot(entries, archived);
    await atomicWrite(this.path, result.text);
    return { ...result, memory: entry };
  }

  async delete(id: string, expectedContent?: string, signal?: AbortSignal): Promise<HotDeleteResult> {
    return this.locked(async () => {
      const entries = parse((await this.read()) ?? "");
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) throw new ExpectedError("not_found", `Hot memory ${id} does not exist.`, { id });
      const deleted = entries[index]!;
      if (expectedContent !== undefined && deleted.content !== expectedContent) {
        throw new ExpectedError("conflict", `Hot memory ${id} changed (stored content differs from expected_content). Read MEMORY.md again before deleting.`, { id, expected_content: expectedContent, current_content: deleted.content });
      }
      entries.splice(index, 1);
      const result = this.snapshot(entries, []);
      await atomicWrite(this.path, result.text);
      return { ...result, deleted };
    }, signal);
  }
}
