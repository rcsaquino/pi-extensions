import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';

test('loads and observes an actual Pi SDK session with a synthetic stream and zero network calls', async () => {
  const base = resolve('test/.tmp'); mkdirSync(base,{recursive:true});
  const dir = mkdtempSync(join(base,'sdk-'));
  const oldDir = process.env.PI_LATENCY_DIR, oldFetch = globalThis.fetch;
  process.env.PI_LATENCY_DIR = join(dir,'analytics');
  let fetchCalls = 0, streamCalls = 0, session;
  globalThis.fetch = () => { fetchCalls++; throw new Error('network forbidden in offline fixture'); };
  const errors = [];
  try {
    const cwd = resolve('.'), agentDir = join(dir,'agent'); mkdirSync(agentDir,{recursive:true});
    const settings = SettingsManager.inMemory({cacheWarming:'off',compaction:{enabled:false},retry:{enabled:false}});
    const resources = new DefaultResourceLoader({
      cwd,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,
      additionalExtensionPaths:[join(cwd,'index.ts')],
      extensionFactories:[pi=>{
        const parameters = Type.Object({text:Type.String()});
        pi.registerTool({name:'fixture_child',label:'Fixture child',description:'Offline fixture',parameters,
          execute:async()=>({content:[{type:'text',text:'SYNTHETIC_PRIVATE_BODY'}],details:{}})});
        pi.registerTool({name:'fixture_parent',label:'Fixture parent',description:'Offline fixture',parameters,
          execute:async(_id,params,_signal,_update,ctx)=>ctx.executeTool('fixture_child',{text:params.text})});
      }],
    });
    await resources.reload();
    assert.equal(resources.getExtensions().errors.length,0);
    const modelRuntime = await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),modelsStorePath:join(agentDir,'catalog.json'),refreshOnCreate:false,allowModelNetwork:false});
    await modelRuntime.setRuntimeApiKey('openai','OFFLINE_FIXTURE_NOT_A_CREDENTIAL');
    ({session} = await createAgentSession({
      cwd,agentDir,resourceLoader:resources,settingsManager:settings,modelRuntime,
      sessionManager:SessionManager.inMemory(cwd),noTools:'builtin',
      model:{id:'offline-fixture',name:'Offline fixture',provider:'openai',api:'openai-responses',baseUrl:'https://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:256},
    }));
    await session.bindExtensions({onError:error=>errors.push(error)});
    session.agent.streamFunction = () => {
      streamCalls++;
      const stream = createAssistantMessageEventStream();
      const toolTurn = streamCalls === 1;
      const content = toolTurn ? [{type:'toolCall',id:'fixture-call',name:'fixture_parent',arguments:{text:'SYNTHETIC_PRIVATE_BODY'}}] : [{type:'text',text:'SYNTHETIC_PRIVATE_BODY'}];
      const reason = toolTurn ? 'toolUse' : 'stop';
      const message = {role:'assistant',content,api:'openai-responses',provider:'openai',model:'offline-fixture',timestamp:Date.now(),stopReason:reason,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(async () => {
        const runner = session.extensionRunner;
        await runner.emitBeforeProviderRequest({private:'SYNTHETIC_PRIVATE_BODY'});
        await runner.emitBeforeProviderHeaders({Authorization:'SYNTHETIC_PRIVATE_BODY'});
        await runner.emit({type:'after_provider_response',status:200,headers:{private:'SYNTHETIC_PRIVATE_BODY'}});
        stream.push({type:'start',partial:message});
        stream.push({type:toolTurn ? 'toolcall_delta' : 'text_delta',contentIndex:0,delta:'SYNTHETIC_PRIVATE_BODY',partial:message});
        stream.push({type:'done',reason,message}); stream.end();
      });
      return stream;
    };
    await session.prompt('SYNTHETIC_PRIVATE_BODY');
    const tool = session.agent.state.tools.find(tool=>tool.name==='latency_query');
    assert.ok(tool,'extension query tool is active');
    const result = await tool.execute('offline-query',{action:'last'},undefined);
    const traces = JSON.parse(result.content[0].text);
    assert.equal(traces.length,1); assert.equal(traces[0].status,'completed');
    assert.equal(traces[0].model_requests.length,2); assert.equal(traces[0].complete,true);
    assert.ok(traces[0].tools.some(tool=>tool.name==='fixture_child'));
    const details = JSON.parse((await tool.execute('offline-details',{action:'trace',trace_id:traces[0].trace_id},undefined)).content[0].text);
    const child = details[0].spans.find(span=>span.kind==='tool' && span.name==='fixture_child');
    assert.ok(child.parent_span_id,'actual SDK nested-tool relationship is recorded');
    assert.equal(traces[0].model_requests[0].first_output_ms, null);
    assert.ok(traces[0].model_requests[0].first_output_context_ms !== null);
    assert.equal(traces[0].model_requests[0].provider_hook_attribution, 'unknown_no_request_id');
    assert.ok(details[0].events.some(event=>event.name==='unattributed_provider_headers'));
    assert.equal(traces[0].assistant_entry_id,session.sessionManager.getLeafId());
    assert.equal(errors.length,0); assert.equal(fetchCalls,0); assert.equal(streamCalls,2);
    await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});
    assert.ok(!readFileSync(join(dir,'analytics','analytics.sqlite')).includes(Buffer.from('SYNTHETIC_PRIVATE_BODY')));
  } finally {
    if (session) { await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'}); session.dispose(); }
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.PI_LATENCY_DIR; else process.env.PI_LATENCY_DIR = oldDir;
    rmSync(dir,{recursive:true,force:true});
  }
});
