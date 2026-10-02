import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeStore, routeTtl } from '../src/route-store.mjs';
import { logStore, readLogRecords } from '../src/log-store.mjs';
import { testBudget } from '../src/test-budget.mjs';
import { writeJson } from '../src/local-state.mjs';
import { startRouter } from '../src/proxy.mjs';
import { statusSnapshot } from '../src/dashboard.mjs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const baseline={model:'gpt-6-sol',effort:'high'}, pair={model:'gpt-6-luna',effort:'low'};
function fixture() { const root=mkdtempSync(join(tmpdir(),'router-reliability-'));return {root,close:()=>rmSync(root,{recursive:true,force:true})}; }
test('route recovery validates baseline/catalog/expiry, caps entries, and survives corrupt or unwritable files',()=>{
  const f=fixture(),path=join(f.root,'routes.json');let clock=100000;
  try {
    const store=routeStore(path,baseline,[pair],()=>clock);store.set('thread','turn',{...pair,reason:'bounded_simple_task'});
    assert.deepEqual(routeStore(path,baseline,[pair],()=>clock).get('thread','turn'),{...pair,reason:'bounded_simple_task'});
    assert.equal(routeStore(path,{...baseline,effort:'low'},[pair],()=>clock).get('thread','turn'),null);
    assert.equal(routeStore(path,baseline,[],()=>clock).get('thread','turn'),null);
    clock+=routeTtl;assert.equal(store.get('thread','turn'),null);
    for(let n=0;n<1002;n++)store.set('thread','turn'+n,{...pair,reason:'same_turn'});
    assert.equal(JSON.parse(readFileSync(path)).entries.length,1000);
    writeFileSync(path,'{');assert.equal(routeStore(path,baseline,[pair]).status().state,'unavailable');
    const unavailable=routeStore(join(f.root,'absent','routes.json'),baseline,[pair]);unavailable.set('thread','turn',{...pair,reason:'same_turn'});
    assert.equal(unavailable.status().state,'unavailable');assert.deepEqual(unavailable.get('thread','turn'),{...pair,reason:'same_turn'});
  } finally {f.close();}
});

test('log rotation waits for idle, preserves original, bounds archives and reads across boundaries',()=>{
  const f=fixture(),path=join(f.root,'events.jsonl');let active=1;
  try {
    const logger=logStore(path,()=>active,80);logger.append({id:1,event:'request',padding:'x'.repeat(80)});
    logger.rotate();assert.equal(existsSync(path+'.1'),false);active=0;logger.rotate();
    assert.equal(existsSync(path+'.pre-031'),true);
    logger.append({id:1,event:'finished'});
    assert.deepEqual(readLogRecords(path).records.map(r=>r.event),['request','finished']);
    assert.equal(readLogRecords(path,20).truncated,true);
    for(let n=2;n<7;n++){logger.append({id:n,padding:'x'.repeat(80)});logger.rotate();}
    assert.equal(existsSync(path+'.3'),true);assert.equal(existsSync(path+'.4'),false);
    assert.equal(JSON.parse(readFileSync(path+'.pre-031','utf8').trim()).id,1);
  } finally {f.close();}
});

test('test budget deduplicates, includes auxiliary/child/unknown, excludes proven other roots and blocks only registered tests',()=>{
  const f=fixture(),sessionPath=join(f.root,'session.json'),ledgerPath=join(f.root,'ledger.json');
  try {
    writeJson(sessionPath,{version:1,id:'batch',budget:4,testThreadIds:['main'],windows:[{startedAt:'2026-09-27T00:00:00Z',endedAt:'2026-09-27T00:01:00Z'}]});
    writeJson(ledgerPath,{version:1,sessionId:'batch',entries:[]});
    const meter=testBudget(sessionPath,ledgerPath);
    meter.snapshot({threads:{child:{taskRole:'child',rootThreadId:'main'},other:{taskRole:'main',rootThreadId:'other'}}});
    const reserve=(n,threadId,at='2026-09-27T00:00:10Z')=>meter.reserve({key:'r:'+n,at,threadId,turnId:null});
    assert.equal(reserve(1,'main').allowed,true);reserve(1,'main');reserve(2,'child');reserve(3,'unknown');reserve(4,'other');reserve(5,'main');
    assert.equal(meter.snapshot().used,4);assert.equal(meter.snapshot().counts.other_independent,1);
    assert.equal(reserve(6,'main').allowed,false);assert.equal(reserve(7,'other').allowed,true);
    assert.equal(reserve(8,'unknown','2026-09-27T00:02:00Z').allowed,true);assert.equal(meter.snapshot().used,4);
    writeFileSync(ledgerPath,'{');assert.equal(reserve(9,'main').allowed,false);assert.equal(reserve(10,'other').allowed,true);
  } finally {f.close();}
});

test('real proxy restarts preserve turn routing without bypassing effort protection; missing recovery stays explicit',async()=>{
  const f=fixture(),logPath=join(f.root,'events.jsonl');let router;
  const create=()=>startRouter({port:0,logPath,baseline,availablePairs:[baseline,pair],fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);return new Response(`event: response.completed\ndata: ${JSON.stringify({response:{model:body.model,reasoning:body.reasoning}})}\n\n`);
  }});
  const send=async(turn,input,extras={})=>{const result=await fetch(`http://127.0.0.1:${router.port}/responses`,{method:'POST',headers:{'user-agent':'Codex Desktop/1',originator:'Codex Desktop','thread-id':'main','x-codex-turn-metadata':JSON.stringify({request_kind:'turn',turn_id:turn})},body:JSON.stringify({model:baseline.model,reasoning:{effort:baseline.effort},input,...extras})});await result.text();};
  try {
    router=await create();await send('t1',[{role:'user',content:'请将你好翻译成英文'}]);await router.close();router=await create();
    await send('t1',[{type:'function_call_output',output:'SECRET_TOOL'}]);
    await send('t1',[{type:'configuration_update'},{type:'function_call_output',output:'SECRET_TOOL'}]);
    await send('missing',[{type:'function_call_output',output:'SECRET_TOOL'}]);
    const records=readLogRecords(logPath).records.filter(r=>r.event==='request');
    assert.deepEqual(records[1].after,pair);assert.equal(records[1].reason,'same_turn');
    assert.deepEqual(records[2].after,baseline);assert.equal(records[2].reason,'configuration_update');
    assert.equal(records[3].reason,'same_turn_route_missing');assert.deepEqual(records[3].after,baseline);
    assert.doesNotMatch(readFileSync(join(f.root,'routes.json'),'utf8'),/SECRET_TOOL|你好/);
  } finally {await router?.close();f.close();}
});

test('auxiliary records retain evidence without becoming a final turn; delayed native metadata can later confirm',()=>{
  const f=fixture(),logPath=join(f.root,'events.jsonl');
  const records=[{event:'request',id:1,at:'2026-09-27T00:00:00Z',runId:'r',path:'/responses',threadId:'main',turnId:'t',client:'desktop',before:pair,after:pair,effortUpdate:false},
    {event:'finished',id:1,runId:'r',status:200,completedEvent:true,completedModel:pair.model,completedEffort:pair.effort,outputItems:[{id:'msg',role:'assistant',phase:'final_answer'}]},
    {event:'request',id:2,at:'2026-09-27T00:00:01Z',runId:'r',path:'/responses',threadId:'main',turnId:null,client:'desktop',before:baseline,after:baseline}];
  const metadata={state:'ready',threads:{main:{taskRole:'main',rootThreadId:'main',displayName:'Visible'}},turns:{}};
  try {
    writeFileSync(logPath,records.map(JSON.stringify).join('\n'));
    const snapshot=()=>statusSnapshot({logPath,catalog:[pair],metadata});
    assert.equal(snapshot().turns[0].isAuxiliary,true);assert.equal(snapshot().turns[0].requests[0].requestClass,'auxiliary_unattributed');
    assert.equal(snapshot().turns[1].finalReply.status,'unconfirmed');
    metadata.turns['main:t']={status:'completed',finalItemId:'msg',finalPhase:'final_answer'};
    assert.equal(snapshot().turns[1].finalReply.status,'confirmed');assert.equal(snapshot().turns[0].finalReply.status,'unconfirmed');
  } finally {f.close();}
});

test('test budget rejects upstream calls after the cap including auxiliary, while unrelated traffic passes unchanged',async()=>{
  const f=fixture(),session=join(f.root,'test-session.json'),ledger=join(f.root,'test-ledger.json');let router,calls=0;
  try {
    writeJson(session,{version:1,id:'batch',budget:1,testThreadIds:['main'],windows:[{startedAt:new Date().toISOString(),endedAt:null}]});
    writeJson(ledger,{version:1,sessionId:'batch',entries:[]});
    router=await startRouter({port:0,logPath:join(f.root,'events.jsonl'),availablePairs:[baseline,pair],fetchImpl:async()=>{calls++;return new Response('done');}});
    const send=async(thread)=>{const r=await fetch(`http://127.0.0.1:${router.port}/responses`,{method:'POST',headers:{'user-agent':'Codex Desktop/1',originator:'Codex Desktop','thread-id':thread},body:JSON.stringify({model:baseline.model,reasoning:{effort:'high'},input:[]})});await r.text();return r.status;};
    assert.equal(await send('main'),200);assert.equal(await send('main'),429);assert.equal(calls,1);
    assert.equal(await send('unrelated'),200);assert.equal(calls,2);
    const status=await (await fetch(`http://127.0.0.1:${router.port}/api/status`)).json();assert.equal(status.testBudget.used,2);
    assert.equal(status.activeRequests,0);assert.equal(readLogRecords(join(f.root,'events.jsonl')).records.filter(r=>r.event==='budget_blocked').length,1);
  } finally {await router?.close();f.close();}
});

test('complete evidence survives archive rotation and the dashboard fifty-turn limit',()=>{
  const f=fixture(),logPath=join(f.root,'events.jsonl');
  try {
    const rows=Array.from({length:60},(_,id)=>({event:'request',runId:'r',id,at:new Date(1750000000000+id*1000).toISOString(),path:'/responses',turnId:'turn-'+id,threadId:'main',before:pair,after:pair}));
    writeFileSync(logPath+'.1',rows.slice(0,30).map(JSON.stringify).join('\n')+'\n');
    writeFileSync(logPath,rows.slice(30).map(JSON.stringify).join('\n')+'\n');
    const visible=statusSnapshot({logPath,catalog:[pair]});assert.equal(visible.turns.length,50);assert.equal(visible.history.truncated,true);
    const all=readLogRecords(logPath);assert.equal(all.records.length,60);
    assert.equal(statusSnapshot({logPath,catalog:[pair],records:all.records,turnLimit:Infinity}).turns.length,60);
  } finally {f.close();}
});

test('evidence exporter reads archives, keeps missing-log budget entries and never exports secret fields',async()=>{
  const f=fixture();const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({runId:'r',availablePairs:[pair]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const session={version:1,id:'batch',budget:3,startedAt:'2026-09-27T00:00:00Z',testThreadIds:['main'],windows:[{startedAt:'2026-09-27T00:00:00Z',endedAt:null}]};
    const entry={key:'r:1',at:'2026-09-27T00:00:01Z',threadId:'main',turnId:'t'};
    writeJson(join(f.root,'state.json'),{port:server.address().port,baseline});writeJson(join(f.root,'test-session.json'),session);
    writeJson(join(f.root,'test-ledger.json'),{version:1,sessionId:'batch',entries:[entry,{...entry,key:'r:2'}]});
    writeFileSync(join(f.root,'events.jsonl.1'),JSON.stringify({...entry,runId:'r',id:1,event:'request',path:'/responses',before:baseline,after:pair,secret:'DO_NOT_EXPORT'})+'\n');
    writeFileSync(join(f.root,'events.jsonl'),JSON.stringify({runId:'r',id:1,event:'finished',status:200,completedEvent:true,completedModel:pair.model,completedEffort:pair.effort})+'\n');
    const output=join(f.root,'evidence.json');
    await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/export-evidence.mjs',import.meta.url)),join(f.root,'test-session.json'),output],{env:{...process.env,ROUTER_INSTALL_DIR:f.root,ROUTER_METADATA_HOME:f.root}});
    const text=readFileSync(output,'utf8'),evidence=JSON.parse(text);
    assert.equal(evidence.observedRequests,1);assert.equal(evidence.conservativeObservedRequests,2);assert.equal(evidence.budgetRemaining,1);
    assert.deepEqual(evidence.missingRequestLogs,['r:2']);assert.doesNotMatch(text,/DO_NOT_EXPORT/);
    assert.equal(evidence.turns[0].finalReply.status,'unconfirmed');
  } finally {await new Promise(resolve=>server.close(resolve));f.close();}
});
