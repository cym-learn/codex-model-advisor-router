import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectKey,projectContexts,updateProjectContext,resolveProjectContext} from '../src/project-contexts.mjs';
import {writeJson} from '../src/local-state.mjs';
import {jevRuntime} from '../src/jev-runtime.mjs';
const incoming={model:'gpt-6-sol',effort:'high'},chosen={model:'gpt-6-luna',effort:'medium'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'product-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
const save=(dir,scope,target,text)=>updateProjectContext(dir,{action:'save',scope,target,text,consent:true});

test('multiple roots share one summary, edits replace the group and invalid roots are atomic',t=>{
 const dir=fixture(t),a=join(dir,'front'),b=join(dir,'back'),c=join(dir,'docs');for(const p of [a,b,c])mkdirSync(p);
 save(dir,'project',`${a}\r\n\n${b}\n${a}`,'shared context');
 let entries=projectContexts(dir).entries;assert.equal(entries.length,1);assert.equal(entries[0].target.split('\n').length,2);
 const first=resolveProjectContext(dir,'one',join(a,'src'));
 const rootKey=projectKey(entries[0].target.split('\n')[0]),cwdKey=projectKey(join(a,'src'));
 let common=0;while(common<Math.min(rootKey?.length??0,cwdKey?.length??0)&&rootKey[common]===cwdKey[common])common++;
 assert.equal(first.text,'shared context',JSON.stringify({reason:first.reason,rootLength:rootKey?.length,cwdLength:cwdKey?.length,commonPrefixLength:common,rootDiffCode:rootKey?.charCodeAt(common),cwdDiffCode:cwdKey?.charCodeAt(common),sameDrive:rootKey?.slice(0,2)===cwdKey?.slice(0,2)}));
 assert.equal(resolveProjectContext(dir,'two',join(b,'src')).text,'shared context');
 const before=JSON.stringify(entries);
 assert.throws(()=>save(dir,'project',`${c}\n${join(dir,'missing')}`,'bad'));
 assert.equal(JSON.stringify(projectContexts(dir).entries),before);
 assert.throws(()=>save(dir,'project',`${b}\n${c}`,'conflict'));
 updateProjectContext(dir,{action:'save',scope:'project',target:`${b}\n${c}`,originalTarget:entries[0].target,text:'updated context',consent:true});
 assert.equal(resolveProjectContext(dir,'one',a).enabled,false);
 for(const p of [b,c])assert.equal(resolveProjectContext(dir,'one',p).text,'updated context');
 entries=projectContexts(dir).entries;assert.equal(entries.length,1);
 updateProjectContext(dir,{action:'disable',scope:'project',target:entries[0].target});
 for(const p of [b,c])assert.equal(resolveProjectContext(dir,'one',p).reason,'summary_disabled');
 updateProjectContext(dir,{action:'delete',scope:'project',target:entries[0].target});
 assert.equal(projectContexts(dir).entries.length,0);
});

test('multi-root specificity uses the matching root rather than the whole path list',t=>{
 const dir=fixture(t),parent=join(dir,'app'),child=join(parent,'nested'),other=join(dir,'long-unrelated-folder-name');
 mkdirSync(child,{recursive:true});mkdirSync(other);
 save(dir,'project',`${parent}\n${other}`,'parent');save(dir,'project',child,'child');
 assert.equal(resolveProjectContext(dir,'t',child).text,'child');
 assert.equal(resolveProjectContext(dir,'t',other+'-outside').enabled,false);
});

test('project path matching is case-insensitive, boundary-safe, and most-specific',t=>{
 const dir=fixture(t),parent=join(dir,'project'),child=join(parent,'nested');mkdirSync(child,{recursive:true});
 save(dir,'project',parent,'parent stack');save(dir,'project',child,'nested stack');
 assert.equal(resolveProjectContext(dir,'a',join(child,'src')).text,'nested stack');
 assert.equal(resolveProjectContext(dir,'b',join(parent,'src')).text,'parent stack');
 assert.equal(resolveProjectContext(dir,'a',parent+'-other').enabled,false);
 assert.equal(projectKey('C:\\Code\\Example\\'),projectKey('c:/code/example'));
 assert.equal(resolveProjectContext(dir,'a',null).reason,'project_unknown');
});
test('legacy thread summary wins, disabled entry suppresses project inheritance, deletion restores project',t=>{
 const dir=fixture(t),parent=join(dir,'project');mkdirSync(parent);
 writeJson(join(dir,'project-briefs.json'),{version:1,entries:[{threadId:'thread-a',text:'legacy text',enabled:true,consentToSendSummary:true,consentedAt:new Date().toISOString()}]});
 save(dir,'project',parent,'project text');
 assert.equal(resolveProjectContext(dir,'thread-a',parent).text,'legacy text');
 updateProjectContext(dir,{action:'disable',scope:'thread',target:'thread-a'});
 assert.equal(resolveProjectContext(dir,'thread-a',parent).reason,'summary_disabled');
 assert.equal(resolveProjectContext(dir,'thread-b',parent).text,'project text');
 updateProjectContext(dir,{action:'delete',scope:'thread',target:'thread-a'});
 assert.equal(resolveProjectContext(dir,'thread-a',parent).text,'project text');
});
test('invalid consent, length and missing path leave saved settings untouched',t=>{
 const dir=fixture(t);save(dir,'thread','thread-a','valid text');
 const before=JSON.stringify(projectContexts(dir));
 for(const change of [{text:'changed',consent:false},{text:'x'.repeat(2001),consent:true}])assert.throws(()=>updateProjectContext(dir,{action:'save',scope:'thread',target:'thread-a',...change}));
 assert.throws(()=>save(dir,'project',join(dir,'missing'),'valid'));
 assert.equal(JSON.stringify(projectContexts(dir)),before);
});
test('summary edits apply next turn, revocation rejects late selection and does not persist summary text',async t=>{
 const dir=fixture(t),mode=join(dir,'routing-mode.json');
 writeJson(mode,{version:1,mode:'auto',policyVersion:'research-v5b-r10',consentToSendTaskText:true,consentedAt:new Date().toISOString()});
 save(dir,'thread','thread-a','PRIVATE_SUMMARY_ONE');
 const payloads=[];let release;
 const runtime=jevRuntime({configPath:mode,statePath:join(dir,'turns.json'),counterPath:join(dir,'count.json'),catalog:()=>[incoming,chosen],baseline:incoming,
  credentialLoader:async()=> 'FAKE_SECRET',fetchImpl:async(_u,o)=>{payloads.push(o.body);if(payloads.length===3)await new Promise(r=>release=r);return Response.json({model:'jev-1.13-free',answers:{pair:{type:'choice',choice:'gpt-6-luna/medium'}}});}});
 t.after(()=>runtime.close());
 const request=(turnId,tool=false)=>({threadId:'thread-a',turnId,client:'desktop',rule:incoming,body:{model:incoming.model,reasoning:{effort:incoming.effort},input:tool?[{type:'function_call_output',output:'done'}]:[{role:'user',content:'Inspect the named project files, make the targeted fix, and verify it.'}]}});
 assert.equal((await runtime.route(request('one'))).selection.source,'jev');
 save(dir,'thread','thread-a','PRIVATE_SUMMARY_TWO');
 assert.equal((await runtime.route(request('one',true))).selection.source,'jev');
 assert.equal(payloads.length,1);
 await runtime.route(request('two'));assert.match(payloads[1],/PRIVATE_SUMMARY_TWO/);assert.doesNotMatch(payloads[1],/PRIVATE_SUMMARY_ONE/);
 const pending=runtime.route(request('three'));
 for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,2));
 assert.ok(release);updateProjectContext(dir,{action:'disable',scope:'thread',target:'thread-a'});release();
 assert.equal((await pending).selection.source,'incoming');
 assert.doesNotMatch(readFileSync(join(dir,'turns.json'),'utf8'),/PRIVATE_SUMMARY|FAKE_SECRET/);
});
