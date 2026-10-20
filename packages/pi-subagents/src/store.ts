import { openSync, closeSync, writeSync, renameSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SCHEMA_VERSION, type RunRecord } from './types.ts';

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** Local-time run id: YYYYMMDD-HHMMSS-<6 lowercase hex>. */
export function newRunId(now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export function atomicWrite(file: string, text: string, mode = 0o600): void {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', mode);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

export function createRunDir(runsDir: string, id: string): string {
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const dir = join(runsDir, id);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

export function readText(file: string): string | undefined {
  try { return readFileSync(file, 'utf8'); } catch { return undefined; }
}

export function readJson<T>(file: string): T | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

export function readRecord(dir: string): RunRecord | undefined {
  const record = readJson<RunRecord>(join(dir, 'task.json'));
  if (!record || typeof record !== 'object' || record.schemaVersion !== SCHEMA_VERSION) return undefined;
  return record;
}

/** True when a task.json exists but its schemaVersion is not supported. */
export function isIncompatible(dir: string): boolean {
  const record = readJson<{ schemaVersion?: unknown }>(join(dir, 'task.json'));
  return !!record && record.schemaVersion !== SCHEMA_VERSION;
}

export function writeRecord(dir: string, record: RunRecord): void {
  atomicWrite(join(dir, 'task.json'), `${JSON.stringify(record, null, 2)}\n`);
}

export function listRunDirs(agentDir: string): string[] {
  const runsDir = join(agentDir, 'runs');
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => join(runsDir, entry.name));
  } catch {
    return [];
  }
}

export function mtimeMs(path: string): number | undefined {
  try { return statSync(path).mtimeMs; } catch { return undefined; }
}

export function lastLine(file: string): string | undefined {
  const text = readText(file);
  if (!text) return undefined;
  const lines = text.trimEnd().split('\n');
  return lines[lines.length - 1] || undefined;
}
