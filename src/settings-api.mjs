import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {projectContexts,updateProjectContext,contextThreads,resolveProjectContext} from './project-contexts.mjs';
import {setRoutingMode} from './routing-settings.mjs';
import {runtimeConfig} from './jev-runtime.mjs';
import {credentialPath,loadCredential,askJev} from './jev.mjs';

export function launchLocalAction(directory,action,{keyPath=credentialPath}={}){
 const allowed={
  'key-setup':['-STA','-File',join(directory,'scripts','credential-window.ps1'),'-CredentialPath',keyPath],
  'show-widget':['-File',join(directory,'scripts','manage.ps1'),'-Action','ShowWidget','-DataRoot',dirname(directory)],
 };
 if(!Object.hasOwn(allowed,action))throw Error('Unknown local action');
 return new Promise((resolve,reject)=>{
  const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  const child=spawn(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass',...allowed[action]],{windowsHide:true,stdio:['ignore','pipe','ignore'],detached:false,env});
  child.once('error',()=>reject(Error('Cannot open the local window')));
  if(action==='show-widget'){
   let acknowledged=false;child.stdout.on('data',chunk=>{if(chunk.toString().includes('Widget opened;'))acknowledged=true;});
   const timer=setTimeout(()=>{child.kill();reject(Error('小窗启动超时，请通过快捷方式重试'));},10000);
   child.once('exit',code=>{clearTimeout(timer);child.stdout.destroy();if(code===0&&acknowledged)resolve({launched:true});else reject(Error('小窗启动失败，请通过快捷方式重试'));});
  }else{
   let ready=false,output='';
   const timer=setTimeout(()=>{child.kill();reject(Error('密钥窗口启动超时'));},10000);
   child.stdout.on('data',chunk=>{
    output=(output+chunk.toString()).slice(-128);
    if(!ready&&output.includes('ADVISOR_CREDENTIAL_WINDOW_READY')){ready=true;clearTimeout(timer);child.stdout.destroy();child.unref();resolve({launched:true});}
   });
   child.once('exit',()=>{clearTimeout(timer);if(!ready)reject(Error('密钥窗口未能显示'));});
  }
 });
}
export function settingsApi({directory,metadataHome,catalog,baseline,busy,threadIds,trial,onModeChange=()=>{},launch=launchLocalAction,keyPath=credentialPath,credentialLoader=loadCredential,fetchImpl}){
 const token=randomBytes(32).toString('hex');let checking=false;
 function send(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));}
 return async(req,res,url)=>{
  const paths=['/settings','/settings-client.js','/settings.css','/api/settings','/api/project-briefs'];
  if(!paths.includes(url.pathname))return false;
  const host=req.headers.host??'',address=req.socket.remoteAddress;
  if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)||req.headers['sec-fetch-site']==='cross-site'){send(res,403,{error:'local_only',message:'仅允许本机打开设置'});return true;}
  if(req.headers.origin&&req.headers.origin!==`http://${host}`){send(res,403,{error:'origin',message:'请求来源不匹配'});return true;}
  if(!url.pathname.startsWith('/api/')){
   if(req.method!=='GET'){send(res,405,{error:'method'});return true;}
   const name=url.pathname==='/settings'?'settings.html':url.pathname.slice(1);
   try{res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});res.end(readFileSync(fileURLToPath(new URL(name,import.meta.url))));}catch{if(!res.headersSent)res.writeHead(503);res.end();}return true;
  }
  if(req.method==='GET'&&url.pathname==='/api/settings'){
   try{const config=runtimeConfig(join(directory,'routing-mode.json')),threads=contextThreads(metadataHome,threadIds());
    send(res,200,{token,mode:config.mode,policyVersion:config.policyVersion,credentialConfigured:existsSync(keyPath),baseline,catalogCount:catalog().length,briefs:projectContexts(directory),threads:threads.map(t=>({...t,summary:resolveProjectContext(directory,t.threadId,t.cwd)})).map(t=>{const {text,...summary}=t.summary;return {...t,summary};}),trial:trial?.snapshot()??null,busy:busy()||checking});
   }catch{send(res,503,{error:'settings_unavailable',message:'本地配置无法读取，请先修复；未修改配置'});}return true;
  }
  if(req.method!=='POST'){send(res,405,{error:'method'});return true;}
  if(req.headers.origin!==`http://${host}`||req.headers['x-advisor-token']!==token||req.headers['content-type']?.split(';')[0]!=='application/json'){send(res,403,{error:'session',message:'请重新打开设置页面'});return true;}
  try{
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;chunks.push(chunk);if(bytes>16384){send(res,413,{error:'too_large',message:'请求过长'});return true;}}
   const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(busy()||checking){send(res,409,{error:'busy',message:'等待空闲：请在当前任务结束后重试'});return true;}
   if(url.pathname==='/api/project-briefs'){const value=updateProjectContext(directory,data);send(res,200,{ok:true,briefs:value,message:'项目背景已更新，下一轮生效'});return true;}
   if(data.action==='mode'){const config=setRoutingMode(directory,data.mode,data.consent,{keyPath});onModeChange();send(res,200,{ok:true,...config,message:'模式已更新'});return true;}
   if(['key-setup','show-widget'].includes(data.action)){send(res,200,await launch(directory,data.action,{keyPath}));return true;}
   if(data.action==='check-connection'){
    if(!existsSync(keyPath)||!catalog().length){send(res,400,{error:'not_ready',message:'请先配置密钥并确认模型目录可用'});return true;}
    const permit=trial?.reserveJev({id:randomUUID(),threadId:null,isConnectionCheck:true})??{allowed:true,tracked:false};
    if(!permit.allowed){send(res,429,{error:permit.reason,message:'本次试用预算或范围不允许继续连接检查'});return true;}
    checking=true;let result;
    try{const key=await credentialLoader(keyPath);result=key?await askJev({state:{task:'Rewrite a short internal notice clearly without adding facts.',context:[]},catalog:catalog(),key,policyVersion:'research-v5b-r10',fetchImpl,timeoutMs:5000}):{status:'failed',reason:'credential_unavailable'};}
    catch{result={status:'failed',reason:'connection_failed'};}
    finally{checking=false;}
    if(permit.tracked)trial.settleJev(permit.id,result);
    const connected=['suggested','abstained'].includes(result.status);send(res,connected?200:502,{connected,message:connected?'Jev 连接检查成功（一次独立请求）':'连接检查失败；未开启自动选型',reason:result.reason});return true;
   }
   send(res,400,{error:'action',message:'未知设置操作'});
  }catch{send(res,400,{error:'invalid_settings',message:'操作未完成：请检查路径、摘要、密钥及发送授权。已有配置未被替换为无效值。'});}
  return true;
 };
}
