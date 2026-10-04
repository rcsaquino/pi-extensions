import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { databasePath } from "./database-path.ts";
import { APPLICATION_ID, INITIAL_SCHEMA, VERSION_TWO, attestSchema } from "./database-schema.ts";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { expandQuery, loadAliases, type AliasConfiguration } from "./aliases.ts";
import { ExpectedError, isSqliteError, storeUnavailable } from "./errors.ts";
import { chunk, excerpt, integer, MEMORY_LIMIT, nonempty, tags as validateTags } from "./text.ts";

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
  /** Expand configured terminology alternatives for any/all keyword modes. Defaults to true. */
  expandAliases?: boolean;
  /** Require exact, case-sensitive membership for every supplied tag. */
  tags?: string[];
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

export class MemoryDatabase {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private aliases?: AliasConfiguration;
  private closed = false;

  constructor(readonly path: string, private readonly aliasesPath?: string) {
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
      this.transaction(() => {
        // Re-attest under the writer transaction for concurrent initialization.
        const version = attestSchema(this.db);
        location.check();
        if (version === 0) this.db.exec(INITIAL_SCHEMA);
        if (version < 2) this.db.exec(VERSION_TWO);
        this.db.exec(`PRAGMA application_id=${APPLICATION_ID};`);
      });
      location.privateMode();
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    } catch (error) {
      this.closed = true;
      try { this.db.close(); } catch { /* keep the original failure */ }
      throw storeUnavailable("open", path, error);
    }
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

  /** Save first, then let the caller replace MEMORY.md. Retrying is idempotent. */
  archive(entries: { id: string; content: string }[], sourcePath: string): string[] {
    return this.attempt("archive", () => this.transaction(() => entries.map((entry) => {
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
    })));
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
    const terms = [...new Set(trimmed.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [])];
    const keyword = mode === "any" || mode === "all";
    const aliasExpansionEnabled = keyword && terms.length > 0 && (options.expandAliases ?? true);
    const alias = aliasExpansionEnabled ? this.aliasConfiguration() : undefined;
    const expansion = alias ? expandQuery(terms, alias.aliases) : { expansions: [] as Array<{ term: string; aliases: string[] }> };
    const warnings = alias ? [alias.warning, expansion.warning].filter((value): value is string => value !== undefined) : [];
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
        : terms.map((term) => {
          const alternatives = expansion.expansions.find((value) => value.term === term)?.aliases ?? [];
          const tokens = [term, ...alternatives].map((token) => `"${token}"*`);
          return tokens.length > 1 ? `(${tokens.join(" OR ")})` : tokens[0]!;
        }).join(mode === "all" ? " AND " : " OR ");
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
      query: trimmed,
      tags: requestedTags,
      alias_expansion_enabled: aliasExpansionEnabled,
      expansions: expansion.expansions,
      warnings,
      results: rows.slice(0, limit).map((row) => {
        const item = memory(row);
        return { ...item, content: excerpt(item.content, terms[0] ?? trimmed), content_characters: item.content.length, content_clipped: item.content.length > 600 };
      }),
      next_offset: hasMore ? offset + limit : null,
      elapsed_ms: Number((performance.now() - start).toFixed(3)),
      hint: "Use an m_ id to read a complete SQLite memory; hot h_ entries are in the injected MEMORY.md. Try mode=literal for exact substrings, shorter/alternate terms, or query='' to browse SQLite. For historical claims or uncertain/empty recall, use memoria_sessions; an empty keyword result does not prove absence.",
    };
  }

  private aliasConfiguration(): AliasConfiguration {
    this.aliases ??= loadAliases(this.aliasesPath);
    return this.aliases;
  }

  rememberRoots(paths: string[]): void {
    this.attempt("remember_roots", () => this.transaction(() => {
      for (const path of paths) this.statement("INSERT OR IGNORE INTO session_roots(path) VALUES(?)").run(resolve(path));
    }));
  }

  roots(): string[] {
    return this.attempt("list_roots", () => this.statement("SELECT path FROM session_roots ORDER BY path").all().map((row) => String(row.path)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}
