import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AnalyticsDatabase } from '../lib/database.mjs';
import { WriterClient } from '../lib/client.mjs';
import { Collector } from '../lib/collector.mjs';

const base = resolve('test/.tmp'); mkdirSync(base, { recursive: true });
function temp(t) { const dir = mkdtempSync(join(base, 'storage-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function activity(sink, instanceId, session = 'test-session', tool = 'read') {
  let ms = 0;
  const c = new Collector(sink, { instanceId, clock: () => ({ wall: 100000+ms, mono: ms }) });
  c.configure({ session_id: session }); c.input('rpc'); c.agentStart();
  c.toolStart({ toolName: tool, toolCallId: 'call-fixture', args: { secret: 'privacy-fixture-do-not-persist' } });
  ms = 10; c.toolEnd({ toolCallId: 'call-fixture', result: 'privacy-fixture-do-not-persist' }); c.finish();
  return c;
}

test('schema, restrictive database permissions, privacy, query limits, reopen preserves history', t => {
  const path = join(temp(t), 'analytics.sqlite'), instance = randomUUID();
  const db = new AnalyticsDatabase(path, instance);
  const records = []; activity(r => records.push(r), instance);
  db.batch(records);
  const last = db.query({ action: 'last', sessionId: 'test-session' });
  assert.equal(last.length, 1); assert.equal(last[0].duration_ms, 10); assert.equal(last[0].coverage, 'pi-only');
  assert.equal(db.query({ action: 'last', sessionId: 'other' }).length, 0);
  assert.equal(db.query({ action: 'last', excludeTrace: last[0].trace_id }).length, 0);
  assert.equal(db.query({ action: 'trace', traceId: "' OR 1=1 --" }).length, 0);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  db.close();
  assert.ok(!readFileSync(path).includes(Buffer.from('privacy-fixture-do-not-persist')));
  const reopened = new AnalyticsDatabase(path, randomUUID());
  assert.equal(reopened.query({ action: 'status' }).traces, 1); reopened.close();
});

test('loss flags cannot be erased by a later final-trace upsert', t => {
  const instance = randomUUID(), db = new AnalyticsDatabase(join(temp(t),'analytics.sqlite'), instance);
  t.after(() => db.close()); const records = []; activity(r => records.push(r), instance);
  db.batch(records.slice(0,1)); const traceId = records[0].value.trace_id;
  db.loss(1, [traceId]); db.batch(records.slice(1));
  assert.equal(db.query({ action: 'last' })[0].complete, false);
  assert.equal(db.query({ action: 'status' }).dropped_records, 1);
});

test('dead-process recovery does not fabricate an end timestamp', t => {
  const path = join(temp(t),'analytics.sqlite'), oldId = randomUUID();
  const old = new AnalyticsDatabase(path, oldId, 2147483647);
  const c = new Collector(r => old.batch([r]), { instanceId: oldId }); c.agentStart();
  // Simulate a hard-crashed instance by closing SQLite without marking instance ended.
  old.db.close();
  const db = new AnalyticsDatabase(path, randomUUID()); t.after(() => db.close());
  const trace = db.query({ action: 'last' })[0];
  assert.equal(trace.status, 'interrupted'); assert.equal(trace.ended_wall, null);
  assert.equal(trace.duration_ms, null); assert.equal(trace.complete, false);
});

test('another live instance is not marked interrupted', t => {
  const path = join(temp(t),'analytics.sqlite'), firstId = randomUUID();
  const first = new AnalyticsDatabase(path, firstId); const c = new Collector(r => first.batch([r]), { instanceId: firstId }); c.agentStart();
  const second = new AnalyticsDatabase(path, randomUUID());
  assert.equal(second.query({ action: 'status' }).running_traces, 1);
  second.close(); first.close();
});

test('database symlinks are refused without changing the target', t => {
  const dir = temp(t), target = join(dir,'target'); writeFileSync(target,'untouched');
  const link = join(dir,'analytics.sqlite'); symlinkSync(target,link);
  assert.throws(() => new AnalyticsDatabase(link,randomUUID()), /unsafe_database/);
  assert.equal(readFileSync(target,'utf8'),'untouched');
});

test('background writer persists, flushes on query, and closes idempotently', async t => {
  const instance = randomUUID(), writer = new WriterClient(join(temp(t),'analytics.sqlite'),instance);
  t.after(() => writer.close()); activity(r => writer.enqueue(r),instance);
  const last = await writer.query({action:'last',sessionId:'test-session'});
  assert.equal(last[0].duration_ms,10); assert.equal(last[0].complete,true);
  assert.equal(writer.health().dropped_records,0);
  await writer.close(); await writer.close();
});

test('rejected batches report loss without hanging subsequent queries', async t => {
  const writer = new WriterClient(join(temp(t),'analytics.sqlite'),randomUUID());
  t.after(() => writer.close()); activity(r => writer.enqueue(r),'nonexistent-instance');
  const status = await writer.query({action:'status'});
  assert.ok(writer.health().dropped_records > 0); assert.ok(status.dropped_records > 0);
});

test('two workers share one SQLite database without mixing sessions', async t => {
  const path = join(temp(t),'analytics.sqlite'), a = randomUUID(), b = randomUUID();
  const first = new WriterClient(path,a), second = new WriterClient(path,b);
  t.after(async () => { await first.close(); await second.close(); });
  activity(r => first.enqueue(r),a,'session-a','read');
  activity(r => second.enqueue(r),b,'session-b','bash');
  const [qa,qb] = await Promise.all([first.query({ action:'last',sessionId:'session-a' }),second.query({ action:'last',sessionId:'session-b' })]);
  assert.equal(qa[0].tools[0].name,'read'); assert.equal(qb[0].tools[0].name,'bash');
  assert.equal((await first.query({ action:'status' })).traces,2);
  assert.equal(first.health().dropped_records,0); assert.equal(second.health().dropped_records,0);
});

test('bounded buffer drops do not block callers and mark traces incomplete', async t => {
  const instance = randomUUID(), writer = new WriterClient(join(temp(t),'analytics.sqlite'),instance,{maxRecords:3,batchSize:64});
  t.after(() => writer.close()); activity(r => writer.enqueue(r),instance);
  await writer.flush(); assert.ok(writer.health().dropped_records > 0);
  const status = await writer.query({action:'status'}); assert.ok(status.dropped_records > 0);
});

test('initialization failure is isolated from collection', async t => {
  const dir = temp(t), obstruction = join(dir,'file'); writeFileSync(obstruction,'not-a-directory');
  const writer = new WriterClient(join(obstruction,'analytics.sqlite'),randomUUID());
  t.after(async () => { try { await writer.close(); } catch {} });
  await assert.rejects(writer.query({action:'status'}), /analytics_unavailable/);
  assert.equal(writer.enqueue({op:'event',value:{trace_id:'none'}}),false);
  assert.equal(writer.health().state,'failed');
});
