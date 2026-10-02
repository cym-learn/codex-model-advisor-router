import {resolveProjectContext,updateProjectContext} from '../src/project-contexts.mjs';
const [action,directory,threadId,summaryFile,consent]=process.argv.slice(2);
import {readFileSync} from 'node:fs';
try{
 if(!directory||!threadId||!['show','set','off'].includes(action))throw Error('Use show|set|off INSTALL_DIR THREAD_ID [SUMMARY_FILE --consent-to-send-summary]');
 if(action!=='show')updateProjectContext(directory,{action:action==='set'?'save':'disable',scope:'thread',target:threadId,text:action==='set'?readFileSync(summaryFile,'utf8').replace(/^\uFEFF/,''):undefined,consent:consent==='--consent-to-send-summary'});
 const current=resolveProjectContext(directory,threadId,null);console.log(JSON.stringify({threadId,enabled:current.enabled,hash:current.hash??null,...(action==='show'?{text:current.text??null}:{})}));
}catch(error){console.error(error.message);process.exitCode=1;}
