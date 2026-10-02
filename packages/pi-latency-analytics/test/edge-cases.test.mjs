import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AnalyticsDatabase, APPLICATION_ID } from '../lib/database.mjs';
import { Collector } from '../lib/collector.mjs';
import { WriterClient } from '../lib/client.mjs';
import latencyAnalytics from '../index.ts';

const root = resolve('test/.tmp'); mkdirSync(root,{recursive:true});
function directory(t) { const dir = mkdtempSync(join(root,'edge-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); return dir; }

test('context starts model timing before HTTP headers and assistant message_start', () => {
  let mono = 0; const records=[];
  const c=new Collector(r=>records.push(r),{clock:()=>({mono,wall:10000+mono})});
  c.agentStart(); c.context(); mono=20; c.providerRequest(); mono=25; c.providerHeaders();
  mono=30; c.providerResponse(503); mono=40; c.providerRequest(); mono=50; c.providerHeaders();
  mono=100; c.providerResponse(200); mono=120; c.messageStart({role:'assistant'});
  c.stream({type:'text_delta',contentIndex:0}); c.messageEnd({role:'assistant',stopReason:'stop'}); c.finish();
  const model=records.filter(r=>r.op==='span' && r.value.kind==='model').at(-1).value;
  assert.equal(model.duration_ms,120); assert.equal(model.meta.first_output_ms,100);
  assert.equal(model.meta.http_header_attempts,2); assert.deepEqual(model.meta.http_statuses,[503,200]);
  assert.equal(records.filter(r=>r.op==='span' && r.value.kind==='model' && r.value.status==='completed').length,1);
});

test('overlapping untagged HTTP boundaries flag ambiguity instead of claiming clean attribution', () => {
  const records=[], c=new Collector(r=>records.push(r));
  c.agentStart(); c.context(); c.providerHeaders(); c.providerHeaders(); c.providerResponse(200);
  c.messageEnd({role:'assistant',stopReason:'stop'}); c.finish();
  assert.equal(records.filter(r=>r.op==='trace').at(-1).value.complete,false);
  assert.ok(records.some(r=>r.op==='event' && r.value.name==='ambiguous_provider_attempt'));
});

test('an unrelated existing SQLite database is not modified', t => {
  const path=join(directory(t),'analytics.sqlite'), foreign=new DatabaseSync(path);
  foreign.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(\'preserved\')'); foreign.close();
  const before=readFileSync(path);
  assert.throws(()=>new AnalyticsDatabase(path,randomUUID()),/unrecognized_database/);
  assert.deepEqual(readFileSync(path),before);
});

test('a newer owned schema is refused without downgrade', t => {
  const path=join(directory(t),'analytics.sqlite'), future=new DatabaseSync(path);
  future.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=99`); future.close();
  assert.throws(()=>new AnalyticsDatabase(path,randomUUID()),/newer_schema/);
  const reader=new DatabaseSync(path); assert.equal(reader.prepare('PRAGMA user_version').get().user_version,99); reader.close();
});

test('worker death stops collection without blocking subsequent observation', async t => {
  const writer=new WriterClient(join(directory(t),'analytics.sqlite'),randomUUID());
  await writer.flush(); await writer.worker.terminate();
  assert.equal(writer.health().state,'failed');
  assert.equal(writer.enqueue({op:'event',value:{trace_id:'fixture'}}),false);
  await assert.rejects(writer.query({action:'last'}),/analytics_unavailable/);
  try { await writer.close(); } catch {}
});

test('status remains readable when database initialization fails', async t => {
  const dir=directory(t), file=join(dir,'obstruction'); writeFileSync(file,'fixture');
  const previous=process.env.PI_LATENCY_DIR; process.env.PI_LATENCY_DIR=file;
  const events=new Map(); let tool;
  latencyAnalytics({on:(name,fn)=>events.set(name,fn),registerTool:value=>{tool=value},registerCommand:()=>{}});
  const ctx={sessionManager:{getSessionId:()=> 'status-fixture',getLeafId:()=>null}};
  try {
    events.get('session_start')({},ctx);
    const result=JSON.parse((await tool.execute('status',{action:'status'},undefined,undefined,ctx)).content[0].text);
    assert.equal(result.storage,'unavailable'); assert.equal(result.collector.state,'failed');
  } finally {
    await events.get('session_shutdown')({},ctx);
    if(previous===undefined) delete process.env.PI_LATENCY_DIR; else process.env.PI_LATENCY_DIR=previous;
  }
});
