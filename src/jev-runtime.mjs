import {projectBriefState083} from './research-083.mjs';
import {resolveProjectContext} from './project-contexts.mjs';
import {dirname,join} from 'node:path';
import {readJson,writeJson,safeId} from './local-state.mjs';
import {askJev,jevContext,loadCredential,safeJevResult} from './jev.mjs';
import {candidateVersions} from './jev-candidates.mjs';
import {independentPolicy,informationProfile} from './jev-independent.mjs';
import {supportedRoutingPairs,hasEffortUpdate,requestPhase} from './policy.mjs';
import {researchPolicy,researchPairs} from './research-080.mjs';

const modes=['rules','shadow','auto'],ttl=7200000;
const cleanReason=x=>typeof x==='string'&&/^[a-z_]{1,80}$/.test(x)?x:null;
const allowedPairs=(catalog,version)=>researchPolicy(version)?researchPairs(catalog,version):supportedRoutingPairs(catalog);
const pair=(x,version)=>x&&allowedPairs([x],version).length?{model:x.model,effort:x.effort}:null;
export function safeSelection(x){
 if(!x||!modes.includes(x.mode)||!candidateVersions.includes(x.policyVersion))return null;
 const jev=safeJevResult(x.jev);if(jev)jev.applied=x.source==='jev'&&x.mode==='auto';
 return {mode:x.mode,policyVersion:x.policyVersion,contextTag:x.contextTag??null,projectBriefEnabled:!!x.projectBriefEnabled,inputProfile:informationProfile(x.policyVersion),fallbackPolicy:independentPolicy(x.policyVersion)?'incoming':'rules',source:['rules','jev','incoming'].includes(x.source)?x.source:'rules',reason:cleanReason(x.reason),incoming:pair(x.incoming,x.policyVersion),rule:pair(x.rule,x.policyVersion),selected:pair(x.selected,x.policyVersion),jev,projectBriefScope:x.projectBriefScope??null,projectBriefReason:x.projectBriefReason??null,waitMs:Number.isFinite(x.waitMs)&&x.waitMs>=0?x.waitMs:null};
}
export function runtimeConfig(path){
 try{const c=readJson(path);if(c.version!==1||!modes.includes(c.mode)||!candidateVersions.includes(c.policyVersion)||c.mode!=='rules'&&(c.consentToSendTaskText!==true||!Number.isFinite(Date.parse(c.consentedAt))))throw Error();return c;}
 catch{return {version:1,mode:'rules',policyVersion:'quality-first-v3a',state:'default_or_invalid'};}
}
export function jevRuntime({configPath,statePath,counterPath,catalog,baseline,onEvent=()=>{},credentialLoader=loadCredential,fetchImpl,timeoutMs=5000,configReader=null,reserveJev=null,settleJev=null,directoryResolver=()=>null,scopeAllowed=()=>true}){
 const records=new Map(),jobs=new Map(),controllers=new Set();let persistence='ready',credentialPromise,unavailable=null,closed=false;
 const readConfig=threadId=>{
  if(configReader)return configReader();
  const c=runtimeConfig(configPath),brief=resolveProjectContext(dirname(configPath),threadId,directoryResolver(threadId));
  return {...c,projectBrief:brief.enabled?brief.text:null,contextTag:brief.hash??null,projectBriefScope:brief.scope??null,projectBriefReason:brief.reason};
 };
 const fingerprint=c=>`${c.mode}:${c.policyVersion}${c.contextTag?':'+c.contextTag:''}`;
 try{const saved=readJson(statePath);if(saved.version!==1||!Array.isArray(saved.entries)||saved.entries.length>1000)throw Error();
  for(const e of saved.entries){const selection=safeSelection(e.selection);if(!safeId(e.threadId)||!safeId(e.turnId)||!Number.isFinite(e.at)||Date.now()-e.at>=ttl||e.at>Date.now()||!selection||e.fingerprint!==fingerprint(selection))continue;
   if(selection.jev?.status==='pending'){selection.jev={...selection.jev,status:'failed',reason:'interrupted'};selection.source=independentPolicy(selection.policyVersion)?'incoming':'rules';selection.selected=selection.source==='incoming'?selection.incoming:selection.rule;selection.reason='interrupted';}
   records.set(`${e.fingerprint}:${e.threadId}:${e.turnId}`,{threadId:e.threadId,turnId:e.turnId,at:e.at,fingerprint:e.fingerprint,baseline:{model:e.baseline?.model,effort:e.baseline?.effort},selection});
  }
 }catch(e){if(e.code!=='ENOENT')persistence='unavailable';}
 function persist(){
  for(const [k,e]of records)if(Date.now()-e.at>=ttl&&!jobs.has(k))records.delete(k);
  while(records.size>1000){const k=[...records.keys()].find(k=>!jobs.has(k));if(!k)break;records.delete(k);}
  try{writeJson(statePath,{version:1,entries:[...records.values()]});return true;}catch{persistence='unavailable';return false;}
 }
 function counter(){try{const c=readJson(counterPath);if(c.version!==1||!Number.isSafeInteger(c.calls)||c.calls<0)throw Error();return c;}catch(e){return e.code==='ENOENT'?{version:1,calls:0}:null;}}
 function snapshot(){const c=readConfig();return {mode:c.mode,policyVersion:c.policyVersion,inputProfile:informationProfile(c.policyVersion),fallbackPolicy:independentPolicy(c.policyVersion)?'incoming':'rules',scope:'global_eligible_turns',pending:jobs.size,state:unavailable??persistence,inputCharacterLimit:16000,usage:counter()};}
 function get(thread,turn){const e=[...records.values()].findLast(e=>e.threadId===thread&&e.turnId===turn);return e?safeSelection(e.selection):null;}
 async function route({id,threadId,turnId,client,body,rule,signal}){
  const c=readConfig(threadId);if(closed||!scopeAllowed(threadId)||c.mode==='rules'||client!=='desktop'||!safeId(threadId)||!safeId(turnId))return null;
  const independent=independentPolicy(c.policyVersion),incoming={model:body.model,effort:body.reasoning?.effort},fallback=independent?incoming:rule,fallbackSource=independent?'incoming':'rules';
  const prior=[...records.entries()].find(([k,e])=>e.threadId===threadId&&e.turnId===turnId&&e.selection.mode===c.mode&&e.selection.policyVersion===c.policyVersion&&(e.selection.contextTag===(c.contextTag??null)||c.policyVersion==='research-v5b-r10')&&Date.now()-e.at<ttl);
  const key=prior?.[0]??`${fingerprint(c)}:${threadId}:${turnId}`;
  const protectedInput=hasEffortUpdate(body)||body.model!==baseline.model||body.reasoning?.effort!==baseline.effort;
  const wrap=e=>({decision:e.selection.source==='jev'?{...e.selection.selected,reason:'jev_auto'}:e.selection.selected?{...e.selection.selected,reason:requestPhase(body).kind==='tool'?'same_turn':independent?'incoming_configuration':rule.reason}:fallback,selection:safeSelection(e.selection)});
  if(prior?.[1].selection.projectBriefEnabled&&!c.projectBrief)return {decision:fallback,selection:{...safeSelection(prior[1].selection),source:fallbackSource,jev:prior[1].selection.jev?{...prior[1].selection.jev,applied:false}:null,selected:pair(fallback,c.policyVersion),reason:'policy_changed_same_turn',waitMs:0}};
  if(records.has(key)){
   if(c.mode==='auto'&&jobs.has(key))await jobs.get(key);
   const e=records.get(key);if(protectedInput)return {decision:fallback,selection:{...safeSelection(e.selection),source:fallbackSource,jev:e.selection.jev?{...e.selection.jev,applied:false}:null,selected:pair(fallback),reason:'protected_configuration'}};
   if(e.baseline?.model!==baseline.model||e.baseline?.effort!==baseline.effort||!allowedPairs(catalog(),c.policyVersion).some(p=>p.model===e.selection.selected?.model&&p.effort===e.selection.selected?.effort))return {decision:fallback,selection:{...safeSelection(e.selection),source:fallbackSource,selected:pair(fallback,c.policyVersion),reason:'route_not_restored'}};
   const reused=wrap(e);reused.selection={...reused.selection,waitMs:0};return reused;
  }
  // A mode/policy change cannot turn a retry into a second classification of the same user turn.
  if([...records.values()].some(e=>e.threadId===threadId&&e.turnId===turnId&&Date.now()-e.at<ttl))return {decision:fallback,selection:{mode:c.mode,policyVersion:c.policyVersion,source:fallbackSource,reason:'policy_changed_same_turn',incoming:pair(incoming),rule:independent?null:pair(rule),selected:pair(fallback),jev:null,waitMs:0}};
  let prepared=jevContext(body,baseline,c.policyVersion);
  if(!prepared.skip&&c.projectBrief)prepared=projectBriefState083(prepared.state,c.projectBrief);
  const entry={threadId,turnId,at:Date.now(),fingerprint:fingerprint(c),baseline,selection:{mode:c.mode,policyVersion:c.policyVersion,contextTag:c.contextTag??null,projectBriefEnabled:!!c.projectBrief,projectBriefScope:c.projectBriefScope,projectBriefReason:c.projectBriefReason,source:fallbackSource,reason:'pending',incoming:pair(incoming),rule:independent?null:pair(rule),selected:pair(fallback),waitMs:0,jev:null}};
  const restoreFallback=()=>{entry.selection.source=fallbackSource;entry.selection.selected=pair(fallback);if(entry.selection.jev)entry.selection.jev.applied=false;};
  const skip=prepared.skip??unavailable??(persistence!=='ready'?'persistence_unavailable':jobs.size>=2?'busy':null);
  entry.selection.jev={policyVersion:c.policyVersion,applied:false,status:skip?'skipped':'pending',reason:skip,suggested:null};entry.selection.reason=skip??'pending';
  records.set(key,entry);
  if(!persist()||skip){if(!skip){entry.selection.reason='persistence_unavailable';entry.selection.jev.status='skipped';entry.selection.jev.reason='persistence_unavailable';}return wrap(entry);}
  onEvent({id,event:'selection_pending',threadId,turnId,client,before:incoming,after:pair(fallback),effortUpdate:false,selection:safeSelection(entry.selection)});
  const controller=new AbortController(),abort=()=>controller.abort();controllers.add(controller);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const begin=performance.now();
  const job=(async()=>{
   const deadline=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]);credentialPromise??=credentialLoader();
   const secret=await new Promise(resolve=>{const expired=()=>resolve(null);deadline.addEventListener('abort',expired,{once:true});credentialPromise.then(v=>{deadline.removeEventListener('abort',expired);resolve(v);},()=>resolve(null));if(deadline.aborted)expired();});
   let result;
   if(deadline.aborted)result={status:'failed',reason:controller.signal.aborted?'cancelled':'timeout'};
   else if(!secret){unavailable='credential_unavailable';result={status:'failed',reason:unavailable};}
   else if(fingerprint(readConfig(threadId))!==fingerprint(c))result={status:'skipped',reason:'disabled'};
   else{
    const usage=counter();if(!usage)result={status:'skipped',reason:'persistence_unavailable'};
    else{
     const permit=reserveJev?reserveJev({threadId,turnId,id}):{allowed:true};
     if(!permit.allowed)result={status:'skipped',reason:permit.reason};
     else{
      try{writeJson(counterPath,{version:1,calls:usage.calls+1,lastAt:new Date().toISOString()});}catch{result={status:'failed',reason:'persistence_unavailable'};}
      if(!result)result=await askJev({state:prepared.state,catalog:catalog(),key:secret,fetchImpl,signal:deadline,timeoutMs,policyVersion:c.policyVersion});
      if(permit.id)result.callId=permit.id;if(settleJev&&permit.tracked)settleJev(permit.id,result);
     }
    }
   }
   if(result.reason==='cancelled'&&!controller.signal.aborted&&deadline.aborted)result.reason='timeout';
   if(controller.signal.aborted)result={status:'failed',reason:'cancelled'};
   else if(fingerprint(readConfig(threadId))!==fingerprint(c))result={status:'skipped',reason:'disabled'};
   if(['authentication_failed','free_service_unavailable'].includes(result.reason))unavailable=result.reason;
   entry.selection.jev=safeJevResult({policyVersion:c.policyVersion,applied:false,suggested:null,...result});entry.selection.waitMs=Math.round(performance.now()-begin);entry.selection.reason=result.reason;
   if(c.mode==='auto'&&result.status==='suggested'&&!controller.signal.aborted&&fingerprint(readConfig(threadId))===fingerprint(c)){entry.selection.source='jev';entry.selection.selected=result.suggested;entry.selection.jev.applied=true;}
   if(!persist()){restoreFallback();entry.selection.reason='persistence_unavailable';}
  })().catch(()=>{restoreFallback();entry.selection.reason='internal_error';entry.selection.jev={policyVersion:c.policyVersion,status:'failed',reason:'internal_error',applied:false,suggested:null};persist();})
   .finally(()=>{jobs.delete(key);controllers.delete(controller);signal?.removeEventListener('abort',abort);onEvent({id,event:'selection',threadId,turnId,selection:safeSelection(entry.selection)});});
  jobs.set(key,job);if(c.mode==='auto')await job;return wrap(entry);
 }
 return {snapshot,get,route,refreshCredentials(){credentialPromise=null;unavailable=null;},close(){closed=true;for(const c of controllers)c.abort();}};
}
