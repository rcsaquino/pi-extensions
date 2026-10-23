import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { buildNotice, formatDuration } from './notice.ts';
import { currentBootId, groupAlive, identityAlive, killGroup, procStat, signal } from './proc.ts';
import { findDefinition, loadConfig, promptText, subagentsRoot } from './registry.ts';
import { resolveSelection, type Selection } from './model.ts';
import {
  atomicWrite, createRunDir, isIncompatible, lastLine, listRunDirs, mtimeMs, newRunId,
  readJson, readRecord, readText, writeRecord,
} from './store.ts';
import {
  SCHEMA_VERSION, type AgentConfig, type AgentDefinition, type Disposition, type ReadyInfo,
  type RunRecord, type RunStatus,
} from './types.ts';

const SUPERVISOR = fileURLToPath(new URL('../supervisor.mjs', import.meta.url));
const READY_TIMEOUT_MS = 2000;
const EXIT_GRACE_MS = 15000;
const SETTLING_STALE_MS = 60000;
const POLL_MS = 1000;
const REPORT_PAGE = 12000;
const LIST_PAGE = 20;
const NOTICE_MAX_ATTEMPTS = 5;
const NOTICE_RETRY_BASE_MS = 1000;
const NOTICE_RETRY_MAX_MS = 60000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

export interface ListedRun {
  id: string;
  agent: string;
  title: string;
  status: RunStatus | 'incompatible';
  createdAt: string;
  finishedAt?: string;
  duration: string;
  reason?: string;
}

export interface ResultPage {
  id: string;
  status: RunStatus | 'incompatible';
  text: string;
  totalChars: number;
  nextOffset?: number;
  reason?: string;
  reportPath?: string;
}

interface LocatedRun { dir: string; record?: RunRecord }

function scanRunDirs(root: string): { agent: string; dir: string }[] {
  try {
    return scanRunDirsStrict(root);
  } catch {
    return [];
  }
}

/** Fail-closed scan for the idle-compaction provider: only an absent root is empty. */
function scanRunDirsStrict(root: string): { agent: string; dir: string }[] {
  let agents: { name: string; dir: string }[];
  try {
    agents = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'runs')
      .map(entry => ({ name: entry.name, dir: join(root, entry.name) }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Cannot inspect subagent run state safely.');
  }
  const runs: { agent: string; dir: string }[] = [];
  for (const agent of agents) {
    try {
      for (const dir of listRunDirsStrict(agent.dir)) runs.push({ agent: agent.name, dir });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot inspect')) throw error;
      throw new Error('Cannot inspect subagent run state safely.');
    }
  }
  return runs;
}

function listRunDirsStrict(agentDir: string): string[] {
  try {
    return readdirSync(join(agentDir, 'runs'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => join(agentDir, 'runs', entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Cannot inspect subagent run state safely.');
  }
}

function readReady(dir: string): ReadyInfo | undefined {
  const raw = readJson<ReadyInfo>(join(dir, 'supervisor.ready'));
  if (!raw || !Number.isInteger(raw.supervisorPid) || !Number.isInteger(raw.workerPid)) return undefined;
  return raw;
}

function readExitCode(dir: string): number | undefined {
  const text = readText(join(dir, 'exit.code'));
  if (text === undefined) return undefined;
  const value = Number(text.trim());
  return Number.isInteger(value) ? value : undefined;
}

function readReason(dir: string): string | undefined {
  const text = readText(join(dir, 'exit.reason'));
  return text?.trim() || undefined;
}

export function mapExit(code: number | undefined, reason: string | undefined, cancelRequested: boolean): { status: RunStatus; reason?: string } {
  if (code === undefined) return cancelRequested
    ? { status: 'cancelled', reason: 'cancelled' }
    : { status: 'orphaned', reason: 'unrecorded_exit' };
  switch (code) {
    case 0: return { status: 'done' };
    case 3: return { status: 'failed', reason: 'empty_report' };
    case 4: return { status: 'failed', reason: reason === 'aborted' || reason === 'spawn_error' ? reason : 'protocol_error' };
    case 5: return { status: 'failed', reason: 'turn_limit' };
    case 74: return { status: 'failed', reason: 'io_error' };
    case 97: return { status: 'failed', reason: 'cwd_missing' };
    case 124: return { status: 'failed', reason: 'timeout' };
    case 130: return { status: 'cancelled', reason: 'cancelled' };
    case 131: return { status: 'cancelled', reason: 'parent_gone' };
    default: return { status: 'failed', reason: `exit_${code}` };
  }
}

function buildArgv(definition: AgentDefinition, config: AgentConfig, selection: Selection, dir: string): string[] {
  const argv = ['pi', '--mode', 'rpc', '-ne', '-ns', '-np', '--append-system-prompt', definition.promptPath];
  if (selection.providerFlag) argv.push('--provider', selection.providerFlag);
  argv.push('--model', selection.model, '--thinking', selection.thinking);
  if (config.excludeTools.length) argv.push('-xt', config.excludeTools.join(','));
  for (const skill of config.skills) argv.push('--skill', skill);
  for (const extension of config.extensions) argv.push('-e', extension);
  argv.push('--session-dir', join(dir, 'session'));
  return argv;
}

function buildBrief(input: { agent: string; cwd: string; body: string }, dispatchedAt: Date, timeoutSeconds: number): string {
  const deadline = new Date(dispatchedAt.getTime() + timeoutSeconds * 1000).toISOString();
  return [
    '# Brief', '',
    'From: Eve',
    `To: subagent ${input.agent}`,
    `Dispatched: ${dispatchedAt.toISOString()}`,
    `Working directory: ${input.cwd}`,
    `Deadline: ${deadline} (dispatch time plus timeoutSeconds)`,
    'Tools: as declared in agent.json',
    'Report: your final message', '',
    '---', '',
    input.body,
  ].join('\n');
}

export class SubagentsManager {
  private readonly pi: ExtensionAPI;
  private ctx?: ExtensionContext;
  private readonly explicitRoot?: string;
  private resolvedRoot?: string;
  private timer?: NodeJS.Timeout;
  private noticeTimer?: NodeJS.Timeout;
  private ticking = false;
  private readonly dirs = new Map<string, string>();
  private readonly notified = new Set<string>();
  private readonly cancelTimers = new Map<string, NodeJS.Timeout>();
  private readonly exitSeen = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private shut = false;

  constructor(pi: ExtensionAPI, root?: string) {
    this.pi = pi;
    this.explicitRoot = root;
  }

  /** Resolve lazily so a malformed PI_CODING_AGENT_DIR fails at use, not extension load. */
  private get root(): string {
    return this.explicitRoot ?? (this.resolvedRoot ??= subagentsRoot());
  }

  get closed(): boolean { return this.shut; }

  async init(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.rememberDirs();
    await this.reconcile();
    await this.injectPending();
    await this.prune();
    this.ensureTimer();
  }

  // ------------------------------------------------------------------ helpers

  private sessionId(): string {
    const ctx = this.ctx;
    if (!ctx) throw new Error('Subagent manager has no session');
    return ctx.sessionManager.getSessionId();
  }

  private sessionFile(): string | undefined {
    return this.ctx?.sessionManager.getSessionFile();
  }

  private maxRunning(): number {
    const raw = this.pi.getFlag('subagents-max-running');
    const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed)) return 4;
    return Math.min(16, Math.max(1, parsed));
  }

  private rememberDirs(): void {
    const seen = new Set<string>();
    for (const { dir } of scanRunDirs(this.root)) {
      const id = basename(dir);
      this.dirs.set(id, dir);
      seen.add(id);
    }
    for (const id of this.dirs.keys()) if (!seen.has(id)) this.dirs.delete(id);
  }

  private locate(id: string): LocatedRun {
    this.rememberDirs();
    const dir = this.dirs.get(id);
    if (!dir || !existsSync(join(dir, 'task.json'))) throw new Error(`Run ${id} was not found in this session`);
    const record = readRecord(dir);
    if (record && record.sessionId !== this.sessionId()) throw new Error(`Run ${id} was not found in this session`);
    if (!record) {
      if (!isIncompatible(dir)) throw new Error(`Run ${id} was not found in this session`);
      const raw = readJson<{ sessionId?: string }>(join(dir, 'task.json'));
      if (raw?.sessionId && raw.sessionId !== this.sessionId()) throw new Error(`Run ${id} was not found in this session`);
    }
    return { dir, ...(record ? { record } : {}) };
  }

  /** Synchronous snapshot for the neutral idle-compaction background-work provider. */
  activeWork(sessionId: string): { id: string; sessionId: string }[] {
    const active: { id: string; sessionId: string }[] = [];
    for (const { dir } of scanRunDirsStrict(this.root)) {
      let text: string;
      try {
        text = readFileSync(join(dir, 'task.json'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // An unreadable record can belong to a live worker; never report idle.
        throw new Error('Subagent run state is unreadable; refusing to report idle.');
      }
      let record: RunRecord;
      try {
        record = JSON.parse(text) as RunRecord;
      } catch {
        // Unknown state must never be reported as idle: a malformed record can
        // still belong to a live worker. The guard fails closed on this error.
        throw new Error('Subagent run state is unreadable; refusing to report idle.');
      }
      if (!record || typeof record !== 'object' || record.schemaVersion !== SCHEMA_VERSION ||
          typeof record.id !== 'string' || typeof record.sessionId !== 'string' || typeof record.status !== 'string') {
        throw new Error('Subagent run state is unsupported or malformed; refusing to report idle.');
      }
      if (record.status === 'running' && (record.sessionId === sessionId || record.sessionFile === sessionId)) {
        active.push({ id: record.id, sessionId: record.sessionId });
      }
    }
    return active;
  }

  private ownedRunning(): { dir: string; record: RunRecord }[] {
    const sessionId = this.sessionId();
    const running: { dir: string; record: RunRecord }[] = [];
    for (const { dir } of scanRunDirs(this.root)) {
      const record = readRecord(dir);
      if (record && record.status === 'running' && record.sessionId === sessionId) running.push({ dir, record });
    }
    return running;
  }

  /** Serialize record updates per run so watcher, steer and cancel cannot overwrite. */
  private chain<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tracked = next.catch(() => undefined);
    this.chains.set(id, tracked);
    void tracked.finally(() => { if (this.chains.get(id) === tracked) this.chains.delete(id); });
    return next;
  }

  private async updateRecord(dir: string, record: RunRecord, mutate: (record: RunRecord) => void): Promise<RunRecord> {
    return this.chain(record.id, async () => {
      const current = readRecord(dir) ?? record;
      mutate(current);
      writeRecord(dir, current);
      return current;
    });
  }

  // ------------------------------------------------------------------- spawn

  private async spawnSupervisor(dir: string): Promise<number> {
    const child = spawn(process.execPath, [SUPERVISOR, dir], {
      detached: true, stdio: 'ignore', cwd: dir,
    });
    child.unref();
    if (!child.pid) throw new Error('Could not start the subagent supervisor');
    return child.pid;
  }

  private async waitReady(dir: string, pid: number, bootId: string | undefined): Promise<ReadyInfo | undefined> {
    const startTicks = procStat(pid)?.startTicks;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const ready = readReady(dir);
      if (ready) return identityAlive(pid, startTicks, bootId) ? ready : undefined;
      if (!identityAlive(pid, startTicks, bootId)) return undefined;
      await sleep(25);
    }
    const ready = readReady(dir);
    return ready && identityAlive(pid, startTicks, bootId) ? ready : undefined;
  }

  private async teardownStart(dir: string, pid: number | undefined, bootId: string | undefined): Promise<ReadyInfo | undefined> {
    if (!pid) return undefined;
    const startTicks = procStat(pid)?.startTicks;
    if (identityAlive(pid, startTicks, bootId)) signal(pid, 'SIGTERM');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && identityAlive(pid, startTicks, bootId)) await sleep(50);
    const ready = readReady(dir);
    if (ready && groupAlive(ready.workerPid, ready.workerStartTicks)) killGroup(ready.workerPid);
    if (identityAlive(pid, startTicks, bootId)) killGroup(pid);
    return ready;
  }

  // ---------------------------------------------------------------- dispatch

  async dispatch(input: {
    agent: string; title: string; brief: string; cwd: string;
  }, ctx: ExtensionContext): Promise<{ id: string; status: string; agent: string; title: string }> {
    this.ctx = ctx;
    if (process.env.PI_SUBAGENTS_WORKER === '1') throw new Error('Subagents cannot dispatch other subagents');
    await this.reconcile();

    const sessionFile = this.sessionFile();
    if (!sessionFile) throw new Error('subagent dispatch requires a saved session');
    if (/[\r\n]/.test(input.title)) input = { ...input, title: input.title.replace(/\s*[\r\n]+\s*/g, ' ') };

    const definition = findDefinition(input.agent, this.root);
    const config = loadConfig(definition.dir);
    promptText(definition.promptPath);

    if (!isAbsolute(input.cwd)) throw new Error('cwd must be an absolute path');
    let directory: ReturnType<typeof statSync>;
    try { directory = statSync(input.cwd); } catch { throw new Error(`cwd does not exist: ${input.cwd}`); }
    if (!directory.isDirectory()) throw new Error(`cwd is not a directory: ${input.cwd}`);

    const thinking = ctx.thinkingLevel ?? this.pi.getThinkingLevel();
    const selection = resolveSelection(ctx.modelRegistry, ctx.model, thinking, config);

    const running = this.ownedRunning();
    if (running.length >= this.maxRunning()) {
      const limit = this.maxRunning();
      throw new Error(`At most ${limit} subagent${limit === 1 ? '' : 's'} may run at once; cancel one or wait for a notice`);
    }

    const dispatchedAt = new Date();
    let id = newRunId(dispatchedAt);
    let dir = '';
    for (let attempt = 0; ; attempt += 1) {
      try { dir = createRunDir(join(definition.dir, 'runs'), id); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 5) {
          throw new Error(`Could not allocate a run directory: ${(error as Error).message}`);
        }
        id = newRunId(new Date());
      }
    }
    this.dirs.set(id, dir);

    const record: RunRecord = {
      schemaVersion: SCHEMA_VERSION,
      id, agent: definition.name, title: input.title, cwd: input.cwd,
      sessionId: this.sessionId(), sessionFile,
      status: 'running', createdAt: dispatchedAt.toISOString(),
      provider: selection.provider, model: selection.model, thinking: selection.thinking,
      timeoutSeconds: config.timeoutSeconds, maxTurns: config.maxTurns,
      steerCount: 0, deniedDialogs: 0,
    };
    writeRecord(dir, record);
    atomicWrite(join(dir, 'brief.md'), buildBrief({
      agent: definition.name, cwd: input.cwd, body: input.brief,
    }, dispatchedAt, config.timeoutSeconds));
    const argv = buildArgv(definition, config, selection, dir);
    atomicWrite(join(dir, 'argv.json'), `${JSON.stringify(argv, null, 2)}\n`);

    let pid: number;
    try { pid = await this.spawnSupervisor(dir); }
    catch (error) {
      await this.updateRecord(dir, record, current => {
        current.status = 'failed'; current.reason = 'spawn_error';
        current.finishedAt = new Date().toISOString();
      });
      throw new Error(`Subagent ${definition.name} could not start (run ${id}): ${(error as Error).message}`);
    }

    const bootId = currentBootId();
    const startTicks = procStat(pid)?.startTicks;
    const started = await this.updateRecord(dir, record, current => {
      current.pid = pid; current.pgid = pid;
      if (bootId) current.bootId = bootId;
      if (startTicks !== undefined) current.startTicks = startTicks;
      current.startedAt = new Date().toISOString();
    });

    const ready = await this.waitReady(dir, pid, bootId);
    if (!ready) {
      const late = await this.teardownStart(dir, pid, bootId);
      const code = readExitCode(dir);
      const mapped = mapExit(code, readReason(dir), false);
      await this.updateRecord(dir, started, current => {
        current.status = mapped.status === 'cancelled' || mapped.status === 'orphaned' ? mapped.status : 'failed';
        current.reason = mapped.reason ?? 'spawn_error';
        if (code !== undefined) current.exitCode = code;
        if (late) { current.workerPid = late.workerPid; current.workerPgid = late.workerPgid; current.workerStartTicks = late.workerStartTicks; }
        current.finishedAt = new Date().toISOString();
      });
      this.clearCancelTimer(id);
      const detail = lastLine(join(dir, 'supervisor.log')) ?? 'no supervisor diagnostics';
      throw new Error(`Subagent ${definition.name} did not start (run ${id}): ${detail}`);
    }

    await this.updateRecord(dir, started, current => {
      current.workerPid = ready.workerPid;
      current.workerPgid = ready.workerPgid;
      current.workerStartTicks = ready.workerStartTicks;
    });
    this.ensureTimer();
    return { id, status: 'running', agent: definition.name, title: record.title };
  }

  // ---------------------------------------------------------------- steering

  async steer(id: string, message: string, ctx?: ExtensionContext): Promise<{ id: string; disposition: Disposition | 'unconfirmed' }> {
    if (ctx) this.ctx = ctx;
    await this.reconcile();
    const { dir, record } = this.locate(id);
    if (!record) throw new Error(`Run ${id} is incompatible`);
    if (record.status !== 'running') throw new Error(`Run ${id} is already settled; read its report`);
    if (existsSync(join(dir, 'settling'))) throw new Error('Run is settling; steering was not sent');
    if (!message.trim()) throw new Error('Steering message is empty');
    if (message.length > 8000) throw new Error('Steering message exceeds 8000 characters');

    const steerDir = join(dir, 'steer');
    mkdirSync(steerDir, { recursive: true, mode: 0o700 });
    let sequence = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      sequence = nextSequence(steerDir);
      const temp = join(steerDir, `${String(sequence).padStart(4, '0')}.json.tmp`);
      try {
        const fd = openSync(temp, 'wx', 0o600);
        try { writeSync(fd, `${JSON.stringify({ message, at: new Date().toISOString() })}\n`); }
        finally { closeSync(fd); }
        renameSync(temp, join(steerDir, `${String(sequence).padStart(4, '0')}.json`));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 9) {
          throw new Error(`Could not queue steering: ${(error as Error).message}`);
        }
        sequence = 0;
      }
    }
    if (!sequence) throw new Error('Could not allocate a steering sequence');

    const ackPath = join(steerDir, `${String(sequence).padStart(4, '0')}.ack`);
    let disposition: Disposition | 'unconfirmed' = 'unconfirmed';
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ack = readJson<{ disposition?: Disposition }>(ackPath);
      if (ack?.disposition) { disposition = ack.disposition; break; }
      await sleep(25);
    }
    if (disposition === 'queued' || disposition === 'started') {
      const current = readRecord(dir);
      if (current) await this.updateRecord(dir, current, next => { next.steerCount += 1; });
    }
    return { id, disposition };
  }

  // ------------------------------------------------------------------- tasks

  async list(page: number): Promise<{ runs: ListedRun[]; page: number }> {
    const sessionId = this.sessionId();
    const runs: ListedRun[] = [];
    for (const { agent, dir } of scanRunDirs(this.root)) {
      const raw = readJson<Record<string, unknown>>(join(dir, 'task.json'));
      if (!raw) continue;
      if (raw.sessionId !== sessionId) continue;
      const record = readRecord(dir);
      if (!record) { runs.push({ id: String(raw.id ?? basename(dir)), agent, title: '', status: 'incompatible', createdAt: '', duration: '—' }); continue; }
      runs.push({
        id: record.id, agent: record.agent, title: record.title, status: record.status,
        createdAt: record.createdAt, ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
        duration: formatDuration(record.createdAt, record.finishedAt),
        ...(record.reason ? { reason: record.reason } : {}),
      });
    }
    runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const start = (page - 1) * LIST_PAGE;
    return { runs: runs.slice(start, start + LIST_PAGE), page };
  }

  async status(id: string): Promise<Record<string, unknown>> {
    const { dir, record } = this.locate(id);
    if (!record) return { id, status: 'incompatible' };
    const output: Record<string, unknown> = { ...record };
    const bytes = statSize(join(dir, 'report.md'));
    if (bytes !== undefined) output.reportPath = join(dir, 'report.md');
    output.runDir = dir;
    return output;
  }

  async result(id: string, offset = 0): Promise<ResultPage> {
    const { dir, record } = this.locate(id);
    if (!record) return { id, status: 'incompatible', text: `Run ${id} uses an unsupported schema version.`, totalChars: 0 };
    const reportPath = join(dir, 'report.md');
    const report = readText(reportPath);
    if (record.status === 'running') {
      return { id, status: 'running', text: `Run ${id} is still running.`, totalChars: 0 };
    }
    if (report === undefined) {
      return {
        id, status: record.status, text: `Run ${id} has no report.`, totalChars: 0,
        ...(record.reason ? { reason: record.reason } : {}),
      };
    }
    const totalChars = report.length;
    let start = Math.max(0, Math.min(offset, totalChars));
    // UTF-16 offsets are public, but a page boundary must not split a surrogate
    // pair. Back the start up (and pull the end back) by one code unit.
    if (start > 0 && isLowSurrogate(report.charCodeAt(start))) start -= 1;
    let end = Math.min(start + REPORT_PAGE, totalChars);
    if (end > start && end < totalChars && isHighSurrogate(report.charCodeAt(end - 1))) end -= 1;
    if (end <= start) end = Math.min(totalChars, start + 1);
    const text = report.slice(start, end);
    const next = end < totalChars ? end : undefined;
    return {
      id, status: record.status, text, totalChars,
      ...(next !== undefined ? { nextOffset: next } : {}),
      reportPath,
    };
  }

  async cancel(id: string): Promise<RunRecord> {
    await this.reconcile();
    const { dir, record } = this.locate(id);
    if (!record) throw new Error(`Run ${id} is incompatible; it cannot be cancelled`);
    if (record.status !== 'running') throw new Error(`Run ${id} is already ${record.status}`);
    if (existsSync(join(dir, 'settling'))) throw new Error('Run is settling; cancel refused');

    const updated = await this.updateRecord(dir, record, current => {
      current.cancelRequestedAt = new Date().toISOString();
    });
    if (updated.pid) signal(updated.pid, 'SIGTERM');

    const existing = this.cancelTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.cancelTimers.delete(id);
      const latest = readRecord(dir);
      if (!latest || latest.status !== 'running') return;
      if (identityAlive(latest.pid, latest.startTicks, latest.bootId)) killGroup(latest.pid);
      if (sameBoot(latest.bootId) && groupAlive(latest.workerPid, latest.workerStartTicks)) killGroup(latest.workerPid);
      void this.reconcile();
    }, 15000);
    timer.unref?.();
    this.cancelTimers.set(id, timer);
    this.ensureTimer();
    return updated;
  }

  // ------------------------------------------------------------- reconcile

  async reconcile(): Promise<void> {
    this.rememberDirs();
    const sessionId = this.sessionId();
    for (const { dir } of scanRunDirs(this.root)) {
      const record = readRecord(dir);
      if (!record || record.sessionId !== sessionId) continue;
      if (record.status === 'running') { await this.reconcileRunning(dir, record); continue; }
      if (record.notice === 'pending') await this.injectNotice(dir, record);
    }
    this.ensureTimer();
  }

  private async reconcileRunning(dir: string, record: RunRecord): Promise<void> {
    let current = record;
    const readyPath = join(dir, 'supervisor.ready');
    if ((!current.pid || !current.workerPid) && existsSync(readyPath)) {
      const ready = readReady(dir);
      if (ready) {
        current = await this.updateRecord(dir, current, next => {
          next.pid ??= ready.supervisorPid;
          next.pgid ??= ready.supervisorPgid;
          next.workerPid ??= ready.workerPid;
          next.workerPgid ??= ready.workerPgid;
          next.workerStartTicks ??= ready.workerStartTicks;
        });
      }
    }

    const alive = identityAlive(current.pid, current.startTicks, current.bootId);
    if (!alive) { await this.settleFromDisk(dir, current); return; }

    if (existsSync(join(dir, 'exit.code'))) {
      const seen = this.exitSeen.get(current.id) ?? Date.now();
      this.exitSeen.set(current.id, seen);
      if (Date.now() - seen >= EXIT_GRACE_MS) {
        if (identityAlive(current.pid, current.startTicks, current.bootId)) killGroup(current.pid);
        if (sameBoot(current.bootId) && groupAlive(current.workerPid, current.workerStartTicks)) killGroup(current.workerPid);
        await this.settleFromDisk(dir, current);
      }
      return;
    }

    const settledAt = mtimeMs(join(dir, 'settling'));
    if (settledAt !== undefined && Date.now() - settledAt > SETTLING_STALE_MS) {
      if (!existsSync(join(dir, 'settling'))) return;
      if (identityAlive(current.pid, current.startTicks, current.bootId)) killGroup(current.pid);
      if (sameBoot(current.bootId) && groupAlive(current.workerPid, current.workerStartTicks)) killGroup(current.workerPid);
      await this.finish(dir, current, { status: 'failed', reason: 'finalization_timeout' });
    }
  }

  private async settleFromDisk(dir: string, record: RunRecord): Promise<void> {
    if (sameBoot(record.bootId) && groupAlive(record.workerPid, record.workerStartTicks)) killGroup(record.workerPid);
    const code = readExitCode(dir);
    const mapped = code === undefined
      ? mapExit(undefined, undefined, !!record.cancelRequestedAt)
      : mapExit(code, readReason(dir), !!record.cancelRequestedAt);
    await this.finish(dir, record, { ...mapped, code });
  }

  private async finish(dir: string, record: RunRecord, outcome: { status: RunStatus; reason?: string; code?: number }): Promise<void> {
    this.clearCancelTimer(record.id);
    this.exitSeen.delete(record.id);
    this.dirs.set(record.id, dir);
    const updated = await this.updateRecord(dir, record, current => {
      current.status = outcome.status;
      if (outcome.reason) current.reason = outcome.reason;
      if (outcome.code !== undefined) current.exitCode = outcome.code;
      current.finishedAt = new Date().toISOString();
      const bytes = statSize(join(dir, 'report.md'));
      if (bytes !== undefined) current.reportBytes = bytes;
      const dialogs = readJson<{ count?: number }>(join(dir, 'dialogs.json'));
      if (Number.isInteger(dialogs?.count)) current.deniedDialogs = dialogs!.count as number;
      if (current.notice === undefined) current.notice = 'pending';
    });
    await this.injectNotice(dir, updated);
    await this.prune();
  }

  private clearCancelTimer(id: string): void {
    const timer = this.cancelTimers.get(id);
    if (timer) { clearTimeout(timer); this.cancelTimers.delete(id); }
  }

  // ----------------------------------------------------------------- notices

  private async injectPending(): Promise<void> {
    const sessionId = this.sessionId();
    for (const { dir } of scanRunDirs(this.root)) {
      const record = readRecord(dir);
      if (!record || record.sessionId !== sessionId) continue;
      if (record.notice !== 'pending' && record.notice !== 'failed') continue;
      await this.injectNotice(dir, record);
    }
  }

  private noticeBackoff(attempts: number): number {
    return Math.min(NOTICE_RETRY_MAX_MS, NOTICE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  }

  private scheduleNoticeRetry(delayMs: number): void {
    if (this.shut || this.noticeTimer) return;
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      void this.injectPending().catch(() => {});
    }, Math.max(25, Math.min(delayMs, NOTICE_RETRY_MAX_MS)));
    this.noticeTimer.unref?.();
  }

  private async injectNotice(dir: string, record: RunRecord): Promise<void> {
    if (this.shut) return;
    if (this.notified.has(record.id)) return;
    if (record.status === 'running') return;
    if (record.notice === 'sent') return;
    if (record.sessionId !== this.sessionId()) return;

    const attempts = record.noticeAttempts ?? 0;
    if (attempts >= NOTICE_MAX_ATTEMPTS) {
      if (record.notice !== 'failed') {
        await this.updateRecord(dir, record, current => {
          current.notice = 'failed';
          delete current.noticeNextAttemptAt;
        });
      }
      return;
    }
    const due = record.noticeNextAttemptAt ? Date.parse(record.noticeNextAttemptAt) : NaN;
    if (Number.isFinite(due) && due > Date.now()) {
      this.scheduleNoticeRetry(due - Date.now());
      return;
    }

    const reportPath = join(dir, 'report.md');
    const report = readText(reportPath);
    const hasReport = report !== undefined && report.trim().length > 0;
    const detail = hasReport
      ? report!
      : record.reason ?? lastLine(join(dir, 'supervisor.log')) ?? 'no supervisor diagnostics';
    const text = buildNotice(record, detail, hasReport);

    this.notified.add(record.id);
    let attempted: RunRecord;
    try {
      attempted = await this.updateRecord(dir, record, current => {
        current.notice = 'pending';
        current.noticeAttempts = (current.noticeAttempts ?? attempts) + 1;
        delete current.noticeNextAttemptAt;
      });
    } catch {
      this.notified.delete(record.id);
      throw new Error(`Could not record the notice attempt for ${record.id}`);
    }
    if (record.sessionId !== this.sessionId()) { this.notified.delete(record.id); return; }
    let delivered = false;
    try {
      this.pi.sendMessage(
        { customType: 'subagent-notice', content: text, display: false, details: { subagentNoticeId: record.id } },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
      delivered = true;
    } catch { delivered = false; }
    const updated = await this.updateRecord(dir, attempted, current => {
      if (delivered) {
        current.notice = 'sent';
        current.noticeAt = new Date().toISOString();
        delete current.noticeNextAttemptAt;
      } else {
        const tries = current.noticeAttempts ?? attempts + 1;
        if (tries >= NOTICE_MAX_ATTEMPTS) {
          current.notice = 'failed';
          delete current.noticeNextAttemptAt;
        } else {
          current.notice = 'pending';
          current.noticeNextAttemptAt = new Date(Date.now() + this.noticeBackoff(tries)).toISOString();
        }
      }
    });
    if (!delivered) {
      this.notified.delete(record.id);
      const next = updated.noticeNextAttemptAt ? Date.parse(updated.noticeNextAttemptAt) : NaN;
      if (updated.notice === 'pending' && Number.isFinite(next)) this.scheduleNoticeRetry(next - Date.now());
    }
  }

  // --------------------------------------------------------------- retention

  async prune(): Promise<void> {
    const sessionId = this.sessionId();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const groups = new Map<string, { dir: string; record: RunRecord }[]>();

    for (const { agent, dir } of scanRunDirs(this.root)) {
      const raw = readJson<Record<string, unknown>>(join(dir, 'task.json'));
      if (!raw) {
        const modified = mtimeMs(dir) ?? now;
        if (now - modified > 14 * day) {
          try { rmSync(dir, { recursive: true, force: true }); } catch {}
          this.forget(basename(dir));
        }
        continue;
      }
      if (raw.schemaVersion !== SCHEMA_VERSION) continue;
      const record = readRecord(dir);
      if (!record || record.sessionId !== sessionId) continue;
      if (record.status === 'running') continue;
      if (record.notice === 'pending') continue;
      const created = Date.parse(record.createdAt);
      if (Number.isFinite(created) && now - created > 14 * day) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
        this.forget(record.id);
        continue;
      }
      const bucket = groups.get(agent) ?? [];
      bucket.push({ dir, record });
      groups.set(agent, bucket);
    }

    for (const bucket of groups.values()) {
      bucket.sort((a, b) => (a.record.createdAt < b.record.createdAt ? 1 : -1));
      for (const { dir, record } of bucket.slice(100)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
        this.forget(record.id);
      }
    }
  }

  /** Drop per-run bookkeeping once the run directory is pruned or the manager closes. */
  private forget(id: string): void {
    this.dirs.delete(id);
    this.notified.delete(id);
    this.exitSeen.delete(id);
    this.chains.delete(id);
    this.clearCancelTimer(id);
  }

  // ------------------------------------------------------------------ timers

  private ensureTimer(): void {
    if (this.shut || this.timer) return;
    if (!this.ctx) return;
    if (!this.ownedRunning().length) return;
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.shut) return;
    this.ticking = true;
    try {
      await this.reconcile();
      if (!this.ownedRunning().length) this.stopTimer();
    } catch {} finally { this.ticking = false; }
  }

  private stopTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  async shutdown(): Promise<void> {
    this.shut = true;
    this.stopTimer();
    if (this.noticeTimer) { clearTimeout(this.noticeTimer); this.noticeTimer = undefined; }
    for (const timer of this.cancelTimers.values()) clearTimeout(timer);
    this.cancelTimers.clear();
    this.dirs.clear();
    this.notified.clear();
    this.exitSeen.clear();
    this.chains.clear();
  }
}

function nextSequence(steerDir: string): number {
  let max = 0;
  let names: string[] = [];
  try { names = readdirSync(steerDir); } catch { return 1; }
  for (const name of names) {
    const match = /^(\d{4,})\.json$/.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function statSize(path: string): number | undefined {
  try { return statSync(path).size; } catch { return undefined; }
}

function sameBoot(bootId: string | undefined): boolean {
  if (!bootId) return true;
  return currentBootId() === bootId;
}
