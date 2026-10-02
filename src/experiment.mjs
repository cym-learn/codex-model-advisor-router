import {limits083,stages083} from './budget-083.mjs';
import {limits084,stages084,validApproval084} from './budget-084.mjs';
import {limits085,stages085,validApproval085} from './budget-085.mjs';
import {limitsDesktopSmoke,stagesDesktopSmoke,validApprovalDesktopSmoke} from './budget-desktop-smoke.mjs';
import {runtimeEvaluation083} from './runtime-evaluation-083.mjs';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, writeJson, safeId } from './local-state.mjs';
import { askJev, jevContext, loadCredential, safeJevResult } from './jev.mjs';
import { candidateVersions } from './jev-candidates.mjs';
import {independentPolicy,informationProfile} from './jev-independent.mjs';
import { chooseLocalRoute, requestPhase, hasEffortUpdate } from './policy.mjs';
import {limits080,stages080} from './budget-080.mjs';
import {limits081,stages081} from './budget-081.mjs';
import {limits082,stages082} from './budget-082.mjs';

export const taskHash = (text) => createHash('sha256').update(text.trim()).digest('hex');
export const stageLimits = { preflight: { gpt: 4, jev: 2 }, frozen: { gpt: 56, jev: 24 },
  matrix: { gpt: 30, jev: 0 }, desktop: { gpt: 18, jev: 4 }, reserve: { gpt: 12, jev: 10 } };
export const stageLimits060 = { preflight: {gpt:4,jev:2}, development:{gpt:54,jev:28}, frozen:{gpt:252,jev:98}, judge:{gpt:48,jev:0}, desktop:{gpt:20,jev:8}, reserve:{gpt:22,jev:64} };
export const stageLimits070 = {development:{gpt:300,jev:150},frozen:{gpt:650,jev:250},judge:{gpt:120,jev:0},desktop:{gpt:40,jev:20},reserve:{gpt:90,jev:80}};
const profileFor = d => d.version===10 && d.profile==='desktop-smoke-r1' && validApprovalDesktopSmoke(d.authorization) ? {limits:limitsDesktopSmoke,stages:stagesDesktopSmoke} : d.version===9 && d.profile==='0.8.5' && validApproval085(d.authorization) ? {limits:limits085,stages:stages085} : d.version===8 && d.profile==='0.8.4' && validApproval084(d.authorization) ? {limits:limits084,stages:stages084} : d.version===7 && d.profile==='0.8.3' ? {limits:limits083,stages:stages083} : d.version===6 && d.profile==='0.8.2' ? {limits:limits082,stages:stages082} : d.version===5 && d.profile==='0.8.1' ? {limits:limits081,stages:stages081} : d.version===4 && d.profile==='0.8.0' ? {limits:limits080,stages:stages080} : d.version===3 && d.profile==='0.7.0' ? {limits:{gpt:1200,jev:500},stages:stageLimits070} : d.version===2 && d.profile==='0.6.0' ? d.budgetAmendment?.id==='060-gpt-480' && Number.isFinite(Date.parse(d.budgetAmendment.approvedAt))
  ? {limits:{gpt:480,jev:200},stages:{...stageLimits060,frozen:{gpt:320,jev:98},reserve:{gpt:34,jev:64}}}
  : {limits:{gpt:400,jev:200},stages:stageLimits060} : d.version===1 ? {limits:{gpt:120,jev:40},stages:stageLimits} : null;
export function initEvaluation(path, manifestHash, profile='0.5.0', authorization=null) {
  if(!['0.5.0','0.6.0','0.7.0','0.8.0','0.8.1','0.8.2','0.8.3','0.8.4','0.8.5','desktop-smoke-r1'].includes(profile))throw Error('Unknown evaluation profile.');
  if(profile==='0.8.4'&&!validApproval084(authorization))throw Error('Explicit 084 authorization required.');
  if(profile==='0.8.5'&&!validApproval085(authorization))throw Error('Explicit 085 authorization required.');
  if(profile==='desktop-smoke-r1'&&!validApprovalDesktopSmoke(authorization))throw Error('Explicit Desktop smoke authorization required.');
  const version=profile==='desktop-smoke-r1'?10:profile==='0.8.5'?9:profile==='0.8.4'?8:profile==='0.8.3'?7:profile==='0.8.2'?6:profile==='0.8.1'?5:profile==='0.8.0'?4:profile==='0.7.0'?3:profile==='0.6.0'?2:1,limits=version===10?limitsDesktopSmoke:version===9?limits085:version===8?limits084:version===7?limits083:version===6?limits082:version===5?limits081:version>=3?{gpt:1200,jev:500}:version===2?{gpt:400,jev:200}:{gpt:120,jev:40};
  try {const d=readJson(path),p=profileFor(d);if(d.version!==version||d.manifestHash!==manifestHash||!p||d.limits?.gpt!==p.limits.gpt||d.limits?.jev!==p.limits.jev)throw Error();return d;}
  catch(e){if(e.code!=='ENOENT')throw Error('Existing evaluation must not be reset.');}
  const d={version,...(version>=2?{profile}:{}),...([8,9,10].includes(version)?{authorization}:{}),id:randomUUID(),manifestHash,limits,closedAt:null,entries:[]};writeJson(path,d);return d;
}
export function evaluationBudget(path) {
  const load=()=>{const d=readJson(path),p=profileFor(d);if(!p||!safeId(d.id)||d.limits?.gpt!==p.limits.gpt||d.limits?.jev!==p.limits.jev||!Array.isArray(d.entries)||!d.entries.every(e=>safeId(e.id)&&['gpt','jev'].includes(e.kind)&&Object.hasOwn(p.stages,e.stage)))throw Error();return d;};
  return {
    snapshot(){try{const d=load();return {state:d.closedAt?'closed':'open',id:d.id,...Object.fromEntries(['gpt','jev'].map(k=>[k,{used:d.entries.filter(e=>e.kind===k).length,limit:d.limits[k]}]))};}catch{return {state:'unavailable'};}},
    acceptsStage(stage){try{return Object.hasOwn(profileFor(load()).stages,stage);}catch{return false;}},
    stageLimit(stage){try{return profileFor(load()).stages[stage]??null;}catch{return null;}},
    reserve(kind,stage,runId,id=randomUUID(),desktopOverflow=false){let fd;
      try{fd=openSync(path+'.lock','wx');const d=load(),p=profileFor(d);
        if(d.closedAt)return {allowed:false,reason:'evaluation_closed'};
        if(!safeId(id)||!safeId(runId)||!Object.hasOwn(p.stages,stage)||!['gpt','jev'].includes(kind))return {allowed:false,reason:'invalid_registration'};
        if(d.entries.some(e=>e.id===id))return {allowed:false,reason:'duplicate_call'};
        if(desktopOverflow&&(kind!=='gpt'||stage!=='reserve'||d.entries.some(e=>e.desktopOverflow)))return {allowed:false,reason:'desktop_overflow_unavailable'};
        if(d.entries.filter(e=>e.kind===kind).length>=d.limits[kind]||d.entries.filter(e=>e.kind===kind&&e.stage===stage).length>=p.stages[stage][kind])return {allowed:false,reason:kind+'_evaluation_budget_exhausted'};
        d.entries.push({id,kind,stage,runId,at:new Date().toISOString(),...(desktopOverflow?{desktopOverflow:true}:{})});writeJson(path,d);return {allowed:true,id};
      }catch{return {allowed:false,reason:'evaluation_budget_unavailable'};}
      finally{if(fd!==undefined){closeSync(fd);try{unlinkSync(path+'.lock');}catch{}}}
    }
  };
}

// Explicit allowlist and a separate ledger; absence/expiry never enables Jev for daily work.
export function experimentController({ configPath, catalog, baseline, isolated=false, credentialLoader=loadCredential,
  fetchImpl, timeoutMs=5000, onEvent=()=>{} }) {
  let pending=0, secretPromise, unavailable=null;
  const production=runtimeEvaluation083({catalog,baseline,credentialLoader,fetchImpl,timeoutMs,onEvent});
  const controllers=new Set(), jobs=new Map();
  const config=()=>{try{const d=readJson(configPath);if(d.version!==1||!Array.isArray(d.registrations)||!d.ledgerPath||!d.statePath)throw Error();return d;}catch{return null;}};
  function snapshot(){const c=config();return {mode:c?.enabled?'controlled':'off',pending,
    budget:c?evaluationBudget(c.ledgerPath).snapshot():null,registeredThreads:c?.registrations.length??0};}
  async function route({threadId,turnId,client,body,requestKey,signal}) {
    const c=config(), registration=c?.registrations.find(r=>r.threadId===threadId);
    if(!registration) return isolated?{blocked:'unregistered_evaluation_source'}:null;
    if(!safeId(registration.runId)||!Object.hasOwn({...stageLimits,...stageLimits060,...stageLimits070,...stages080,...stages081,...stages082,...stages083,...stages084,...stages085},registration.stage)||!['rule','jev','fixed'].includes(registration.arm))return {blocked:'invalid_registration'};
    if(registration.policyVersion!==undefined&&!candidateVersions.includes(registration.policyVersion))return {blocked:'invalid_registration'};
    if(registration.taskHashVariants!==undefined&&(!Array.isArray(registration.taskHashVariants)||registration.taskHashVariants.length>2||!registration.taskHashVariants.every(h=>/^[a-f0-9]{64}$/.test(h))))return {blocked:'invalid_registration'};
    const budget=evaluationBudget(c.ledgerPath);
    let ledgerProfile;try{ledgerProfile=readJson(c.ledgerPath).profile;}catch{return {blocked:'evaluation_budget_unavailable'};}
    if(['0.8.5','desktop-smoke-r1'].includes(ledgerProfile)&&registration.episodeId===undefined)return {blocked:'invalid_episode_registration'};
    if(ledgerProfile==='desktop-smoke-r1'&&registration.maxEpisodeGpt!==8)return {blocked:'invalid_episode_registration'};
    if(registration.episodeId!==undefined){
      if(!safeId(registration.episodeId)||!registration.runId.startsWith(registration.episodeId+'-')||!(['0.8.3','0.8.4','0.8.5','desktop-smoke-r1'].includes(readJson(c.ledgerPath).profile)?[1,8,12].includes(registration.maxEpisodeGpt):readJson(c.ledgerPath).profile==='0.8.2'?[1,4,6].includes(registration.maxEpisodeGpt):readJson(c.ledgerPath).profile==='0.8.1'?[1,4].includes(registration.maxEpisodeGpt):readJson(c.ledgerPath).profile==='0.8.0'?[4,32].includes(registration.maxEpisodeGpt):registration.maxEpisodeGpt===24))return {blocked:'invalid_episode_registration'};
      const used=readJson(c.ledgerPath).entries.filter(e=>e.kind==='gpt'&&e.runId.startsWith(registration.episodeId+'-')).length;
      if(used>=(['0.8.0','0.8.1','0.8.2','0.8.3','0.8.4','0.8.5','desktop-smoke-r1'].includes(readJson(c.ledgerPath).profile)?registration.maxEpisodeGpt:24))return {blocked:'episode_budget_exhausted'};
    }
    if(!c.enabled || !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt)<=Date.now()) return {blocked:'evaluation_off_or_expired'};
    if(client!=='desktop' && !isolated) return {blocked:'evaluation_client_unconfirmed'};
    let reserve=budget.reserve('gpt',registration.stage,registration.runId,requestKey),budgetStage=registration.stage;
    if(!reserve.allowed && reserve.reason==='gpt_evaluation_budget_exhausted' && registration.stage==='desktop' && c.reserveDesktopOverflow===1){
      reserve=budget.reserve('gpt','reserve',registration.runId,requestKey,true);budgetStage='reserve';
    }
    if(!reserve.allowed && reserve.reason==='gpt_evaluation_budget_exhausted' && c.allowStageReserve===true && readJson(c.ledgerPath).version===2 && registration.stage!=='reserve'){
      reserve=budget.reserve('gpt','reserve',registration.runId,requestKey);budgetStage='reserve';
    }
    if(!reserve.allowed) return {blocked:reserve.reason};
    const started=performance.now(), report={runId:registration.runId,taskId:registration.taskId,arm:registration.arm,stage:registration.stage,
      gptCallId:requestKey,budgetStage,rule:null,selected:null,jev:null,applied:false,fallback:null,waitMs:0};
    if(!turnId){report.fallback='auxiliary_unattributed';return {decision:null,experiment:report};}
    if(['0.8.3','0.8.4','0.8.5','desktop-smoke-r1'].includes(readJson(c.ledgerPath).profile))return production.route({c:{...c,configPath},registration,budget,threadId,turnId,body,requestKey,signal,report});
    let saved;try{saved=readJson(c.statePath);}catch(e){if(e.code!=='ENOENT'){report.fallback='evaluation_state_unavailable';return {decision:null,experiment:report};}saved={version:1,entries:[]};}
    if(saved.version!==1||!Array.isArray(saved.entries)){report.fallback='evaluation_state_unavailable';return {decision:null,experiment:report};}
    const previous=saved.entries.find(e=>e.runId===registration.runId);
    if(previous){
      if(previous.turnId!==turnId) return {blocked:'evaluation_turn_not_registered'};
      if(previous.baseline?.model!==baseline.model||previous.baseline?.effort!==baseline.effort||!catalog().some(p=>p.model===previous.selected?.model&&p.effort===previous.selected?.effort)){
        report.fallback='evaluation_route_not_restored';return {decision:null,experiment:report};}
      const interrupted=previous.pending;
      if(interrupted){const job=jobs.get(registration.runId);if(job){await job;return routeContinuation(c,registration,turnId,report);}}
      Object.assign(report,previous,{waitMs:0,gptCallId:requestKey,budgetStage});report.fallback=report.fallback??null;
      if(interrupted){report.applied=false;report.fallback='interrupted_jev_decision';}
      const protectedHistory=hasEffortUpdate(body) || body.model!==baseline.model || body.reasoning?.effort!==baseline.effort;
      if(protectedHistory){report.applied=false;report.fallback='protected_configuration';return {decision:null,experiment:report};}
      return {decision:{...previous.selected,reason:'evaluation_same_turn'},experiment:report};
    }
    const prepared=jevContext(body,baseline,registration.policyVersion);
    if(requestPhase(body).kind!=='user' || hasEffortUpdate(body) || body.model!==baseline.model || body.reasoning?.effort!==baseline.effort){
      report.fallback=prepared.skip??'protected_configuration';return {decision:null,experiment:report};}
    let task=requestPhase(body).text;
    if(task.includes('## My request:'))task=task.slice(task.lastIndexOf('## My request:')+14);
    task=task.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g,'').trim();
    const hash=taskHash(task);
    if(hash!==registration.taskHash&&!registration.taskHashVariants?.includes(hash)){report.fallback='registered_task_mismatch';return {decision:null,experiment:report};}
    report.taskMatch=hash===registration.taskHash?'exact':'explicit_variant';
    const independent=registration.arm==='jev'&&independentPolicy(registration.policyVersion);
    report.policyVersion=registration.policyVersion??null;report.inputProfile=independent?informationProfile(registration.policyVersion):null;
    report.incoming={model:body.model,effort:body.reasoning?.effort};report.source=independent?'incoming':'rules';
    report.rule=independent?null:chooseLocalRoute({body,baseline,availablePairs:catalog()});
    const fallback=independent?report.incoming:{model:report.rule.model,effort:report.rule.effort};report.selected={...fallback};
    const record={...report,turnId,threadId,baseline,at:Date.now(),pending:registration.arm==='jev'};
    // Claim before external calls, so a crash never repeats a Jev decision.
    saved.entries.push(record);try{writeJson(c.statePath,saved);}catch{report.fallback='evaluation_state_unavailable';return {decision:null,experiment:report};}
    const update=()=>{try{const d=readJson(c.statePath);const i=d.entries.findIndex(e=>e.runId===registration.runId);d.entries[i]={...record,...report,pending:false};writeJson(c.statePath,d);}catch{report.fallback='evaluation_state_unavailable';report.applied=false;report.source=independent?'incoming':'rules';report.selected={...fallback};}};
    if(registration.arm==='fixed'){
      if(catalog().some(p=>p.model===registration.pair?.model&&p.effort===registration.pair?.effort))report.selected={...registration.pair};else report.fallback='invalid_fixed_pair';
    } else if(registration.arm==='jev'){
      if(prepared.skip||unavailable||pending>=2){report.fallback=prepared.skip??unavailable??'busy';}
      else {
        const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        controllers.add(controller);pending++;
        const job=(async()=>{
          const deadline=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]);
          secretPromise??=credentialLoader();
          const key=await new Promise(resolve=>{const expired=()=>resolve(null);deadline.addEventListener('abort',expired,{once:true});
            secretPromise.then(value=>{deadline.removeEventListener('abort',expired);resolve(value);},()=>resolve(null));if(deadline.aborted)expired();});
          if(deadline.aborted){report.fallback=controller.signal.aborted?'cancelled':'timeout';return;}
          if(!key){unavailable='credential_unavailable';report.fallback=unavailable;return;}
          if(controller.signal.aborted){report.fallback='cancelled';return;}
          const permit=budget.reserve('jev',registration.stage,registration.runId);
          if(!permit.allowed){report.fallback=permit.reason;return;}
          const result=await askJev({state:prepared.state,catalog:catalog(),key,fetchImpl,timeoutMs,signal:deadline,policyVersion:registration.policyVersion});
          if(result.reason==='cancelled'&&!controller.signal.aborted&&deadline.aborted)result.reason='timeout';
          report.jev=safeJevResult({...result,callId:permit.id});
          if(result.status==='suggested'&&!controller.signal.aborted){report.selected={...result.suggested};report.applied=true;report.source='jev';}
          else report.fallback=controller.signal.aborted?'cancelled':result.reason??result.status;
          if(['authentication_failed','free_service_unavailable'].includes(result.reason))unavailable=result.reason;
        })();jobs.set(registration.runId,job);
        try{await job;}catch{report.fallback='internal_error';}finally{pending--;controllers.delete(controller);jobs.delete(registration.runId);signal?.removeEventListener('abort',abort);}
      }
    }
    report.waitMs=Math.round(performance.now()-started);update();
    onEvent({event:'evaluation_decision',threadId,turnId,experiment:report});
    return {decision:{...report.selected,reason:report.applied?'evaluation_jev':registration.arm==='fixed'?'evaluation_fixed':independent?'incoming_configuration':'evaluation_rule'},experiment:report};
  }
  function routeContinuation(c,r,turnId,report){const entry=readJson(c.statePath).entries.find(e=>e.runId===r.runId),callId=report.gptCallId;Object.assign(report,entry,{waitMs:0,gptCallId:callId});return {decision:{...entry.selected,reason:'evaluation_same_turn'},experiment:report};}
  return {snapshot,route,close(){production.close();for(const controller of controllers)controller.abort();}};
}
