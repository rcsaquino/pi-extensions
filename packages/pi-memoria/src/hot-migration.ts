import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryDatabase } from "./database.ts";
import { ExpectedError } from "./errors.ts";
import { fitHotMemory, type HotMemory } from "./hot-memory.ts";

const LEGACY_FILE = "MEMORY.md";
const BACKUP_DIRECTORY = "backups";

export interface HotMigrationResult {
  status: "migrated" | "already" | "absent";
  entries: number;
  archived: number;
  backup?: string;
  warning?: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function parseLegacy(text: string): HotMemory[] {
  const entries: HotMemory[] = [];
  const now = new Date().toISOString();
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
    const existing = entries.find((entry) => entry.id === id);
    if (existing) {
      // Hand-written duplicate lines carry no explicit id; merge identical content instead of
      // rejecting the whole file. Explicit duplicate ids stay actionable.
      if (!match && existing.content === content) continue;
      throw new ExpectedError("hot_migration", `Duplicate hot memory ID ${id}; repair MEMORY.md before migrating.`, { id });
    }
    const priority = match ? Number(match[2]) : 50;
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
      throw new ExpectedError("hot_migration", `Hot memory priority must be an integer from 0 to 100: ${body}`, { priority });
    }
    entries.push({ id, content, priority, position: entries.length, created_at: now, updated_at: now, revision: 1 });
  }
  return entries;
}

async function retireLegacyFile(path: string, directory: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new ExpectedError("hot_migration", `MEMORY.md must be a regular file, not a symbolic link or directory: ${path}`, { path });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const backups = join(directory, BACKUP_DIRECTORY);
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const target = join(backups, `MEMORY-pre-sqlite-${timestamp()}-${randomUUID().slice(0, 8)}.md`);
  await rename(path, target);
  return target;
}

/**
 * Import the legacy file once, then retire it. The file is the source until the
 * SQLite transaction commits; a crash at any earlier point leaves it untouched.
 */
export async function migrateLegacyHot(db: MemoryDatabase, directory: string): Promise<HotMigrationResult> {
  const marker = db.hotMigration();
  const path = join(directory, LEGACY_FILE);

  if (marker) {
    try {
      const backup = await retireLegacyFile(path, directory);
      return { status: "already", entries: marker.entries, archived: marker.archived, ...(backup ? { backup } : {}) };
    } catch (error) {
      return { status: "already", entries: marker.entries, archived: marker.archived, warning: `Hot memory is already in SQLite, but the legacy file could not be retired: ${(error as Error).message}` };
    }
  }

  let text: string;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ExpectedError("hot_migration", `MEMORY.md must be a regular file, not a symbolic link or directory: ${path}`, { path });
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    db.markHotAbsent();
    return { status: "absent", entries: 0, archived: 0 };
  }

  const parsed = parseLegacy(text);
  const { kept, evicted } = fitHotMemory(parsed);
  const sha256 = createHash("sha256").update(text).digest("hex");
  const outcome = db.migrateHot(kept, evicted, path, sha256);
  if (outcome === "already") {
    try {
      const backup = await retireLegacyFile(path, directory);
      return { status: "already", entries: kept.length, archived: evicted.length, ...(backup ? { backup } : {}) };
    } catch (error) {
      return { status: "already", entries: kept.length, archived: evicted.length, warning: `Hot memory is already in SQLite, but the legacy file could not be retired: ${(error as Error).message}` };
    }
  }

  try {
    const backup = await retireLegacyFile(path, directory);
    return { status: "migrated", entries: kept.length, archived: evicted.length, ...(backup ? { backup } : {}) };
  } catch (error) {
    return {
      status: "migrated", entries: kept.length, archived: evicted.length,
      warning: `Hot memory was imported, but MEMORY.md could not be retired and will be ignored: ${(error as Error).message}`,
    };
  }
}
