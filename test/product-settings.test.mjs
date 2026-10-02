import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {startRouter} from '../src/proxy.mjs';
import {writeJson} from '../src/local-state.mjs';
import {initializeProductTrial} from '../src/product-trial.mjs';
const baseline={model:'gpt-6-sol',effort:'high'},chosen={model:'gpt-6-luna',effort:'medium'};
const jevReply=()=>Response.json({model:'jev-1.13-free',answers:{pair:{type:'choice',choice:'gpt-6-luna/medium'}},usage:{input_tokens:100,output_tokens:10}});
async function fixture(t,{trial=false,hold=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'product-settings-')),keyPath=join(dir,'fake-key');writeFileSync(keyPath,'PRIVATE_CREDENTIAL');
 writeJson(join(dir,'routing-policy.json'),{version:1,policyVersion:'research-v5b-r10'});
 if(trial)initializeProductTrial({configPath:join(dir,'product-trial.json'),ledgerPath:join(dir,'trial-ledger.json'),threadIds:['test-thread'],expiresAt:new Date(Date.now()+3600000).toISOString(),authorization:'Offline synthetic fixture only',allowConnectionChecks:true,outputTokenLimit:2048});
 const calls={jev:0,gpt:0,launch:0,received:[]};let release;
 const router=await startRouter({port:0,logPath:join(dir,'events.jsonl'),availablePairs:[baseline,chosen],
  runtimeOptions:{credentialLoader:async()=> 'PRIVATE_CREDENTIAL',fetchImpl:async()=>{calls.jev++;return jevReply();}},
  settingsOptions:{keyPath,credentialLoader:async()=> 'PRIVATE_CREDENTIAL',launch:async()=>{calls.launch++;return {launched:true};},fetchImpl:async()=>{calls.jev++;return jevReply();}},
  fetchImpl:async(_u,o)=>{calls.gpt++;const b=JSON.parse(o.body);calls.received.push(b);if(Object.hasOwn(b,'max_output_tokens'))return Response.json({detail:'Unsupported parameter: max_output_tokens'},{status:400});if(hold)await new Promise(r=>release=r);
   return new Response('event: response.completed\ndata: '+JSON.stringify({response:{id:'synthetic-response',model:b.model,reasoning:b.reasoning,service_tier:'default',usage:{input_tokens:1000,input_tokens_details:{cached_tokens:0},output_tokens:50},output:[{id:'synthetic-final',type:'message',role:'assistant',phase:'final_answer'}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}});}});
 t.after(async()=>{release?.();await router.close();rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${router.port}`;
 const get=async()=>{const response=await fetch(base+'/api/settings');assert.equal(response.status,200);return response.json();};
 const token=(await get()).token;
 const post=(data,headers={},path='/api/settings')=>fetch(base+path,{method:'POST',headers:{origin:base,'content-type':'application/json','x-advisor-token':token,...headers},body:JSON.stringify(data)});
 const send=(threadId='test-thread',turnId='one',tool=false)=>fetch(base+'/responses',{method:'POST',headers:{originator:'Codex Desktop','user-agent':'Codex Desktop/1','thread-id':threadId,'x-codex-turn-metadata':JSON.stringify({request_kind:'turn',turn_id:turnId})},body:JSON.stringify({model:baseline.model,reasoning:{effort:baseline.effort},service_tier:'default',input:tool?[{type:'function_call_output',call_id:'call-1',output:'TOOL_PRIVATE'}]:[{role:'user',content:'Inspect the named project files, make the targeted fix, and verify it.'}]})});
 return {dir,base,get,post,send,calls,release:()=>release?.()};
}
test('settings reads are inert and secret-free; CSRF, hostile origin, GET mutation and unknown action are rejected',async t=>{
 const f=await fixture(t);const page=await f.get();assert.equal(page.credentialConfigured,true);assert.equal(page.mode,'rules');assert.equal(f.calls.jev,0);
 assert.doesNotMatch(JSON.stringify(page),/PRIVATE_CREDENTIAL/);
 assert.equal((await f.post({action:'key-setup'},{'x-advisor-token':'wrong'})).status,403);
 assert.equal((await f.post({action:'key-setup'},{origin:'https://evil.example'})).status,403);
 assert.equal((await f.post({action:'key-setup'},{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await fetch(f.base+'/api/project-briefs?action=save')).status,405);
 assert.equal((await f.post({action:'execute',command:'bad'})).status,400);
 assert.equal(f.calls.launch,0);assert.equal(f.calls.jev,0);assert.equal(existsSync(join(f.dir,'routing-mode.json')),false);
});

test('registered trial requests explicitly use standard speed without changing outside requests',async t=>{
 const f=await fixture(t,{trial:true});
 const send=threadId=>fetch(f.base+'/responses',{method:'POST',headers:{originator:'Codex Desktop','user-agent':'Codex Desktop/1','thread-id':threadId,'x-codex-turn-metadata':JSON.stringify({request_kind:'turn',turn_id:'speed'})},body:JSON.stringify({model:baseline.model,reasoning:{effort:baseline.effort},input:[{role:'user',content:'Reply with OK.'}]})});
 const first=await send('test-thread');assert.equal(first.status,200);await first.text();
 assert.equal(f.calls.received[0].service_tier,'default');
 const second=await send('outside-thread');assert.equal(second.status,200);await second.text();
 assert.equal(f.calls.received[1].service_tier,undefined);
});
test('explicit consent selects production r10 without evaluation registration; project writes use same API',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post({action:'mode',mode:'auto',consent:false})).status,400);
 assert.equal((await f.post({action:'mode',mode:'auto',consent:true})).status,200);
 assert.equal((await f.get()).policyVersion,'research-v5b-r10');
 assert.equal((await f.post({action:'save',scope:'thread',target:'test-thread',text:'SYNTHETIC_PROJECT_BRIEF',consent:true},{},'/api/project-briefs')).status,200);
 assert.equal((await f.send()).status,200);assert.equal(f.calls.jev,1);assert.equal(f.calls.received[0].model,chosen.model);
 assert.equal(existsSync(join(f.dir,'evaluation-config.json')),false);
 const status=await(await fetch(f.base+'/api/status')).text();assert.doesNotMatch(status,/SYNTHETIC_PROJECT_BRIEF|PRIVATE_CREDENTIAL|TOOL_PRIVATE/);
 assert.doesNotMatch(readFileSync(join(f.dir,'events.jsonl'),'utf8'),/SYNTHETIC_PROJECT_BRIEF|PRIVATE_CREDENTIAL/);
});
test('busy upstream rejects configuration mutation and does not launch credential windows',async t=>{
 const f=await fixture(t,{hold:true});const pending=f.send();
 for(let i=0;i<100&&!f.calls.gpt;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(f.calls.gpt,1);
 assert.equal((await f.post({action:'key-setup'})).status,409);
 assert.equal((await f.post({action:'mode',mode:'auto',consent:true})).status,409);
 assert.equal(f.calls.launch,0);assert.equal(existsSync(join(f.dir,'routing-mode.json')),false);
 f.release();assert.equal((await pending).status,200);
});
test('trial scope restricts Jev, accounts tool continuation once and checks connection explicitly',async t=>{
 const f=await fixture(t,{trial:true});await f.post({action:'mode',mode:'auto',consent:true});
 assert.equal((await f.send('outside')).status,200);assert.equal(f.calls.jev,0);
 assert.equal((await f.send()).status,200);assert.equal((await f.send('test-thread','one',true)).status,200);
 assert.equal(f.calls.jev,1);assert.equal(f.calls.received[1].max_output_tokens,undefined);assert.equal(f.calls.received[2].model,chosen.model);
 assert.equal((await f.post({action:'check-connection'})).status,200);assert.equal(f.calls.jev,2);
 const snapshot=(await f.get()).trial;assert.equal(snapshot.gpt,2);assert.equal(snapshot.jev,2);assert.equal(snapshot.blockedReason,null);assert.equal(snapshot.heldCredits,0);
 assert.equal(snapshot.entries.filter(e=>e.kind==='gpt').every(e=>e.status==='settled'),true);
});
test('Chinese summaries survive HTTP chunks split inside a UTF-8 character',async t=>{
 const f=await fixture(t),token=(await f.get()).token;
 const data=Buffer.from(JSON.stringify({action:'save',scope:'thread',target:'test-thread',text:'中文项目摘要',consent:true}));
 const split=data.indexOf(Buffer.from('中'))+1;
 const status=await new Promise((resolve,reject)=>{
  const req=httpRequest(f.base+'/api/project-briefs',{method:'POST',headers:{origin:f.base,'content-type':'application/json','x-advisor-token':token}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',reject);req.write(data.subarray(0,split));setTimeout(()=>req.end(data.subarray(split)),20);
 });
 assert.equal(status,200);assert.equal((await f.get()).briefs.entries[0].text,'中文项目摘要');
});
