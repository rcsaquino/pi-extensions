import { performance } from 'node:perf_hooks';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Collector } from '../lib/collector.mjs';
import { WriterClient } from '../lib/client.mjs';

const base = resolve('.bench'); mkdirSync(base,{recursive:true});
const dir = mkdtempSync(join(base,'run-')), instance = randomUUID();
const writer = new WriterClient(join(dir,'analytics.sqlite'),instance);
const collector = new Collector(record => writer.enqueue(record),{instanceId:instance});
try {
  await writer.flush();
  collector.configure({session_id:'benchmark-session'}); collector.input('rpc'); collector.agentStart();
  collector.messageStart({role:'assistant',provider:'fixture',model:'fixture'}); collector.providerRequest();
  const delta = {type:'text_delta',contentIndex:0};
  for (let i=0;i<20000;i++) collector.stream(delta);
  const samples = [], count = 200000;
  const started = performance.now();
  for (let i=0;i<count;i++) {
    const t = performance.now(); collector.stream(delta); samples.push(performance.now()-t);
  }
  const elapsed = performance.now()-started;
  samples.sort((a,b)=>a-b);
  collector.messageEnd({role:'assistant',provider:'fixture',model:'fixture',stopReason:'stop',usage:{input:1,output:1,totalTokens:2}});
  collector.finish();
  const status = await writer.query({action:'status'});
  console.log(JSON.stringify({
    node:process.version, events_measured:count,
    streaming_handler_mean_us:elapsed/count*1000,
    streaming_handler_p50_us:samples[Math.floor(count*.5)]*1000,
    streaming_handler_p99_us:samples[Math.floor(count*.99)]*1000,
    persisted_rows:status.traces+status.spans+status.events,
    dropped_records:writer.health().dropped_records,
    scope:'Synthetic normalized-event observer with real background SQLite writer; not an end-to-end live latency benchmark. Measurement includes timer/sample overhead.',
  },null,2));
} finally { await writer.close(); rmSync(dir,{recursive:true,force:true}); }
