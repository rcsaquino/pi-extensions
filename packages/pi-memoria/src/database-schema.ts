import { DatabaseSync } from "node:sqlite";

export const APPLICATION_ID = 0x4d454d4f; // MEMO. Pre-identifier v1/v2 stores remain supported.
export const INITIAL_SCHEMA = `
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
  PRAGMA user_version=1;
`;
export const VERSION_TWO = "CREATE INDEX memories_content ON memories(content); PRAGMA user_version=2;";

const schemas = new Map<number, string>();
function fingerprint(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all().map(row => ({
    ...row, sql: typeof row.sql === "string" ? row.sql.replace(/\s+/g, " ").trim() : row.sql,
  })));
}
function recognized(version: number): string {
  let value = schemas.get(version);
  if (value) return value;
  // Build signatures of the schemas actually shipped by this package, including
  // FTS shadow objects/autoindexes. This template is memory-only, never a fixture
  // or mutation of the configured path.
  const template = new DatabaseSync(":memory:");
  try {
    template.exec(INITIAL_SCHEMA);
    if (version === 2) template.exec(VERSION_TWO);
    value = fingerprint(template); schemas.set(version, value); return value;
  } finally { template.close(); }
}
export function attestSchema(db: DatabaseSync): number {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  const application = Number(db.prepare("PRAGMA application_id").get()?.application_id);
  if (version > 2) throw new Error(`Database schema ${version} is newer than this pi-memoria version.`);
  if (application !== 0 && application !== APPLICATION_ID) throw new Error("Unrecognized database application.");
  if (version === 0 && application === 0 && db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()?.n === 0) return 0;
  if ((version !== 1 && version !== 2) || fingerprint(db) !== recognized(version)) throw new Error("Unsupported or unrelated memoria database schema.");
  return version;
}
