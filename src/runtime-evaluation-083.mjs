import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {readJson,writeJson} from './local-state.mjs';
import {jevRuntime} from './jev-runtime.mjs';
import {chooseLocalRoute,requestPhase,hasEffortUpdate} from './policy.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
export function runtimeEvaluation083({catalog,baseline,credentialLoader,fetchImpl,timeoutMs,onEvent}){
 const instances=new Map();
 async function route({c,registration:r,budget,threadId,turnId,body,requestKey,signal,report}){
  const incoming={model:body.model,effort:body.reasoning?.effort},phase=requestPhase(body);
  let saved;try{saved=readJson(c.statePath);}catch(e){if(e.code!=='ENOENT')return {blocked:'evaluation_state_unavailable'};saved={version:1,entries:[]};}
  if(!Array.isArray(saved.entries))return {blocked:'evaluation_state_unavailable'};
  const previous=saved.entries.find(e=>e.runId===r.runId);
  if(previous&&previous.turnId!==turnId)return {blocked:'evaluation_turn_not_registered'};
  if(!previous){let text=phase.text??'';if(text.includes('## My request:'))text=text.slice(text.lastIndexOf('## My request:')+14);text=text.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g,'').trim();
   if(phase.kind!=='user'||hasEffortUpdate(body)||incoming.model!==baseline.model||incoming.effort!==baseline.effort)return {blocked:'protected_configuration'};
   if(digest(text)!==r.taskHash&&!r.taskHashVariants?.includes(digest(text)))return {blocked:'registered_task_mismatch'};
  }
  const rule=chooseLocalRoute({body,baseline,availablePairs:catalog(),previousRoute:previous?.selected});
  let decision=rule;
  Object.assign(report,{incoming,policyVersion:r.policyVersion??null,source:'rules',selected:{model:rule.model,effort:rule.effort},rule,contextTag:r.projectBrief?digest(r.projectBrief):null,projectBriefEnabled:!!r.projectBrief,engine:'production_jevRuntime'});
  if(r.arm==='fixed'){
   if(!catalog().some(p=>p.model===r.pair?.model&&p.effort===r.pair?.effort))return {blocked:'invalid_fixed_pair'};
   decision={...r.pair,reason:'evaluation_fixed'};report.selected={...r.pair};report.source='fixed';
  }else if(r.arm==='jev'){
   let instance=instances.get(r.runId);
   if(!instance){
    const read=()=>{let config;try{config=readJson(c.configPath);}catch{return {mode:'rules',policyVersion:r.policyVersion};}
     const active=config.enabled&&Date.parse(config.expiresAt)>Date.now()&&config.registrations.some(x=>x.runId===r.runId&&x.threadId===threadId);
     return {version:1,mode:active?'auto':'rules',policyVersion:r.policyVersion,contextTag:r.projectBrief?digest(r.projectBrief):null,projectBrief:r.projectBrief??null};};
    instance=jevRuntime({statePath:join(dirname(c.statePath),r.runId+'-runtime.json'),counterPath:join(dirname(c.statePath),r.runId+'-counter.json'),catalog,baseline,credentialLoader,fetchImpl,timeoutMs,configReader:read,reserveJev:()=>budget.reserve('jev',r.stage,r.runId)});instances.set(r.runId,instance);
   }
   const routed=await instance.route({id:requestKey,threadId,turnId,client:'desktop',body,rule,signal});
   if(!routed)return {blocked:'production_runtime_unavailable'};
   const s=routed.selection;decision=routed.decision;Object.assign(report,{selected:s.selected,rule:null,source:s.source,jev:s.jev,applied:s.source==='jev',fallback:s.source==='jev'?null:s.reason,waitMs:s.waitMs});
  }
  const record={...report,threadId,turnId,at:Date.now(),pending:false};const idx=saved.entries.findIndex(e=>e.runId===r.runId);if(idx<0)saved.entries.push(record);else saved.entries[idx]=record;writeJson(c.statePath,saved);
  onEvent({event:'evaluation_decision',threadId,turnId,experiment:report});return {decision,experiment:report};
 }
 return {route,close(){for(const i of instances.values())i.close();}};
}
