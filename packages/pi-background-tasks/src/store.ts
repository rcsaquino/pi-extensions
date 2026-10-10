import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { RecordData } from './types.ts';
import { addUsage, emptyUsage, isActive } from './types.ts';
import { buildSettlementReport, safeCounter, safeDiagnostics, safeStoredError, safeToolName } from './report.ts';
import { safeManifest } from './staging.ts';
import { Directory, readRegular } from './files.ts';

function safeRecord(record: RecordData): RecordData {
  const usage = emptyUsage(); addUsage(usage, record.usage);
  const safe: RecordData = {
    version: record.version, id: record.id, title: record.title, sessionId: record.sessionId, cwd: record.cwd,
    provider: record.provider, model: record.model, thinking: record.thinking, status: record.status, access: record.access,
    ...(record.contextMode !== undefined ? { contextMode: record.contextMode } : {}),
    ...(record.execution === 'direct' || record.execution === 'staged' ? { execution: record.execution } : {}),
    ...(record.queuedAt !== undefined ? { queuedAt: safeCounter(record.queuedAt) } : {}),
    ...(record.queueWaitMs !== undefined ? { queueWaitMs: safeCounter(record.queueWaitMs) } : {}),
    ...(['capacity', 'admission'].includes(record.waitingReason ?? '') ? { waitingReason: record.waitingReason } : {}),
    ...(record.manifest !== undefined ? { manifest: safeManifest(record.manifest, record.id) } : {}),
    ...(['ready', 'published', 'review-required'].includes(record.publication ?? '') ? { publication: record.publication } : {}),
    startedAt: safeCounter(record.startedAt), ...(record.finishedAt !== undefined ? { finishedAt: safeCounter(record.finishedAt) } : {}),
    etaSeconds: safeCounter(record.etaSeconds), etaMaxSeconds: safeCounter(record.etaMaxSeconds), estimateReason: record.estimateReason,
    lastActivityAt: safeCounter(record.lastActivityAt), lastTool: safeToolName(record.lastTool),
    toolCalls: safeCounter(record.toolCalls), turns: safeCounter(record.turns), usage, usageReported: record.usageReported === true,
    notification: ['pending', 'queued', 'read'].includes(record.notification) ? record.notification : 'read',
    overrunNotified: record.overrunNotified === true, error: safeStoredError(record.error),
    ...(record.reportSource === 'worker' || record.reportSource === 'fallback' ? { reportSource: record.reportSource } : {}),
  };
  if (record.terminalDiagnostics !== undefined) safe.terminalDiagnostics = safeDiagnostics(record.terminalDiagnostics);
  return safe;
}

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const validId = (id: string): boolean => /^bg-[a-f0-9]{12}$/.test(id);

export async function privateDirectory(path: string): Promise<void> {
  const dir = await Directory.open(path, true);
  try { const stat = await dir.handle.stat(); if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Background storage must be private and owned.'); }
  finally { await dir.close(); }
}
export async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  const dir = await Directory.open(dirname(path)); let temp: string | undefined;
  try {
    temp = await dir.prepare(Buffer.from(content)); await dir.check();
    // Replace a final symlink atomically, never follow it or chmod its target.
    await fs.rename(dir.entry(temp), dir.entry(basename(path))); await dir.handle.sync();
  } finally { if (temp) await fs.unlink(dir.entry(temp)).catch(() => {}); await dir.close(); }
}
export class Store {
  readonly root: string;
  readonly recordsDir: string;
  readonly sessionId: string;
  /** Bounded report-only recovery if storage is unavailable, not durable task continuation. */
  readonly recoveryReports = new Map<string, string>();
  constructor(root: string, sessionId: string) {
    this.root = resolve(root); this.sessionId = sessionId;
    this.recordsDir = join(this.root, 'sessions', hash(sessionId));
  }
  async init(): Promise<void> { await privateDirectory(this.recordsDir); }
  path(id: string, suffix: 'json' | 'md'): string {
    if (!validId(id)) throw new Error('Invalid background task ID.');
    return join(this.recordsDir, `${id}.${suffix}`);
  }
  async write(record: RecordData, output?: string): Promise<void> {
    if (output !== undefined) await atomicPrivateWrite(this.path(record.id, 'md'), output);
    await atomicPrivateWrite(this.path(record.id, 'json'), JSON.stringify(safeRecord(record), null, 2) + '\n');
  }
  async output(id: string): Promise<string> {
    return readStoredText(this.path(id, 'md'), 4 * 1024 * 1024);
  }
  async restore(): Promise<RecordData[]> {
    const records: RecordData[] = [];
    for (const file of await fs.readdir(this.recordsDir)) {
      if (!/^bg-[a-f0-9]{12}\.json$/.test(file)) continue;
      let record = JSON.parse(await readStoredText(join(this.recordsDir, file), 1024 * 1024)) as RecordData;
      if (record.version !== 1 || record.sessionId !== this.sessionId || `${record.id}.json` !== file ||
          !['queued', 'starting', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(record.status) ||
          (record.contextMode !== undefined && !['brief', 'selected', 'full'].includes(record.contextMode)) ||
          (record.execution !== undefined && !['direct', 'staged'].includes(record.execution))) throw new Error('Invalid background task metadata.');
      record = safeRecord(record);
      const wasQueued = record.status === 'queued';
      const interrupted = isActive(record.status);
      if (interrupted) {
        record.status = 'interrupted'; record.finishedAt = Date.now(); record.notification = 'pending';
        record.error = wasQueued ? 'Pi stopped or reloaded while this task was queued. It was NOT replayed; no worker execution was resumed.' : 'Pi stopped or reloaded before this task settled. Effects may be partial. It was NOT replayed.';
        record.terminalDiagnostics = safeDiagnostics({ ...record.terminalDiagnostics, stopReason: 'missing', category: 'interrupted' });
      }
      let output: string | undefined;
      let unreadable = false;
      try { output = await this.output(record.id); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') throw e; // Never treat an unsafe symlink as a result.
        unreadable = code !== 'ENOENT';
      }
      if (interrupted || !output?.trim()) {
        if (!interrupted && (record.status === 'completed' || !record.terminalDiagnostics)) {
          if (record.status === 'completed') record.status = 'failed';
          record.terminalDiagnostics = safeDiagnostics({ stopReason: 'missing', category: 'missing_report' });
        }
        record.reportSource = 'fallback';
        const report = buildSettlementReport(record);
        try {
          if (unreadable) throw new Error('Result storage unavailable.');
          await this.write(record, report.text);
        } catch { this.recoveryReports.set(record.id, buildSettlementReport(record, '', true).text); }
      }
      records.push(record);
    }
    return records.sort((a, b) => a.startedAt - b.startedAt);
  }
}
async function readStoredText(path: string, limit: number): Promise<string> {
  const data = await readRegular(path, limit);
  if (!data) throw Object.assign(new Error('Stored background file is missing.'), { code: 'ENOENT' });
  return data.toString('utf8');
}
