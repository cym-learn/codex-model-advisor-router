import {setRoutingMode} from '../src/routing-settings.mjs';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {readJson,writeJson} from '../src/local-state.mjs';
import {runtimeConfig} from '../src/jev-runtime.mjs';
import {candidateVersions} from '../src/jev-candidates.mjs';
import {credentialPath} from '../src/jev.mjs';
import {independentPolicy} from '../src/jev-independent.mjs';
const [action,directory,mode,consent]=process.argv.slice(2);
try{
 if(!directory||!['status','set'].includes(action))throw Error('Use status|set INSTALL_DIR [rules|shadow|auto] [--consent-to-send-task-text]');
 const path=join(directory,'routing-mode.json');
 if(action==='set'){
  setRoutingMode(directory,mode,consent==='--consent-to-send-task-text');
 }
 const c=runtimeConfig(path);console.log(JSON.stringify({mode:c.mode,policyVersion:c.policyVersion,fallbackPolicy:independentPolicy(c.policyVersion)?'incoming':'rules',scope:'eligible routed tasks only',inputCharacterLimit:16000,projectBriefDefault:'off',projectBriefScope:'consented project or thread; inspect in local settings'}));
}catch(error){console.error(error.message);process.exitCode=1;}
