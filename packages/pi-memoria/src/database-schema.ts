import { DatabaseSync } from "node:sqlite";

export const APPLICATION_ID = 0x4d454d4f; // MEMO.
export const CURRENT_SCHEMA = `
  CREATE TABLE memories (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    tag_text TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  ) STRICT;
  CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, tag_text, source, content='memories', content_rowid='rowid',
    tokenize='porter unicode61 remove_diacritics 2', prefix='2 3'
  );
  CREATE TRIGGER memories_insert AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tag_text, source) VALUES(new.rowid, new.content, new.tag_text, new.source);
  END;
  CREATE TRIGGER memories_delete AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tag_text, source)
      VALUES('delete', old.rowid, old.content, old.tag_text, old.source);
  END;
  CREATE TRIGGER memories_update AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tag_text, source)
      VALUES('delete', old.rowid, old.content, old.tag_text, old.source);
    INSERT INTO memories_fts(rowid, content, tag_text, source) VALUES(new.rowid, new.content, new.tag_text, new.source);
  END;
  CREATE TABLE session_roots (path TEXT PRIMARY KEY) STRICT;
  CREATE INDEX memories_content ON memories(content);
  CREATE TABLE hot_memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  ) STRICT;
  CREATE INDEX hot_memories_position ON hot_memories(position, id);
  CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  PRAGMA user_version=3;
`;

let current: string | undefined;
function fingerprint(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all().map(row => ({
    ...row, sql: typeof row.sql === "string" ? row.sql.replace(/\s+/g, " ").trim() : row.sql,
  })));
}
function currentFingerprint(): string {
  if (current) return current;
  // Build the signature from the schema this package actually creates. This
  // template is memory-only, never a fixture or mutation of the configured path.
  const template = new DatabaseSync(":memory:");
  try {
    template.exec(CURRENT_SCHEMA);
    current = fingerprint(template);
    return current;
  } finally { template.close(); }
}
export function attestSchema(db: DatabaseSync): number {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  const application = Number(db.prepare("PRAGMA application_id").get()?.application_id);
  if (version > 3) throw new Error(`Database schema ${version} is newer than this pi-memoria version.`);
  if (application !== 0 && application !== APPLICATION_ID) throw new Error("Unrecognized database application.");
  if (version === 0 && application === 0 && db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()?.n === 0) return 0;
  if (version !== 3 || fingerprint(db) !== currentFingerprint()) throw new Error("Unsupported or unrelated memoria database schema.");
  return 3;
}
