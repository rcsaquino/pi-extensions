import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;
export const APPLICATION_ID = 0x504c4154; // PLAT
const json = value => JSON.stringify(value ?? {});
const parse = value => JSON.parse(value || '{}');
const columns = {
  trace: ['trace_id','instance_id','session_id','anchor_entry_id','source','started_wall','started_mono','agent_started_wall','ended_wall','duration_ms','status','input_count','ambiguous_inputs','complete','assistant_entry_id','provider','model','thinking_level','coverage'],
  span: ['span_id','trace_id','parent_span_id','kind','name','started_wall','ended_wall','start_ms','end_ms','duration_ms','status','meta'],
  event: ['event_id','trace_id','name','wall_ms','offset_ms','meta'],
};

export function openDatabase(path) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error('unsafe_directory');
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('unsafe_database'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=500');
    db.exec('BEGIN');
    const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().count;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const application = db.prepare('PRAGMA application_id').get().application_id;
    db.exec('COMMIT');
    if (application !== APPLICATION_ID && (application !== 0 || tables)) throw new Error('unrecognized_database');
    if (version > SCHEMA_VERSION) throw new Error('newer_schema');
    chmodSync(path, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS instances (
      instance_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_wall REAL NOT NULL,
      ended_wall REAL, dropped_records INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(instance_id),
      session_id TEXT, anchor_entry_id TEXT, source TEXT, started_wall REAL NOT NULL,
      started_mono REAL NOT NULL, agent_started_wall REAL, ended_wall REAL, duration_ms REAL,
      status TEXT NOT NULL, input_count INTEGER NOT NULL, ambiguous_inputs INTEGER NOT NULL,
      complete INTEGER NOT NULL, assistant_entry_id TEXT, provider TEXT, model TEXT,
      thinking_level TEXT, coverage TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spans (
      span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL REFERENCES traces(trace_id),
      parent_span_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
      started_wall REAL NOT NULL, ended_wall REAL, start_ms REAL NOT NULL,
      end_ms REAL, duration_ms REAL, status TEXT NOT NULL, meta TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL REFERENCES traces(trace_id),
      name TEXT NOT NULL, wall_ms REAL NOT NULL, offset_ms REAL NOT NULL, meta TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS traces_session_time ON traces(session_id,started_wall DESC);
    CREATE INDEX IF NOT EXISTS traces_duration ON traces(duration_ms DESC);
    CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace_id,start_ms);
    CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id,offset_ms);
    PRAGMA application_id=${APPLICATION_ID};
    PRAGMA user_version=1;
    COMMIT;
    `);
    return db;
  } catch (error) { db.close(); throw error; }
}

export class AnalyticsDatabase {
  constructor(path, instanceId, pid = process.pid) {
    this.db = openDatabase(path);
    this.instanceId = instanceId;
    this.pid = pid;
    this.db.prepare('INSERT INTO instances(instance_id,pid,started_wall) VALUES(?,?,?)').run(instanceId, pid, Date.now());
    // Do not disturb another live process's trace. Dead-process ends remain unknown.
    for (const instance of this.db.prepare('SELECT instance_id,pid FROM instances WHERE ended_wall IS NULL AND instance_id<>?').all(instanceId)) {
      let dead = false;
      try { process.kill(instance.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      if (dead) {
        this.db.prepare("UPDATE traces SET status='interrupted',complete=0 WHERE instance_id=? AND status='running'").run(instance.instance_id);
        this.db.prepare('UPDATE instances SET ended_wall=? WHERE instance_id=?').run(Date.now(), instance.instance_id);
      }
    }
    this.statements = {};
    for (const [op, fields] of Object.entries(columns)) {
      const table = { trace: 'traces', span: 'spans', event: 'events' }[op];
      const key = fields[0];
      this.statements[op] = this.db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')}) ON CONFLICT(${key}) DO UPDATE SET ${fields.slice(1).map(f => op === 'trace' && f === 'complete' ? 'complete=MIN(traces.complete,excluded.complete)' : `${f}=excluded.${f}`).join(',')}`);
    }
  }

  batch(records) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { op, value } of records) {
        const fields = columns[op];
        if (!fields) throw new Error('invalid_record');
        const args = fields.map(key => key === 'meta' ? json(value[key]) : typeof value[key] === 'boolean' ? Number(value[key]) : value[key] ?? null);
        this.statements[op].run(...args);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  loss(count, traceIds) {
    this.db.prepare('UPDATE instances SET dropped_records=dropped_records+? WHERE instance_id=?').run(count, this.instanceId);
    for (const traceId of traceIds) this.db.prepare("UPDATE traces SET complete=0,status=CASE WHEN status='running' THEN 'incomplete' ELSE status END WHERE trace_id=?").run(traceId);
  }

  query({ action = 'last', sessionId = null, excludeTrace = null, traceId = null, limit = 10 } = {}) {
    const bounded = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 10));
    if (action === 'status') return {
      schema_version: SCHEMA_VERSION, coverage: 'pi-only',
      traces: this.db.prepare('SELECT COUNT(*) AS count FROM traces').get().count,
      running_traces: this.db.prepare("SELECT COUNT(*) AS count FROM traces WHERE status='running'").get().count,
      spans: this.db.prepare('SELECT COUNT(*) AS count FROM spans').get().count,
      events: this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
      dropped_records: this.db.prepare('SELECT COALESCE(SUM(dropped_records),0) AS count FROM instances').get().count,
      instances: this.db.prepare('SELECT instance_id,pid,started_wall,ended_wall,dropped_records FROM instances ORDER BY started_wall DESC LIMIT 20').all(),
    };
    const rows = action === 'trace'
      ? this.db.prepare('SELECT * FROM traces WHERE trace_id=? LIMIT 1').all(traceId)
      : this.db.prepare(`SELECT * FROM traces WHERE status<>'running' AND (? IS NULL OR session_id=?) AND (? IS NULL OR trace_id<>?) ORDER BY ${action === 'slow' ? 'duration_ms DESC' : 'started_wall DESC'} LIMIT ?`).all(sessionId, sessionId, excludeTrace, excludeTrace, action === 'last' ? 1 : bounded);
    return rows.map(trace => {
      const lost = this.db.prepare('SELECT dropped_records FROM instances WHERE instance_id=?').get(trace.instance_id).dropped_records;
      trace.recording_instance_dropped_records = lost;
      if (lost) trace.complete = 0; // Conservative: bounded loss metadata may omit a trace ID.
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM spans WHERE trace_id=?').get(trace.trace_id).count;
      const spans = this.db.prepare('SELECT * FROM spans WHERE trace_id=? ORDER BY start_ms,span_id LIMIT 5000').all(trace.trace_id).map(row => ({ ...row, meta: parse(row.meta) }));
      const result = summarize(trace, spans);
      result.span_count = count;
      result.summary_truncated = count > spans.length;
      if (result.summary_truncated) {
        result.phase_totals_ms = null; result.complete = false;
        result.caveats.push('Summary processing was truncated at 5000 spans; omitted intervals are not guessed.');
      }
      if (action === 'trace') {
        result.spans = spans.slice(0, 256);
        result.events = this.db.prepare('SELECT * FROM events WHERE trace_id=? ORDER BY offset_ms,event_id LIMIT 128').all(trace.trace_id).map(row => ({ ...row, meta: parse(row.meta) }));
        result.details_truncated = count > 256 || this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE trace_id=?').get(trace.trace_id).count > 128;
      }
      return result;
    });
  }

  close() {
    this.db.prepare('UPDATE instances SET ended_wall=? WHERE instance_id=?').run(Date.now(), this.instanceId);
    this.db.close();
  }
}

/** Exclusive elapsed-time accounting: compaction > UI wait > tools > model > preparation. */
export function summarize(trace, spans) {
  const duration = trace.duration_ms;
  const priorities = ['compaction','ui_wait','tool','model','pre_agent'];
  const points = [];
  if (duration !== null) for (const span of spans) {
    if (!priorities.includes(span.kind) || span.end_ms === null) continue;
    const a = Math.min(duration, Math.max(0, span.start_ms));
    const b = Math.min(duration, Math.max(a, span.end_ms));
    points.push([a,span.kind,1], [b,span.kind,-1]);
  }
  points.sort((a,b) => a[0] - b[0]);
  const active = Object.fromEntries(priorities.map(kind => [kind, 0]));
  const totals = { pre_agent: 0, model: 0, tool: 0, compaction: 0, ui_wait: 0, unattributed: 0 };
  let cursor = 0;
  for (const [at, kind, change] of points) {
    const category = priorities.find(key => active[key] > 0) || 'unattributed';
    totals[category] += at - cursor;
    active[kind] += change;
    cursor = at;
  }
  if (duration !== null) totals.unattributed += Math.max(0, duration - cursor);
  const tools = new Map();
  for (const span of spans.filter(s => s.kind === 'tool')) {
    const value = tools.get(span.name) || { name: span.name, calls: 0, work_ms: 0, errors: 0 };
    value.calls++;
    value.work_ms += span.duration_ms || 0;
    value.errors += span.status === 'error' ? 1 : 0;
    tools.set(span.name, value);
  }
  return {
    ...trace, complete: Boolean(trace.complete), ambiguous_inputs: Boolean(trace.ambiguous_inputs),
    phase_totals_ms: duration === null ? null : totals,
    tool_call_count: spans.filter(s => s.kind === 'tool').length,
    tool_names_truncated: tools.size > 12,
    tools: [...tools.values()].sort((a,b) => b.work_ms - a.work_ms).slice(0, 12),
    model_request_count: spans.filter(s => s.kind === 'model').length,
    model_requests_truncated: spans.filter(s => s.kind === 'model').length > 30,
    model_requests: spans.filter(s => s.kind === 'model').map(s => ({
      duration_ms: s.duration_ms, status: s.status, ...s.meta,
    })).slice(0, 30),
    caveats: [
      'Pi observation only. Telegram receipt, transport, final-send acknowledgement, and phone display are unmeasured.',
      'Model spans measure context-to-response lifecycle, not server compute. First-output timing uses normalized content events, not first network byte.',
      'Provider HTTP hooks have no request IDs; attribution is best-effort if background requests overlap.',
      'Tool work_ms can overlap and must not be added to elapsed totals.',
      ...(trace.ambiguous_inputs ? ['Multiple inputs share this logical activity; per-message attribution is ambiguous.'] : []),
      ...(!trace.complete ? ['Some boundaries or records are missing. Do not treat the breakdown as fully observed.'] : []),
    ],
  };
}
