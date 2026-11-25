import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { databasePath } from "./database-path.ts";
import { APPLICATION_ID, INITIAL_SCHEMA, VERSION_THREE, VERSION_TWO, attestSchema } from "./database-schema.ts";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ExpectedError, isSqliteError, sqliteInfo, storeUnavailable } from "./errors.ts";
import {
  buildHotSnapshot, fitHotMemory, hotCapacityError, newHotId, renderHotMemory,
  type HotAddResult, type HotDeleteResult, type HotEditResult, type HotMemory, type HotSnapshot,
} from "./hot-memory.ts";
import { chunk, excerpt, HOT_LIMIT, integer, MEMORY_LIMIT, nonempty, tags as validateTags } from "./text.ts";

const MAX_SESSION_ROOTS = 100;

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface MemoryInput { content: string; tags?: string[]; source?: string }
export type SearchMode = "any" | "all" | "phrase" | "literal";
export interface MemorySearchOptions {
  /** Require exact, case-sensitive membership for every supplied tag. */
  tags?: string[];
}

export interface HotMigrationMarker {
  status: "migrated" | "absent";
  source?: string;
  sha256?: string;
  entries: number;
  archived: number;
  at: string;
}

interface Row { [key: string]: unknown }

function validatedInput(input: MemoryInput, preserveWhitespace = false): Required<MemoryInput> {
  const content = preserveWhitespace ? input.content : nonempty(input.content, "content");
  if (!content.length || content.length > MEMORY_LIMIT || content.includes("\0")) {
    throw new ExpectedError("invalid_input", `content must contain 1–${MEMORY_LIMIT} characters and no NUL bytes.`, { field: "content" });
  }
  return {
    content, tags: validateTags(input.tags),
    source: input.source ? nonempty(input.source, "source", 2_000) : "",
  };
}

function memory(row: Row): Memory {
  return {
    id: String(row.id), content: String(row.content), tags: JSON.parse(String(row.tags)) as string[],
    source: String(row.source), created_at: String(row.created_at), updated_at: String(row.updated_at),
    revision: Number(row.revision),
  };
}

function hotMemory(row: Row): HotMemory {
  return {
    id: String(row.id), content: String(row.content), priority: Number(row.priority), position: Number(row.position),
    created_at: String(row.created_at), updated_at: String(row.updated_at), revision: Number(row.revision),
  };
}

export interface LongTermSearchRow extends Memory {
  store: "long_term";
  content_characters: number;
  content_clipped: boolean;
}

export interface HotSearchRow extends HotMemory {
  store: "hot";
  tags: string[];
  source: string;
  content_characters: number;
  content_clipped: boolean;
}

export type SearchRow = LongTermSearchRow | HotSearchRow;

function hotSearchRow(entry: HotMemory, terms: string[], trimmed: string): HotSearchRow {
  return {
    ...entry, store: "hot", tags: [], source: "hot-memory",
    content: excerpt(entry.content, terms[0] ?? trimmed),
    content_characters: entry.content.length,
    content_clipped: entry.content.length > 600,
  };
}

export class MemoryDatabase {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private closed = false;
  // Held open for the connection's lifetime so POSIX does not release SQLite's
  // SHARED lock when an unrelated descriptor to the same file is closed.
  private lockFd: number | undefined;

  constructor(readonly path: string) {
    let location: ReturnType<typeof databasePath>;
    try {
      location = databasePath(path);
      // A rejected existing database never receives a writable connection, chmod,
      // journal-mode change or migration. Version zero alone is not ownership.
      const existing = location.check();
      if (existing) {
        location.inspect(snapshot => {
          const inspection = new DatabaseSync(snapshot);
          try { inspection.exec("PRAGMA busy_timeout=5000; BEGIN"); attestSchema(inspection); }
          finally { inspection.close(); }
        });
      }
      location.check();
      this.db = new DatabaseSync(location.path);
    } catch (error) { throw storeUnavailable("open", path, error); }
    try {
      this.db.exec("PRAGMA busy_timeout=5000;");
      this.db.function("memoria_fold", { deterministic: true }, (value) => String(value).toLowerCase());
      const preliminary = attestSchema(this.db);
      if (preliminary > 0 && preliminary < 3) this.backupBeforeV3();
      this.transaction(() => {
        // Re-attest under the writer transaction for concurrent initialization.
        const version = attestSchema(this.db);
        location.check();
        if (version === 0) this.db.exec(INITIAL_SCHEMA);
        if (version < 2) this.db.exec(VERSION_TWO);
        if (version < 3) this.db.exec(VERSION_THREE);
        this.db.exec(`PRAGMA application_id=${APPLICATION_ID};`);
      });
      this.lockFd = location.privateMode();
      // A competing cold opener can take the writer lock between our schema
      // transaction and WAL selection. SQLite may return BUSY here immediately,
      // without invoking busy_timeout. Retry only that exact driver condition;
      // recheck paths before each attempt and keep the same five-second bound.
      const deadline = performance.now() + 5_000;
      for (;;) {
        location.check();
        try { this.db.exec("PRAGMA journal_mode=WAL;"); break; }
        catch (error) {
          const info = sqliteInfo(error), remaining = deadline - performance.now();
          if (info.code !== "ERR_SQLITE_ERROR" || info.errcode !== 5 || remaining <= 0) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, remaining));
        }
      }
      this.db.exec("PRAGMA synchronous=FULL;");
    } catch (error) {
      this.closed = true;
      try { this.db.close(); } catch { /* keep the original failure */ }
      if (this.lockFd !== undefined) { try { closeSync(this.lockFd); } catch { /* keep the original failure */ } this.lockFd = undefined; }
      throw storeUnavailable("open", path, error);
    }
  }

  /** A version-two store has no downgrade path from v3, so snapshot it before the schema moves. */
  private backupBeforeV3(): void {
    const directory = join(dirname(resolve(this.path)), "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `memoria-pre-v3-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.sqlite`;
    const target = join(directory, name);
    this.db.prepare("VACUUM INTO ?").run(target);
    chmodSync(target, 0o600);
  }

  private attempt<T>(operation: string, work: () => T): T {
    try { return work(); }
    catch (error) {
      if (error instanceof ExpectedError) throw error;
      if (isSqliteError(error)) throw storeUnavailable(operation, this.path, error);
      throw error;
    }
  }

  private statement(sql: string): StatementSync {
    if (this.closed) throw storeUnavailable("access", this.path, new Error("database is closed"));
    let result = this.statements.get(sql);
    if (!result) { result = this.db.prepare(sql); this.statements.set(sql, result); }
    return result;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  add(input: MemoryInput): { memory: Memory; created: boolean } {
    const value = validatedInput(input);
    // BEGIN IMMEDIATE covers both lookup and insertion, including competing Pi processes.
    return this.attempt("add", () => this.transaction(() => {
      const existing = this.statement("SELECT * FROM memories WHERE content=? ORDER BY rowid LIMIT 1").get(value.content);
      if (existing) return { memory: memory(existing), created: false };
      const id = `m_${randomUUID()}`;
      this.insert(id, value);
      return { memory: this.get(id), created: true };
    }));
  }

  private insert(id: string, { content, tags, source }: Required<MemoryInput>, ignore = false): void {
    const timestamp = new Date().toISOString();
    this.statement(`INSERT ${ignore ? "OR IGNORE" : ""} INTO memories(id,content,tags,tag_text,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id, content, JSON.stringify(tags), tags.join("\n"), source, timestamp, timestamp);
  }

  /** Save archived hot entries as durable facts. Retrying is idempotent. */
  archive(entries: { id: string; content: string }[], sourcePath: string): string[] {
    return this.attempt("archive", () => this.transaction(() => this.archiveRows(entries, sourcePath)));
  }

  private archiveRows(entries: { id: string; content: string }[], sourcePath: string): string[] {
    return entries.map((entry) => {
      const id = `m_archive_${createHash("sha256").update(entry.id + "\0" + entry.content).digest("hex").slice(0, 24)}`;
      // Oversized hand-written bullets are preserved in complete, bounded pieces.
      const parts: string[] = [];
      for (let offset = 0; offset < entry.content.length;) {
        const part = chunk(entry.content, offset, 19_000);
        parts.push(part.text);
        offset = part.next_text_offset ?? entry.content.length;
      }
      parts.forEach((content, index) => this.insert(parts.length === 1 ? id : `${id}_${index + 1}`, validatedInput({
        content, tags: ["hot-archive"], source: `${sourcePath}#${entry.id}${parts.length === 1 ? "" : ` (part ${index + 1}/${parts.length})`}`,
      }, true), true));
      return id;
    });
  }

  get(id: string): Memory {
    return this.attempt("read", () => {
      const row = this.statement("SELECT * FROM memories WHERE id=?").get(id);
      if (!row) throw new ExpectedError("not_found", `Memory ${id} does not exist. Search before editing or deleting.`, { id });
      return memory(row);
    });
  }

  edit(id: string, changes: Partial<MemoryInput>, expectedRevision?: number): Memory {
    return this.attempt("edit", () => this.transaction(() => {
      const previous = this.get(id);
      this.checkRevision(previous, expectedRevision);
      const content = changes.content === undefined ? previous.content : nonempty(changes.content, "content");
      const tags = changes.tags === undefined ? previous.tags : validateTags(changes.tags);
      const source = changes.source === undefined ? previous.source : changes.source ? nonempty(changes.source, "source", 2_000) : "";
      this.statement("UPDATE memories SET content=?,tags=?,tag_text=?,source=?,updated_at=?,revision=revision+1 WHERE id=?")
        .run(content, JSON.stringify(tags), tags.join("\n"), source, new Date().toISOString(), id);
      return this.get(id);
    }));
  }

  delete(id: string, expectedRevision?: number): Memory {
    return this.attempt("delete", () => this.transaction(() => {
      const previous = this.get(id);
      this.checkRevision(previous, expectedRevision);
      this.statement("DELETE FROM memories WHERE id=?").run(id);
      return previous;
    }));
  }

  private checkRevision(value: Memory, expected?: number): void {
    if (expected !== undefined && value.revision !== expected) {
      throw new ExpectedError("conflict", `Memory ${value.id} changed (revision ${value.revision}, expected ${expected}). Search again before changing it.`, {
        id: value.id, current_revision: value.revision, expected_revision: expected,
      });
    }
  }

  private hotEntries(): HotMemory[] {
    return this.statement("SELECT * FROM hot_memories ORDER BY position,id").all().map(hotMemory);
  }

  hotSnapshot(): HotSnapshot {
    return this.attempt("hot_read", () => buildHotSnapshot(this.hotEntries()));
  }

  hotGet(id: string): HotMemory {
    return this.attempt("hot_read", () => {
      const row = this.statement("SELECT * FROM hot_memories WHERE id=?").get(id);
      if (!row) throw new ExpectedError("not_found", `Hot memory ${id} does not exist. Search before editing or deleting.`, { id });
      return hotMemory(row);
    });
  }

  hotAdd(content: string, priority = 50): HotAddResult {
    return this.attempt("hot_add", () => this.transaction(() => {
      const current = this.hotEntries();
      const existing = current.find((entry) => entry.content === content);
      if (existing) {
        return {
          ...buildHotSnapshot(current), memory: existing, created: false,
          note: `Reused existing hot memory ${existing.id}; its content, priority ${existing.priority}, and position were preserved. Use memoria_edit to change its content or priority.`,
        };
      }
      const timestamp = new Date().toISOString();
      const entry: HotMemory = {
        id: newHotId(), content, priority,
        position: current.length ? Math.max(...current.map((item) => item.position)) + 1 : 0,
        created_at: timestamp, updated_at: timestamp, revision: 1,
      };
      const proposed = [...current, entry];
      if (renderHotMemory([entry]).length > HOT_LIMIT) throw hotCapacityError("rule_too_large", "add", current, proposed, entry);
      const { kept, evicted } = fitHotMemory(proposed, entry);
      if (renderHotMemory(kept).length > HOT_LIMIT) throw hotCapacityError("cannot_free_space", "add", current, proposed, entry);
      this.archiveRows(evicted, "hot-memory");
      for (const item of evicted) this.deleteHotRow(item.id);
      this.insertHot(entry);
      return { ...buildHotSnapshot(kept, evicted), memory: entry, created: true };
    }));
  }

  hotEdit(id: string, content?: string, priority?: number, expectedContent?: string): HotEditResult {
    return this.attempt("hot_edit", () => this.transaction(() => {
      const current = this.hotEntries();
      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1) throw new ExpectedError("not_found", `Hot memory ${id} does not exist. Search before editing or deleting.`, { id });
      const previous = current[index]!;
      if (expectedContent !== undefined && previous.content !== expectedContent) {
        throw new ExpectedError("conflict", `Hot memory ${id} changed (stored content differs from expected_content). Search again before editing.`, { id, expected_content: expectedContent, current_content: previous.content });
      }
      if (content !== undefined && content !== previous.content) {
        const duplicate = current.find((entry) => entry.id !== id && entry.content === content);
        if (duplicate) {
          throw new ExpectedError("duplicate_hot_content", `Edit rejected: setting ${id} to that content would duplicate hot memory ${duplicate.id}. Neither entry was changed; keep one entry or choose distinct content.`, { id, existing_id: duplicate.id });
        }
      }
      const entry: HotMemory = {
        ...previous, content: content ?? previous.content, priority: priority ?? previous.priority,
        updated_at: new Date().toISOString(), revision: previous.revision + 1,
      };
      const proposed = current.map((item) => item.id === id ? entry : item);
      if (renderHotMemory([entry]).length > HOT_LIMIT) throw hotCapacityError("rule_too_large", "edit", current, proposed, entry);
      const { kept, evicted } = fitHotMemory(proposed, entry);
      if (renderHotMemory(kept).length > HOT_LIMIT) throw hotCapacityError("cannot_free_space", "edit", current, proposed, entry);
      this.archiveRows(evicted, "hot-memory");
      for (const item of evicted) this.deleteHotRow(item.id);
      this.updateHot(entry);
      return { ...buildHotSnapshot(kept, evicted), memory: entry };
    }));
  }

  hotDelete(id: string, expectedContent?: string): HotDeleteResult {
    return this.attempt("hot_delete", () => this.transaction(() => {
      const current = this.hotEntries();
      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1) throw new ExpectedError("not_found", `Hot memory ${id} does not exist.`, { id });
      const deleted = current[index]!;
      if (expectedContent !== undefined && deleted.content !== expectedContent) {
        throw new ExpectedError("conflict", `Hot memory ${id} changed (stored content differs from expected_content). Search again before deleting.`, { id, expected_content: expectedContent, current_content: deleted.content });
      }
      this.deleteHotRow(id);
      return { ...buildHotSnapshot(current.filter((entry) => entry.id !== id)), deleted };
    }));
  }

  hotMigration(): HotMigrationMarker | undefined {
    return this.attempt("hot_migration", () => {
      const row = this.statement("SELECT value FROM app_meta WHERE key=?").get("legacy_hot_migration");
      if (!row) return undefined;
      let parsed: unknown;
      try { parsed = JSON.parse(String(row.value)); }
      catch { throw new ExpectedError("hot_migration", "Invalid hot memory migration marker in SQLite.", {}); }
      const value = parsed as Partial<HotMigrationMarker> | null;
      if (!value || typeof value !== "object" || !["migrated", "absent"].includes(String(value.status)) ||
          !Number.isInteger(value.entries) || !Number.isInteger(value.archived) || typeof value.at !== "string") {
        throw new ExpectedError("hot_migration", "Invalid hot memory migration marker in SQLite.", {});
      }
      return value as HotMigrationMarker;
    });
  }

  migrateHot(entries: HotMemory[], archived: HotMemory[], source: string, sha256: string): "migrated" | "already" {
    return this.attempt("hot_migration", () => this.transaction(() => {
      if (this.hotMigration()) return "already";
      const count = Number(this.statement("SELECT COUNT(*) AS n FROM hot_memories").get()?.n ?? 0);
      if (count > 0) throw new ExpectedError("hot_migration", "Hot memory already contains rows but has no migration marker; refusing to import MEMORY.md.", { count });
      this.archiveRows(archived, "hot-memory");
      for (const entry of entries) this.insertHot(entry);
      const marker: HotMigrationMarker = { status: "migrated", source, sha256, entries: entries.length, archived: archived.length, at: new Date().toISOString() };
      this.statement("INSERT INTO app_meta(key,value) VALUES(?,?)").run("legacy_hot_migration", JSON.stringify(marker));
      return "migrated";
    }));
  }

  markHotAbsent(): void {
    this.attempt("hot_migration", () => this.transaction(() => {
      if (this.hotMigration()) return;
      const count = Number(this.statement("SELECT COUNT(*) AS n FROM hot_memories").get()?.n ?? 0);
      if (count > 0) throw new ExpectedError("hot_migration", "Hot memory contains rows without a migration marker; refusing to mark it absent.", { count });
      const marker: HotMigrationMarker = { status: "absent", entries: 0, archived: 0, at: new Date().toISOString() };
      this.statement("INSERT INTO app_meta(key,value) VALUES(?,?)").run("legacy_hot_migration", JSON.stringify(marker));
    }));
  }

  private insertHot(entry: HotMemory): void {
    this.statement("INSERT INTO hot_memories(id,content,priority,position,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?)")
      .run(entry.id, entry.content, entry.priority, entry.position, entry.created_at, entry.updated_at, entry.revision);
  }

  private updateHot(entry: HotMemory): void {
    this.statement("UPDATE hot_memories SET content=?,priority=?,updated_at=?,revision=? WHERE id=?")
      .run(entry.content, entry.priority, entry.updated_at, entry.revision, entry.id);
  }

  private deleteHotRow(id: string): void {
    this.statement("DELETE FROM hot_memories WHERE id=?").run(id);
  }

  private hotMatches(trimmed: string, mode: SearchMode, requestedTags: string[], terms: string[]): HotMemory[] {
    if (requestedTags.length) return [];
    const entries = this.hotEntries();
    if (!trimmed) return entries;
    const lower = trimmed.toLowerCase();
    if (mode === "literal" || !terms.length) return entries.filter((entry) => entry.content.toLowerCase().includes(lower));
    const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];
    if (mode === "phrase") {
      return entries.filter((entry) => {
        const contentWords = words(entry.content);
        return contentWords.some((_, start) => terms.every((term, index) => contentWords[start + index]?.startsWith(term)));
      });
    }
    return entries.filter((entry) => {
      const contentWords = words(entry.content);
      return mode === "all"
        ? terms.every((term) => contentWords.some((word) => word.startsWith(term)))
        : terms.some((term) => contentWords.some((word) => word.startsWith(term)));
    });
  }

  private searchLongTerm(trimmed: string, mode: SearchMode, limit: number, offset: number, requestedTags: string[], terms: string[]): {
    mode: SearchMode | "browse";
    results: LongTermSearchRow[];
    next_offset: number | null;
  } {
    const tagClauses = requestedTags.map(() => "EXISTS (SELECT 1 FROM json_each(m.tags) AS requested_tag WHERE requested_tag.value = ? COLLATE BINARY)");
    const tagWhere = tagClauses.join(" AND ");

    let usedMode: SearchMode | "browse" = mode;
    let rows: Row[];
    const literal = () => this.statement(`SELECT m.* FROM memories m
      WHERE instr(memoria_fold(m.content || char(10) || m.tag_text || char(10) || m.source), memoria_fold(?)) > 0${tagWhere ? ` AND ${tagWhere}` : ""}
      ORDER BY m.created_at, m.id LIMIT ? OFFSET ?`).all(trimmed, ...requestedTags, limit + 1, offset);
    if (!trimmed) {
      usedMode = "browse";
      rows = this.statement(`SELECT m.* FROM memories m${tagWhere ? ` WHERE ${tagWhere}` : ""} ORDER BY m.created_at,m.id LIMIT ? OFFSET ?`)
        .all(...requestedTags, limit + 1, offset);
    } else if (mode === "literal" || !terms.length) {
      usedMode = "literal";
      rows = literal();
    } else {
      const fts = mode === "phrase"
        ? `"${terms.join(" ")}"`
        : terms.map((term) => `"${term}"*`).join(mode === "all" ? " AND " : " OR ");
      rows = this.statement(`SELECT m.* FROM memories_fts JOIN memories m ON m.rowid=memories_fts.rowid
        WHERE memories_fts MATCH ?${tagWhere ? ` AND ${tagWhere}` : ""} ORDER BY bm25(memories_fts),m.id LIMIT ? OFFSET ?`)
        .all(fts, ...requestedTags, limit + 1, offset);
      // Decide fallback independently of page offset so subsequent pages retain the same semantics.
      // The existence probe uses the same tag predicate so an all-filtered corpus can still fall back.
      if (!this.statement(`SELECT m.rowid FROM memories_fts JOIN memories m ON m.rowid=memories_fts.rowid
        WHERE memories_fts MATCH ?${tagWhere ? ` AND ${tagWhere}` : ""} LIMIT 1`).get(fts, ...requestedTags)) {
        usedMode = "literal";
        rows = literal();
      }
    }
    const hasMore = rows.length > limit;
    return {
      mode: usedMode,
      results: rows.slice(0, limit).map((row) => {
        const item = memory(row);
        return {
          ...item, store: "long_term" as const,
          content: excerpt(item.content, terms[0] ?? trimmed),
          content_characters: item.content.length,
          content_clipped: item.content.length > 600,
        };
      }),
      next_offset: hasMore ? offset + limit : null,
    };
  }

  search(query = "", mode: SearchMode = "any", limit = 20, offset = 0, options: MemorySearchOptions = {}) {
    integer(limit, "limit", 1, 50);
    integer(offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    if (query.length > 2_000 || query.includes("\0")) {
      throw new ExpectedError("invalid_input", "Query must be at most 2,000 characters without NUL bytes.", { field: "query" });
    }
    if (!["any", "all", "phrase", "literal"].includes(mode)) {
      throw new ExpectedError("invalid_input", "Unknown memory search mode.", { field: "mode" });
    }
    const requestedTags = validateTags(options.tags);
    const start = performance.now();
    const trimmed = query.trim();
    const terms = [...new Set((trimmed.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? []).map((term) => term.toLowerCase()))];

    const hot = this.hotMatches(trimmed, mode, requestedTags, terms);
    const hotPage = hot.slice(offset, offset + limit);
    const sqliteOffset = Math.max(0, offset - hot.length);
    const sqliteLimit = limit - hotPage.length;
    const longTerm = this.searchLongTerm(trimmed, mode, Math.max(1, sqliteLimit), sqliteOffset, requestedTags, terms);
    const sqliteRows = sqliteLimit > 0 ? longTerm.results : [];
    const sqliteHasMore = longTerm.next_offset !== null || (sqliteLimit === 0 && longTerm.results.length > 0);
    const hasMore = offset + hotPage.length < hot.length || sqliteHasMore;

    return {
      mode: trimmed ? longTerm.mode : "browse" as const,
      query: trimmed,
      tags: requestedTags,
      results: [
        ...hotPage.map((entry) => hotSearchRow(entry, terms, trimmed)),
        ...sqliteRows,
      ] as SearchRow[],
      next_offset: hasMore ? offset + limit : null,
      elapsed_ms: Number((performance.now() - start).toFixed(3)),
      hint: "Use an m_ or h_ id to read a complete memory. Hot results are stored in SQLite and listed first; a tags filter applies to long-term memories only. Try mode=literal for exact substrings, shorter/alternate terms, or query='' to browse memory. For historical claims or uncertain/empty recall, use memoria_sessions; an empty keyword result does not prove absence.",
    };
  }

  /** Add remembered roots and return those evicted by the newest-100 bound. */
  rememberRoots(paths: string[]): string[] {
    return this.attempt("remember_roots", () => this.transaction(() => {
      for (const path of paths) this.statement("INSERT OR IGNORE INTO session_roots(path) VALUES(?)").run(resolve(path));
      const inserted = new Set(this.statement("SELECT path FROM session_roots").all().map((row) => String(row.path)));
      // Bound the append-only registry to the newest roots, oldest rowids first.
      this.statement("DELETE FROM session_roots WHERE rowid NOT IN (SELECT rowid FROM session_roots ORDER BY rowid DESC LIMIT ?)")
        .run(MAX_SESSION_ROOTS);
      const kept = new Set(this.statement("SELECT path FROM session_roots").all().map((row) => String(row.path)));
      return [...inserted].filter((path) => !kept.has(path));
    }));
  }

  roots(): string[] {
    return this.attempt("list_roots", () => this.statement("SELECT path FROM session_roots ORDER BY path").all().map((row) => String(row.path)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try { this.db.close(); }
    finally {
      if (this.lockFd !== undefined) { closeSync(this.lockFd); this.lockFd = undefined; }
    }
  }
}
