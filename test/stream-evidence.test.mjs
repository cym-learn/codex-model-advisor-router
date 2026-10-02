import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRouter, inspectSseFrame } from '../src/proxy.mjs';
import { statusSnapshot } from '../src/dashboard.mjs';

test('cancelled stream remains unconfirmed and a subsequent request can complete', async () => {
  const home=mkdtempSync(join(tmpdir(),'router-cancel-')),logPath=join(home,'events.jsonl');
  const pair={model:'gpt-6-sol',effort:'high'};
  let calls=0;
  const router=await startRouter({port:0,logPath,availablePairs:[pair],fetchImpl:async(_url,options)=>{
    calls++;
    if(calls===1) return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"model":"gpt-6-sol","reasoning":{"effort":"high"}}}\n\n'));
      options.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')),{once:true});
    }}),{headers:{'content-type':'text/event-stream'}});
    return new Response('data: {"type":"response.completed","response":{"model":"gpt-6-sol","reasoning":{"effort":"high"}}}\n\n');
  }});
  const send=(signal)=>fetch(`http://127.0.0.1:${router.port}/responses`,{method:'POST',signal,
    headers:{'user-agent':'Codex Desktop/1',originator:'Codex Desktop','thread-id':'main','x-codex-turn-metadata':JSON.stringify({request_kind:'turn',turn_id:`turn-${calls}`})},
    body:JSON.stringify({model:pair.model,reasoning:{effort:pair.effort},input:[{role:'user',content:'任务未知'}]})});
  try {
    const controller=new AbortController();const first=await send(controller.signal);controller.abort();
    await first.text().catch(()=>{});
    let status;
    for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,10));status=statusSnapshot({logPath,catalog:[pair]});if(status.turns[0].requests[0].state==='cancelled')break;}
    assert.equal(status.turns[0].requests[0].state,'cancelled');assert.equal(status.turns[0].requests[0].verification,'unconfirmed');
    await (await send()).text();status=statusSnapshot({logPath,catalog:[pair]});
    assert.ok(status.turns.some(t=>t.requests[0].verification==='confirmed'));
  } finally {await router.close();rmSync(home,{recursive:true,force:true});}
});

test('SSE metadata includes IDs and phases but excludes message content and unknown fields', () => {
  const metadata = {};
  inspectSseFrame('data: '+JSON.stringify({type:'response.created',response:{id:'resp_a',model:'gpt-6-sol',reasoning:{effort:'high'},secret:'SECRET'}}),metadata);
  inspectSseFrame('data: '+JSON.stringify({type:'response.output_item.added',item:{type:'message',role:'assistant',id:'msg_a',phase:'commentary',content:[{text:'ANSWER_SECRET'}]}}),metadata);
  inspectSseFrame('data: '+JSON.stringify({type:'response.output_item.done',item:{type:'message',role:'assistant',id:'msg_b',phase:'final_answer',content:[{text:'ANSWER_SECRET'}]}}),metadata);
  assert.equal(metadata.responseId,'resp_a');assert.equal(metadata.outputItems[1].phase,'final_answer');
  assert.doesNotMatch(JSON.stringify(metadata),/SECRET/);
  inspectSseFrame('data: {"type":"response.failed"}',metadata);assert.equal(metadata.failedEvent,'response.failed');
});

test('chunked stream reports execution before completion and preserves exact bytes without promoting created fields', async () => {
  const home=mkdtempSync(join(tmpdir(),'router-stream-')), logPath=join(home,'events.jsonl');
  const pair={model:'gpt-6-sol',effort:'high'};
  let finish;
  const created='data: {"type":"response.created","response":{"id":"resp_a","model":"gpt-6-sol","reasoning":{"effort":"high"}}}\n\n';
  const completed='data: {"type":"response.completed","response":{"id":"resp_a","output":[{"id":"msg_final","type":"message","role":"assistant","phase":"final_answer","content":[{"text":"ANSWER_SECRET"}]}]}}\n\n';
  const router=await startRouter({port:0,logPath,availablePairs:[pair],fetchImpl:async()=>new Response(new ReadableStream({start(controller){
    const bytes=new TextEncoder().encode(created);controller.enqueue(bytes.slice(0,35));controller.enqueue(bytes.slice(35));
    finish=()=>{controller.enqueue(new TextEncoder().encode(completed));controller.close();};
  }}),{headers:{'content-type':'text/event-stream'}})});
  try {
    const response=await fetch(`http://127.0.0.1:${router.port}/responses`,{method:'POST',body:JSON.stringify({model:pair.model,reasoning:{effort:pair.effort},input:[]})});
    const streaming=statusSnapshot({logPath,catalog:[pair],runId:undefined});
    assert.equal(streaming.turns[0].requests[0].state,'executing');
    assert.equal(streaming.turns[0].requests[0].verification,'unconfirmed');
    const active = await (await fetch(`http://127.0.0.1:${router.port}/api/status`)).json();
    assert.equal(active.activeRequests,1);
    finish();assert.equal(await response.text(),created+completed);
    const ended=statusSnapshot({logPath,catalog:[pair]});
    assert.equal(ended.turns[0].requests[0].verification,'unconfirmed');
    assert.equal(ended.turns[0].requests[0].outputItems[0].id,'msg_final');
    assert.doesNotMatch(readFileSync(logPath,'utf8'),/ANSWER_SECRET/);
  } finally { await router.close();rmSync(home,{recursive:true,force:true}); }
});

test('test registry and CLI stay distinct, cancelled/incomplete and prior-run pending cannot imply completion', () => {
  const home=mkdtempSync(join(tmpdir(),'router-source-')),logPath=join(home,'events.jsonl'),registry=join(home,'test-threads.json');
  const pair={model:'gpt-6-sol',effort:'high'};
  const records=[{event:'request',at:'2026-09-26T00:00:00Z',runId:'old',id:1,path:'/responses',threadId:'main',turnId:'turn',client:'desktop',after:pair,effortUpdate:false}];
  try {
    writeFileSync(logPath,records.map(JSON.stringify).join('\n'));writeFileSync(registry,'["main"]');
    const get=()=>statusSnapshot({logPath,catalog:[pair],runId:'new',testRegistryPath:registry});
    assert.equal(get().turns[0].sourceKind,'test');assert.equal(get().turns[0].requests[0].state,'interrupted');
    records.push({event:'cancelled',runId:'old',id:1,completedEvent:false,createdModel:pair.model,createdEffort:pair.effort});
    writeFileSync(logPath,records.map(JSON.stringify).join('\n'));assert.equal(get().turns[0].requests[0].verification,'unconfirmed');
    records[0].client='cli';records[0].threadId=null;writeFileSync(logPath,records.map(JSON.stringify).join('\n'));assert.equal(get().turns[0].sourceKind,'cli');
  }finally{rmSync(home,{recursive:true,force:true});}
});
