import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import latencyAnalytics from '../index.ts';

const base = resolve('test/.tmp'); mkdirSync(base,{recursive:true});
function setup(t) {
  const dir = mkdtempSync(join(base,'extension-'));
  const previous = process.env.PI_LATENCY_DIR; process.env.PI_LATENCY_DIR = dir;
  const handlers = new Map(), tools = new Map(), commands = new Map(), notifications = [];
  const pi = {
    on: (name, fn) => handlers.set(name,fn),
    registerTool: tool => tools.set(tool.name,tool),
    registerCommand: (name,command) => commands.set(name,command),
  };
  const ctx = {
    sessionManager: { getSessionId: () => 'extension-session', getLeafId: () => 'entry-anchor' },
    model: {provider:'fixture',id:'fixture'}, thinkingLevel:'high',
    ui: {notify: (...args) => notifications.push(args)},
  };
  latencyAnalytics(pi);
  t.after(async () => {
    await handlers.get('session_shutdown')({},ctx);
    if (previous === undefined) delete process.env.PI_LATENCY_DIR; else process.env.PI_LATENCY_DIR = previous;
    rmSync(dir,{recursive:true,force:true});
  });
  return {dir,handlers,tools,commands,ctx,notifications, emit: (name,event={}) => handlers.get(name)?.(event,ctx)};
}

test('factory is side-effect-free until session_start; collection returns no event modifications', async t => {
  const h = setup(t); assert.equal(existsSync(join(h.dir,'analytics.sqlite')),false);
  assert.equal(h.tools.size,1); assert.equal(h.commands.size,1);
  assert.equal(h.emit('session_start'),undefined);
  const payload = Object.freeze({type:'before_provider_request',payload:{credential:'privacy-sentinel'}});
  assert.equal(h.emit('input',{source:'rpc',text:'privacy-sentinel'}),undefined);
  assert.equal(h.emit('before_agent_start',{prompt:'privacy-sentinel'}),undefined);
  assert.equal(h.emit('agent_start'),undefined); assert.equal(h.emit('context',{messages:[]}),undefined);
  assert.equal(h.emit('before_provider_request',payload),undefined);
  assert.equal(h.emit('before_provider_headers',Object.freeze({headers:Object.freeze({Authorization:'privacy-sentinel'})})),undefined);
  assert.equal(h.emit('after_provider_response',{status:200,headers:{secret:'privacy-sentinel'}}),undefined);
  assert.equal(h.emit('message_start',{message:{role:'assistant',provider:'fixture',model:'fixture'}}),undefined);
  assert.equal(h.emit('message_update',{assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'privacy-sentinel'}}),undefined);
  assert.equal(h.emit('message_end',{message:{role:'assistant',provider:'fixture',model:'fixture',stopReason:'stop',usage:{input:1,output:1,totalTokens:2},content:[{text:'privacy-sentinel'}]}}),undefined);
  assert.equal(h.emit('agent_end'),undefined);
  assert.equal(h.emit('agent_before_settle',{outcome:'completed'}),undefined);
  assert.equal(h.emit('agent_settled'),undefined);
  const result = await h.tools.get('latency_query').execute('q',{action:'last'},undefined,undefined,h.ctx);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.length,1); assert.equal(value[0].model_requests.length,1);
  assert.ok(!result.content[0].text.includes('privacy-sentinel'));
  assert.equal(h.notifications.length,0);
});

test('last excludes the current analytics-explanation activity', async t => {
  const h = setup(t); h.emit('session_start');
  h.emit('input',{source:'interactive'}); h.emit('agent_start'); h.emit('agent_settled');
  h.emit('input',{source:'interactive'}); h.emit('agent_start');
  const result = await h.tools.get('latency_query').execute('q',{action:'last'},undefined,undefined,h.ctx);
  assert.equal(JSON.parse(result.content[0].text).length,1);
});

test('local commands perform deterministic reports without any model invocation', async t => {
  const h = setup(t); h.emit('session_start');
  h.emit('input',{source:'interactive'}); h.emit('agent_start'); h.emit('agent_settled');
  await h.commands.get('latency').handler('',h.ctx);
  assert.ok(h.notifications[0][0].includes('Pi activity:'));
  await h.commands.get('latency').handler('status',h.ctx);
  assert.ok(h.notifications[1][0].includes('Traces: 1'));
});

test('shutdown/session replacement starts a fresh instance and preserves the database', async t => {
  const h = setup(t); h.emit('session_start'); h.emit('agent_start'); h.emit('agent_settled');
  await h.emit('session_shutdown'); h.emit('session_start'); h.emit('agent_start'); h.emit('agent_settled');
  const result = await h.tools.get('latency_query').execute('q',{action:'status'},undefined,undefined,h.ctx);
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.traces,2); assert.equal(status.instances.length,2);
  assert.equal(status.collector.state,'ready');
});

test('cancelled retrieval and missing trace IDs fail clearly', async t => {
  const h = setup(t), tool = h.tools.get('latency_query'); h.emit('session_start');
  const signal = AbortSignal.abort();
  await assert.rejects(tool.execute('q',{action:'last'},signal,undefined,h.ctx),/cancelled/);
  await assert.rejects(tool.execute('q',{action:'trace'},undefined,undefined,h.ctx),/trace_id/);
});

test('distribution has no Telegram dependency or hidden data bundled', () => {
  const manifest = JSON.parse(readFileSync('package.json','utf8'));
  assert.equal(manifest.dependencies,undefined);
  assert.deepEqual(Object.keys(manifest.peerDependencies).sort(),['@earendil-works/pi-ai','@earendil-works/pi-coding-agent']);
  assert.ok(!readFileSync('index.ts','utf8').includes('@llblab/'));
  assert.deepEqual(manifest.pi.extensions,['./index.ts']);
});
