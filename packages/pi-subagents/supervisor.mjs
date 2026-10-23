#!/usr/bin/env node
// Supervisor for one pi-subagents run. Owns the worker RPC session, enforces
// timeout, turn limit, steering and parent death, and records the outcome.
// This file is spawned detached and is the only code that parses worker protocol.
import {
  appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_LINE = 8 * 1024 * 1024;
// One buffered-byte budget independent of newline framing. A worker that never
// terminates a line must not grow supervisor memory past the advertised cap.
const MAX_BUFFER = MAX_LINE;
const PROTOCOL_EXIT_GRACE_MS = 1000;
const REPORT_CAP = 2 * 1024 * 1024;
const LOG_CAP = 1024 * 1024;
const LOG_TAIL = 256 * 1024;
const STEER_HEADER = 'Steering from Eve (adjust course; do not restart completed work):\n\n';
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

const runDir = process.argv[2] ? path.resolve(process.argv[2]) : '';
const file = name => path.join(runDir, name);
const exists = name => existsSync(file(name));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CappedLog {
  #path; #cap; #tailCap; #tail = []; #tailBytes = 0; #bytes = 0;
  constructor(target, cap = LOG_CAP, tailCap = LOG_TAIL) {
    this.#path = target; this.#cap = cap; this.#tailCap = tailCap;
    try { this.#bytes = statSync(target).size; }
    catch { this.#bytes = 0; try { writeFileSync(target, '', { mode: 0o600 }); } catch {} }
  }
  write(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (!data.length) return;
    try { appendFileSync(this.#path, data); } catch { return; }
    this.#bytes += data.length;
    this.#tail.push(data); this.#tailBytes += data.length;
    while (this.#tailBytes > this.#tailCap && this.#tail.length > 1) {
      this.#tailBytes -= this.#tail.shift().length;
    }
    if (this.#bytes > this.#cap) this.#compact();
  }
  #compact() {
    const combined = Buffer.concat(this.#tail);
    const tail = combined.length > this.#tailCap ? combined.subarray(combined.length - this.#tailCap) : combined;
    const marker = Buffer.from(`[log truncated at ${this.#cap} bytes; showing the tail]\n`);
    const body = Buffer.concat([marker, tail]);
    try { writeFileSync(this.#path, body); } catch { return; }
    this.#tail = [tail]; this.#tailBytes = tail.length; this.#bytes = body.length;
  }
}

if (!runDir) {
  process.stderr.write('pi-subagents supervisor: missing run directory\n');
  process.exit(2);
}

const log = new CappedLog(file('supervisor.log'));
const childLog = new CappedLog(file('child.log'));
const note = text => log.write(`${new Date().toISOString()} ${text}\n`);

function atomic(name, text, mode = 0o600) {
  const target = file(name);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temp, text, { mode });
  renameSync(temp, target);
}

function readJson(name) {
  return JSON.parse(readFileSync(file(name), 'utf8'));
}

function writeReason(reason) {
  if (!reason) return;
  try { atomic('exit.reason', reason); } catch (error) { note(`could not write exit.reason: ${error.message}`); }
}

let exitWritten = false;
function writeCode(code) {
  if (exitWritten) return false;
  try { atomic('exit.code', `${code}\n`); }
  catch (error) { note(`could not write exit.code ${code}: ${error.message}`); return false; }
  exitWritten = true;
  return true;
}

function setSettling() {
  try { atomic('settling', ''); } catch (error) { note(`could not write settling: ${error.message}`); }
}
function clearSettling() {
  try { rmSync(file('settling'), { force: true }); } catch {}
}

// ---------------------------------------------------------------- /proc facts

function procStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0], pgrp: Number(rest[2]), session: Number(rest[3]), startTicks: Number(rest[19]) };
  } catch { return undefined; }
}
function bootId() {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return undefined; }
}

const parentPid = process.ppid;
const parentStart = procStat(parentPid)?.startTicks;
const boot = bootId();
let parentGone = parentPid === 1 || !parentStart;

// --------------------------------------------------------------- run records

let task;
let argv;
try {
  task = readJson('task.json');
  argv = readJson('argv.json');
  if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string')) throw new Error('argv.json must be a non-empty string array');
  if (!task || typeof task !== 'object') throw new Error('task.json must be an object');
  if (!Number.isInteger(task.timeoutSeconds) || task.timeoutSeconds < 1) throw new Error('timeoutSeconds missing');
  if (!Number.isInteger(task.maxTurns) || task.maxTurns < 1) throw new Error('maxTurns missing');
  if (typeof task.cwd !== 'string' || !path.isAbsolute(task.cwd)) throw new Error('cwd missing');
} catch (error) {
  note(`startup refused: ${error.message}`);
  writeCode(74);
  process.exit(74);
}

if (!existsSync(task.cwd)) {
  note(`cwd does not exist: ${task.cwd}`);
  writeCode(97);
  process.exit(97);
}

if (parentGone) {
  note(`parent ${parentPid} already gone before worker start`);
  writeReason('parent_gone');
  writeCode(131);
  process.exit(131);
}

note(`start pid=${process.pid} pgid=${procStat(process.pid)?.pgrp ?? '?'} parent=${parentPid} cwd=${task.cwd} argv=${argv.join(' ')}`);

// ------------------------------------------------------------------- processes

let worker;
let workerPid = 0;
let workerStart = 0;
let workerExited = false;
let killIssued = false;

/** True when a /proc member still belongs to the recorded worker session. */
function workerGroupAlive(pid = workerPid, startTicks = workerStart) {
  if (!pid) return false;
  let entries;
  try { entries = readdirSync('/proc'); } catch { return false; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = procStat(Number(entry));
    if (!stat) continue;
    if (stat.session !== pid) continue;
    if (startTicks && stat.startTicks >= startTicks) return true;
  }
  return false;
}

function killWorkerGroup() {
  if (killIssued) return;
  if (!workerPid) return;
  if (!workerGroupAlive()) return;
  killIssued = true;
  try { process.kill(-workerPid, 'SIGKILL'); note(`killed worker group ${workerPid}`); }
  catch (error) { note(`worker group kill failed: ${error.message}`); }
}

function waitWorkerExit(ms) {
  if (workerExited || !worker) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    worker.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

// ------------------------------------------------------------------ RPC client

const inflight = new Map();
let rpcId = 0;
// Fixed-capacity framing buffer: chunks are copied into one bounded allocation
// instead of concatenated, so a newline-free flood cannot grow RSS past the cap.
let stdoutBuffer = Buffer.alloc(0);
let stdoutLength = 0;
let protocolFailed = false;

function writeLine(line) {
  return new Promise((resolve, reject) => {
    const stream = worker?.stdin;
    if (!stream || stream.destroyed) { reject(new Error('worker stdin closed')); return; }
    stream.write(line, error => error ? reject(error) : resolve());
  });
}

function rpc(command, timeoutMs = 30000) {
  return new Promise(resolve => {
    const id = `s${++rpcId}`;
    const timer = setTimeout(() => {
      inflight.delete(id);
      resolve({ success: false, timedOut: true });
    }, timeoutMs);
    inflight.set(id, message => { clearTimeout(timer); resolve(message); });
    writeLine(`${JSON.stringify({ id, ...command })}\n`).catch(error => {
      clearTimeout(timer);
      inflight.delete(id);
      resolve({ success: false, transport: true, error: error.message });
    });
  });
}

function stopReadingStdout() {
  // Release buffered bytes before the stream can deliver another chunk; the
  // listener guard also covers chunks already queued in the event loop.
  stdoutLength = 0;
  try { worker?.stdout?.removeListener('data', drainStdout); } catch {}
  try { worker?.stdout?.destroy(); } catch {}
}

function protocolFailure(reason) {
  if (protocolFailed || finalizing) return;
  protocolFailed = true;
  stopReadingStdout();
  note(`protocol failure: ${reason}`);
  void finalize(pending ?? { code: 4 });
}

function handleLine(line) {
  if (line.length && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
  if (!line.length) return;
  if (line.length > MAX_LINE) { protocolFailure('line over 8 MiB'); return; }
  let message;
  try { message = JSON.parse(line.toString('utf8')); }
  catch { protocolFailure('invalid JSON line'); return; }
  handleMessage(message);
}

function drainStdout(chunk) {
  if (protocolFailed || finalizing) return;
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf(10, offset);
    if (newline === -1) {
      const remaining = chunk.length - offset;
      if (stdoutLength + remaining > MAX_BUFFER) {
        protocolFailure('unterminated line over 8 MiB');
        return;
      }
      if (stdoutBuffer.length < MAX_BUFFER) stdoutBuffer = Buffer.allocUnsafe(MAX_BUFFER);
      chunk.copy(stdoutBuffer, stdoutLength, offset);
      stdoutLength += remaining;
      return;
    }
    const segment = chunk.subarray(offset, newline);
    if (stdoutLength + segment.length > MAX_LINE) {
      protocolFailure('line over 8 MiB');
      return;
    }
    let line;
    if (stdoutLength === 0) {
      line = segment;
    } else {
      if (stdoutBuffer.length < MAX_BUFFER) stdoutBuffer = Buffer.allocUnsafe(MAX_BUFFER);
      segment.copy(stdoutBuffer, stdoutLength);
      stdoutLength += segment.length;
      line = stdoutBuffer.subarray(0, stdoutLength);
    }
    stdoutLength = 0;
    handleLine(line);
    if (protocolFailed) return;
    offset = newline + 1;
  }
}

// ---------------------------------------------------------------- run state

let generation = 0;
let lastAssistant = null; // { generation, text }
let activeRun = false;
let settling = false;
let settlingHandled = false;
let settledSeen = false;
let steerInFlight = false;
let turns = 0;
let deniedDialogs = 0;
let pending = null;       // { code, reason } set by abort, timeout, turn limit
let finalizing = false;
let finalized = false;

function recordDialog(method) {
  deniedDialogs += 1;
  try { atomic('dialogs.json', JSON.stringify({ count: deniedDialogs, lastMethod: method }) + '\n'); }
  catch (error) { note(`could not write dialogs.json: ${error.message}`); }
}

function extractText(message) {
  if (!message || message.role !== 'assistant') return undefined;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('');
}

function capText(text, cap) {
  if (Buffer.byteLength(text, 'utf8') <= cap) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= cap) low = mid; else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
  return text.slice(0, low);
}

function reportText() {
  if (!lastAssistant || lastAssistant.generation !== generation) return '';
  const text = lastAssistant.text;
  if (typeof text !== 'string') return '';
  if (!text.trim()) return '';
  if (Buffer.byteLength(text, 'utf8') <= REPORT_CAP) return text;
  return `${capText(text, REPORT_CAP - 64)}\n\n[report truncated at 2 MiB]`;
}

// ------------------------------------------------------------------ steering

function steerFiles() {
  let names;
  try { names = readdirSync(file('steer')); } catch { return []; }
  const items = [];
  for (const name of names) {
    const match = /^(\d{4,})\.json$/.exec(name);
    if (!match) continue;
    const sequence = Number(match[1]);
    if (exists(`steer/${match[1]}.ack`)) continue;
    try {
      const data = readJson(`steer/${name}`);
      if (typeof data?.message !== 'string' || !data.message) continue;
      items.push({ sequence, message: data.message });
    } catch { continue; }
  }
  return items.sort((a, b) => a.sequence - b.sequence);
}

function acknowledge(sequence, disposition) {
  const name = `steer/${String(sequence).padStart(4, '0')}.ack`;
  try { atomic(name, JSON.stringify({ disposition, at: new Date().toISOString() }) + '\n'); }
  catch (error) { note(`steer ack failed: ${error.message}`); }
}

const forcePrompt = new Set();

async function forwardSteers(items) {
  if (steerInFlight) return;
  steerInFlight = true;
  try {
  for (const item of items) {
    if (finalizing) return;
    const usePrompt = forcePrompt.has(item.sequence) || !activeRun;
    const message = `${STEER_HEADER}${item.message}`;
    const response = usePrompt
      ? await rpc({ type: 'prompt', message })
      : await rpc({ type: 'steer', message });
    if (response.success) {
      acknowledge(item.sequence, usePrompt ? 'started' : 'queued');
      forcePrompt.delete(item.sequence);
      continue;
    }
    if (response.timedOut) { protocolFailure('steer response timed out'); return; }
    if (!usePrompt) forcePrompt.add(item.sequence);
    note(`steer command rejected; leaving it for the next poll: ${response.error ?? 'unknown'}`);
  }
  } finally { steerInFlight = false; }
}

// ----------------------------------------------------------------- finalize

async function finalize(code) {
  if (finalized) return;
  finalized = true;
  finalizing = true;
  let finalCode = parentGone ? 131 : code.code;
  let finalReason = parentGone ? 'parent_gone' : code.reason;
  note(`finalizing code=${finalCode} reason=${finalReason ?? 'none'}`);

  const text = reportText();
  if (text) {
    try {
      atomic('report.md', text);
      note(`report written: ${Buffer.byteLength(text, 'utf8')} bytes`);
    } catch (error) {
      note(`report write failed: ${error.message}`);
      if (!parentGone) { finalCode = 74; finalReason = undefined; }
    }
  } else if (finalCode === 0) {
    finalCode = 3;
  }

  writeReason(finalReason);
  const wrote = writeCode(finalCode);
  if (wrote) note(`exit.code ${finalCode}`);

  if (workerPid) {
    try { worker?.stdin?.end(); } catch {}
    await waitWorkerExit(protocolFailed ? PROTOCOL_EXIT_GRACE_MS : 10000);
    killWorkerGroup();
  }
  process.exit(finalCode);
}

function requestAbort(code) {
  if (finalized || finalizing) return;
  if (settling) return; // timeout suspended, cancel refused while settling
  if (pending) return;
  pending = code;
  note(`abort requested code=${code.code}`);
  void (async () => {
    const response = await rpc({ type: 'abort' }, 2000);
    if (!response.success) note(`abort response: ${response.timedOut ? 'timeout' : response.error ?? 'rejected'}`);
    await finalize(pending);
  })();
}

// ------------------------------------------------------------ event handling

async function onSettled(message) {
  settledSeen = true;
  if (settlingHandled) return;
  settlingHandled = true;
  if (pending) { await finalize(pending); return; }
  if (message.aborted === true) { await finalize({ code: 4, reason: 'aborted' }); return; }
  if (parentGone) { await finalize({ code: 131, reason: 'parent_gone' }); return; }

  settling = true;
  setSettling();
  suspendTimeout();
  await sleep(500);

  let items = steerFiles();
  if (parentGone) { await finalize({ code: 131 }); return; }
  if (!items.length) {
    await sleep(500);
    items = steerFiles();
    if (parentGone) { await finalize({ code: 131 }); return; }
  }

  if (items.length) {
    const message = `${STEER_HEADER}${items.map(item => item.message).join('\n\n')}`;
    const response = await rpc({ type: 'prompt', message });
    if (!response.success || response.data?.disposition === 'handled') {
      note(`final steer prompt failed: ${response.error ?? response.data?.disposition ?? 'unknown'}`);
      await finalize({ code: 4 });
      return;
    }
    for (const item of items) acknowledge(item.sequence, 'started');
    note(`revived by ${items.length} final steer(s)`);
    clearSettling();
    settling = false;
    settlingHandled = false;
    resumeTimeout();
    return;
  }

  for (const item of steerFiles()) acknowledge(item.sequence, 'settled');
  await finalize({ code: 0 });
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'response') {
    const handler = message.id ? inflight.get(message.id) : undefined;
    if (handler) { inflight.delete(message.id); handler(message); }
    return;
  }
  if (message.type === 'extension_ui_request') {
    if (DIALOG_METHODS.has(message.method)) {
      recordDialog(message.method);
      note(`dialog cancelled: ${message.method} ${typeof message.title === 'string' ? message.title : ''}`.trim());
      writeLine(`${JSON.stringify({ type: 'extension_ui_response', id: message.id, cancelled: true })}\n`)
        .catch(error => note(`dialog response failed: ${error.message}`));
    }
    return;
  }
  switch (message.type) {
    case 'agent_start':
      generation += 1;
      activeRun = true;
      lastAssistant = null;
      break;
    case 'agent_end':
      activeRun = false;
      break;
    case 'message_end': {
      const text = extractText(message.message);
      if (text !== undefined) lastAssistant = { generation, text };
      break;
    }
    case 'turn_end':
      turns += 1;
      if (turns >= task.maxTurns && !pending) requestAbort({ code: 5 });
      break;
    case 'agent_settled':
      activeRun = false;
      void onSettled(message);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------- timeout timers

let timeoutTimer;
let remainingMs = task.timeoutSeconds * 1000;
let timeoutStartedAt = 0;

function startTimeout() {
  timeoutStartedAt = performance.now();
  timeoutTimer = setTimeout(() => {
    if (!finalizing && !settling) requestAbort({ code: 124 });
  }, remainingMs);
  timeoutTimer.unref?.();
}
function suspendTimeout() {
  if (!timeoutTimer) return;
  clearTimeout(timeoutTimer);
  timeoutTimer = undefined;
  remainingMs = Math.max(0, remainingMs - (performance.now() - timeoutStartedAt));
}
function resumeTimeout() {
  if (settling || finalizing) return;
  startTimeout();
}

// ------------------------------------------------------------- worker launch

function spawnWorker() {
  worker = spawn(argv[0], argv.slice(1), {
    cwd: task.cwd,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_SUBAGENTS_WORKER: '1' },
  });
  workerPid = worker.pid ?? 0;
  worker.on('error', error => {
    note(`worker spawn error: ${error.message}`);
    void finalize({ code: 4, reason: 'spawn_error' });
  });
  worker.on('exit', (code, signal) => {
    workerExited = true;
    note(`worker exited code=${code} signal=${signal ?? ''}`.trimEnd());
    if (!finalizing && !finalized && !settledSeen) void finalize(pending ?? { code: 4 });
  });
  worker.stderr?.on('data', chunk => childLog.write(chunk));
  worker.stdout?.on('data', drainStdout);
  worker.stdout?.on('end', () => {
    if (!finalizing && !finalized && !settledSeen) protocolFailure('stdout ended before agent_settled');
  });
}

async function readWorkerStart() {
  for (let attempt = 0; attempt < 40 && workerPid; attempt++) {
    const stat = procStat(workerPid);
    if (stat) { workerStart = stat.startTicks; return; }
    await sleep(5);
  }
}

async function readyHandshake() {
  await readWorkerStart();
  const payload = {
    supervisorPid: process.pid,
    supervisorPgid: procStat(process.pid)?.pgrp ?? process.pid,
    workerPid,
    workerPgid: workerPid,
    workerStartTicks: workerStart,
    startedAt: new Date().toISOString(),
  };
  try { atomic('supervisor.ready', `${JSON.stringify(payload)}\n`); }
  catch (error) {
    note(`could not write supervisor.ready: ${error.message}`);
    killWorkerGroup();
    writeCode(74);
    process.exit(74);
  }
}

// ------------------------------------------------------------------ shutdown

process.on('SIGTERM', () => {
  if (exists('settling')) { note('SIGTERM ignored while settling'); return; }
  if (pending || finalizing) return;
  requestAbort({ code: 130 });
});
process.on('SIGINT', () => {
  if (exists('settling')) { note('SIGINT ignored while settling'); return; }
  if (pending || finalizing) return;
  requestAbort({ code: 130 });
});
process.on('uncaughtException', error => {
  note(`uncaught: ${error?.stack ?? error}`);
  if (!finalized) void finalize({ code: 4 });
});
process.on('unhandledRejection', error => {
  note(`unhandled rejection: ${error?.stack ?? error}`);
});

// Parent watchdog: independent of the RPC loop.
const parentTimer = setInterval(() => {
  if (parentGone) return;
  if (!existsSync(`/proc/${parentPid}`)) return onParentGone();
  const stat = procStat(parentPid);
  if (!stat || stat.state === 'Z' || stat.startTicks !== parentStart) onParentGone();
}, 500);
parentTimer.unref?.();

function onParentGone() {
  if (parentGone) return;
  parentGone = true;
  note(`parent ${parentPid} gone`);
  if (finalizing) { pending = { code: 131, reason: 'parent_gone' }; return; }
  killWorkerGroup();
  void finalize({ code: 131, reason: 'parent_gone' });
}

// Run-directory watchdog: nothing can be recorded once it disappears.
const runDirTimer = setInterval(() => {
  if (!existsSync(runDir)) {
    note('run directory disappeared');
    killWorkerGroup();
    process.exit(6);
  }
}, 500);
runDirTimer.unref?.();

// Steer poll: forwards queued messages while the worker is live.
const steerTimer = setInterval(() => {
  if (settling || finalizing || finalized) return;
  const items = steerFiles();
  if (items.length) void forwardSteers(items);
}, 500);
steerTimer.unref?.();

// ---------------------------------------------------------------------- start

spawnWorker();
if (!workerPid) {
  note('worker did not start');
  await finalize({ code: 4, reason: 'spawn_error' });
}
await readyHandshake();
startTimeout();
note(`worker started pid=${workerPid} pgid=${workerPid} ticks=${workerStart}`);

try {
  const brief = readFileSync(file('brief.md'), 'utf8');
  const response = await rpc({ type: 'prompt', message: brief });
  if (!response.success || response.data?.disposition === 'handled') {
    note(`initial prompt failed: ${response.error ?? response.data?.disposition ?? 'unknown'}`);
    await finalize({ code: 4 });
  } else {
    note(`initial prompt ${response.data?.disposition ?? 'accepted'}`);
  }
} catch (error) {
  note(`brief read failed: ${error.message}`);
  await finalize({ code: 4 });
}
