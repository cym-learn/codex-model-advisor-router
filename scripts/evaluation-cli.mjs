import { join, resolve } from 'node:path';
import { readJson, writeJson, safeId } from '../src/local-state.mjs';
import { evaluationBudget } from '../src/experiment.mjs';
const [action,directory,manifestPath]=process.argv.slice(2),configPath=join(directory??'.','evaluation-config.json');
try{
  if(!directory||!['status','register','off'].includes(action))throw Error('Use status|register|off INSTALL_DIR [PRIVATE_MANIFEST]');
  if(action==='register'){
    const c=readJson(resolve(manifestPath));
    if(c.version!==1||!c.enabled||!Number.isFinite(Date.parse(c.expiresAt))||Date.parse(c.expiresAt)<=Date.now()||Date.parse(c.expiresAt)>Date.now()+2*60*60*1000||!Array.isArray(c.registrations)||!c.registrations.length||
      !c.registrations.every(r=>safeId(r.threadId)&&safeId(r.runId)&&['rule','jev'].includes(r.arm)&&(r.stage==='desktop'||r.stage==='reserve'&&(safeId(r.retestOf)||r.reserveReason==='desktop_retry_budget_reallocation'))&&/^[a-f0-9]{64}$/.test(r.taskHash)&&
        (r.taskHashVariants===undefined||Array.isArray(r.taskHashVariants)&&r.taskHashVariants.length<=2&&r.taskHashVariants.every(h=>/^[a-f0-9]{64}$/.test(h)))))throw Error('Explicit, expiring Desktop registration required.');
    const b=evaluationBudget(c.ledgerPath).snapshot();if(b.state!=='open')throw Error('New approved evaluation ledger unavailable.');
    writeJson(configPath,c);
  }else if(action==='off'){
    let c;try{c=readJson(configPath);}catch{c={version:1,registrations:[]};}c.enabled=false;writeJson(configPath,c);
  }
  let c;try{c=readJson(configPath);}catch{c={enabled:false,registrations:[]};}
  console.log(JSON.stringify({mode:c.enabled?'controlled':'off',registeredThreads:c.registrations.length,budget:c.ledgerPath?evaluationBudget(c.ledgerPath).snapshot():null}));
}catch(error){console.error(error.message);process.exitCode=1;}
