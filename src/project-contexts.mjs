import {existsSync,realpathSync,statSync} from 'node:fs';
import {join,win32,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readJson,writeJson,safeId} from './local-state.mjs';
import {projectBriefState083} from './research-083.mjs';

export function projectKey(path){
 if(typeof path!=='string'||!path.trim())return null;
 let p=path.trim().replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'');
 if(win32.isAbsolute(p)){const normalized=win32.normalize(p).toLowerCase();return /^[a-z]:\\$/.test(normalized)?normalized:normalized.replace(/[\\/]+$/,'');}
 if(p.startsWith('/'))return resolve(p).replace(/\/+$/,'');
 return null;
}
export function projectContexts(directory){
 const path=join(directory,'project-contexts.json');
 if(existsSync(path)){
  const d=readJson(path);if(d.version!==2||!Array.isArray(d.entries)||!d.entries.every(e=>['thread','project'].includes(e.scope)&&typeof e.target==='string'&&typeof e.text==='string'&&typeof e.enabled==='boolean'))throw Error('Invalid project context registry');
  return d;
 }
 const legacy=join(directory,'project-briefs.json');if(!existsSync(legacy))return {version:2,entries:[]};
 const d=readJson(legacy);if(d.version!==1||!Array.isArray(d.entries))throw Error('Invalid legacy summary registry');
 return {version:2,entries:d.entries.filter(e=>safeId(e.threadId)).map(e=>({...e,scope:'thread',target:e.threadId,revision:1,legacy:true}))};
}
export function updateProjectContext(directory,{action,scope,target,text,consent,originalTarget}){
 if(!['save','disable','delete'].includes(action)||!['thread','project'].includes(scope))throw Error('Invalid summary operation');
 if(scope==='thread'&&!safeId(target))throw Error('Invalid conversation ID');
 if(scope==='project'){
  const paths=typeof target==='string'?target.split(/\r?\n/).map(p=>p.trim()).filter(Boolean):[];
  if(!paths.length)throw Error('Choose an absolute project directory');
  target=[...new Set(paths.map(p=>{
   if(!projectKey(p))throw Error('Choose an absolute project directory');
   if(action==='save'){if(!statSync(p).isDirectory())throw Error('Project directory not found');p=realpathSync.native(p);}
   return projectKey(p);
  }))].join('\n');
 }
 const d=projectContexts(directory),identity=originalTarget??target,old=d.entries.find(e=>e.scope===scope&&e.target===identity);
 if(originalTarget!==undefined&&!old)throw Error('Summary changed; reload before editing');
 if(action==='save'&&d.entries.some(e=>e!==old&&e.scope===scope&&e.target===target))throw Error('Target already registered');
 if(scope==='project'&&action==='save'&&d.entries.some(e=>e.scope==='project'&&e!==old&&e.target.split('\n').some(p=>target.split('\n').includes(p))))throw Error('A directory already belongs to another summary; edit that entry first');
 if(action==='save'){
  text=typeof text==='string'?text.trim():'';
  if(consent!==true||!text||projectBriefState083({task:'',context:[]},text).skip)throw Error('Explicit consent and a valid summary of at most 2000 characters are required');
 }
 d.entries=d.entries.filter(e=>e!==old);
 if(action!=='delete')d.entries.push({scope,target,text:action==='save'?text:old?.text??'',enabled:action==='save',consentToSendSummary:action==='save',consentedAt:action==='save'?new Date().toISOString():old?.consentedAt??null,revision:(old?.revision??0)+1});
 writeJson(join(directory,'project-contexts.json'),d);return d;
}
export function resolveProjectContext(directory,threadId,cwd){
 try{
  const d=projectContexts(directory),key=projectKey(cwd);
  const thread=d.entries.find(e=>e.scope==='thread'&&e.target===threadId);
  const projects=key?d.entries.filter(e=>e.scope==='project').flatMap(e=>e.target.split('\n').filter(root=>key===root||key.startsWith(root+(root.endsWith('\\')||root.endsWith('/')?'':root.includes('\\')?'\\':'/'))).map(root=>({entry:e,root}))).sort((a,b)=>b.root.length-a.root.length):[];
  const e=thread??projects[0]?.entry;
  if(!e)return {enabled:false,reason:key?'summary_not_configured':'project_unknown'};
  if(!e.enabled||!e.consentToSendSummary)return {enabled:false,scope:e.scope,target:e.target,reason:'summary_disabled'};
  if(!e.text?.trim()||!Number.isFinite(Date.parse(e.consentedAt))||projectBriefState083({task:'',context:[]},e.text).skip)return {enabled:false,reason:'summary_invalid'};
  return {enabled:true,scope:e.scope,target:e.target,text:e.text,revision:e.revision??1,hash:createHash('sha256').update(e.legacy?e.text:JSON.stringify([e.scope,e.target,e.revision??1,e.text])).digest('hex'),reason:'summary_enabled'};
 }catch{return {enabled:false,reason:'summary_registry_unavailable'};}
}
// Only identifiers, display names and working directories; never messages or source files.
export function contextThreads(home,ids){
 if(!home)return [];let db;
 try{db=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
  const query=db.prepare('SELECT id,name,cwd FROM threads WHERE id=?');
  return [...new Set(ids.filter(safeId))].slice(0,100).flatMap(id=>{const r=query.get(id);return r?[{threadId:r.id,name:r.name??r.id,cwd:r.cwd}]:[];});
 }catch{return [];}finally{db?.close();}
}
