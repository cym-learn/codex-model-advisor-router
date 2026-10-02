import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {readJson,writeJson} from './local-state.mjs';
import {credentialPath} from './jev.mjs';
import {candidateVersions} from './jev-candidates.mjs';

export function setRoutingMode(directory,mode,consent,{keyPath=credentialPath}={}){
 if(!['rules','shadow','auto'].includes(mode))throw Error('Unknown routing mode');
 let current;try{current=readJson(join(directory,'routing-mode.json'));}catch{}
 const policy=mode==='rules'?(current?.policyVersion??'quality-first-v3a'):readJson(join(directory,'routing-policy.json')).policyVersion;
 if(!candidateVersions.includes(policy))throw Error('Routing policy unavailable');
 if(mode!=='rules'&&(consent!==true||!existsSync(keyPath)))throw Error('Configure the Jev key and explicitly consent to sending task context first');
 const config={version:1,mode,policyVersion:policy,...(mode!=='rules'?{consentToSendTaskText:true,consentedAt:new Date().toISOString()}:{})};
 writeJson(join(directory,'routing-mode.json'),config);writeJson(join(directory,'jev-config.json'),{version:1,mode:'off',threadIds:[]});return config;
}
