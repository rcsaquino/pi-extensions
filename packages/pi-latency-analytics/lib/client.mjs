import { Worker } from 'node:worker_threads';

/** Bounded main-thread queue. Collection calls never await SQL or worker completion. */
export class WriterClient {
  constructor(path, instanceId, { maxRecords = 4096, batchSize = 64, flushMs = 25 } = {}) {
    this.path = path;
    this.maxRecords = maxRecords;
    this.batchSize = batchSize;
    this.flushMs = flushMs;
    this.queue = [];
    this.inflight = new Map();
    this.lossBatches = new Map();
    this.pending = new Map();
    this.id = 0;
    this.state = 'starting';
    this.dropped = 0;
    this.unreported = 0;
    this.lossTraceIds = new Set();
    this.waiters = [];
    this.timer = null;
    this.worker = new Worker(new URL('./writer.mjs', import.meta.url), {
      workerData: { path, instanceId, pid: process.pid },
    });
    this.worker.on('message', message => this.message(message));
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => { if (this.state !== 'closed') this.fail(); });
  }
  lose(records) {
    this.dropped += records.length;
    this.unreported += records.length;
    for (const record of records) {
      const traceId = record.value?.trace_id;
      if (traceId && this.lossTraceIds.size < 128) this.lossTraceIds.add(traceId);
    }
  }
  enqueue(record) {
    if (this.state === 'failed' || this.state === 'closed' || this.queue.length + [...this.inflight.values()].reduce((n,b) => n + b.length,0) >= this.maxRecords) {
      this.lose([record]);
      return false;
    }
    this.queue.push(record);
    if (this.queue.length >= this.batchSize) this.send();
    else this.schedule();
    return true;
  }
  schedule() {
    if (this.timer || this.state === 'closed' || this.state === 'failed') return;
    this.timer = setTimeout(() => { this.timer = null; this.send(); }, this.flushMs);
    this.timer.unref();
  }
  send() {
    if (this.state !== 'ready') return;
    while (this.inflight.size < 2 && (this.queue.length || this.unreported)) {
      const records = this.queue.splice(0, this.batchSize);
      const id = ++this.id;
      const loss = { count: this.unreported, traceIds: [...this.lossTraceIds] };
      this.unreported = 0;
      this.lossTraceIds.clear();
      this.inflight.set(id, records);
      this.lossBatches.set(id, loss);
      this.worker.postMessage({ type: 'batch', id, records, loss });
    }
    this.checkIdle();
  }
  message(message) {
    if (message.type === 'ready') { this.state = 'ready'; this.worker.unref(); this.send(); return; }
    if (message.type === 'failed') { this.fail(); return; }
    if (message.type === 'ack' || message.type === 'batch_failed') {
      const records = this.inflight.get(message.id) || [];
      const loss = this.lossBatches.get(message.id);
      this.inflight.delete(message.id);
      this.lossBatches.delete(message.id);
      if (message.type === 'batch_failed') {
        // If even a health-only transaction cannot persist, stop rather than spin.
        if (!records.length && loss?.count) { this.fail(); return; }
        this.unreported += loss?.count || 0;
        for (const traceId of loss?.traceIds || []) if (this.lossTraceIds.size < 128) this.lossTraceIds.add(traceId);
        this.lose(records);
      }
      this.send();
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending) {
      this.pending.delete(message.id);
      if (message.type === 'request_failed') pending.reject(new Error('analytics_query_failed'));
      else pending.resolve(message.value);
      if (!this.pending.size) this.worker.unref();
    }
  }
  fail() {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.state = 'failed';
    if (this.timer) clearTimeout(this.timer);
    this.lose(this.queue.splice(0));
    for (const records of this.inflight.values()) this.lose(records);
    this.inflight.clear();
    this.lossBatches.clear();
    for (const pending of this.pending.values()) pending.reject(new Error('analytics_unavailable'));
    this.pending.clear();
    this.checkIdle();
    this.worker.unref();
  }
  checkIdle() {
    if (this.state === 'failed' || (this.state === 'ready' && !this.queue.length && !this.inflight.size && !this.unreported)) {
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }
  async flush() {
    if (this.state === 'closed') return;
    this.send();
    if (this.state === 'failed') throw new Error('analytics_unavailable');
    if (this.state === 'ready' && !this.queue.length && !this.inflight.size && !this.unreported) return;
    this.worker.ref();
    let waiter;
    let timeout;
    try {
      await Promise.race([
        new Promise(resolve => { waiter = resolve; this.waiters.push(resolve); }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('analytics_flush_timeout')), 5000); }),
      ]);
      if (this.state === 'failed') throw new Error('analytics_unavailable');
    } finally {
      clearTimeout(timeout);
      this.waiters = this.waiters.filter(value => value !== waiter);
      if (!this.pending.size) this.worker.unref();
    }
  }
  async request(type, query) {
    if (this.state !== 'ready') throw new Error('analytics_unavailable');
    const id = ++this.id;
    this.worker.ref();
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve,reject) => {
          this.pending.set(id, { resolve, reject });
          this.worker.postMessage({ type, id, query });
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('analytics_query_timeout')), 5000); }),
      ]);
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
      if (!this.pending.size) this.worker.unref();
    }
  }
  async query(query) { await this.flush(); return this.request('query', query); }
  health() { return { state: this.state, buffered_records: this.queue.length, dropped_records: this.dropped }; }
  async close() {
    if (this.state === 'closed') return;
    try { await this.flush(); if (this.state === 'ready') await this.request('close'); }
    finally { this.state = 'closed'; if (this.timer) clearTimeout(this.timer); await this.worker.terminate(); }
  }
}
