import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startRouter} from '../src/proxy.mjs';

test('settings opens a visible native password window without creating credentials', {skip:process.platform!=='win32',timeout:30000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'advisor-password-window-')),dir=join(home,'codex-model-advisor-router');mkdirSync(dir);
 cpSync(new URL('../scripts/',import.meta.url),join(dir,'scripts'),{recursive:true});
 const keyPath=join(home,'credentials','test.dpapi');
 const router=await startRouter({port:0,logPath:join(dir,'events.jsonl'),metadataHome:home,availablePairs:[{model:'gpt-6-sol',effort:'high'}],settingsOptions:{keyPath}});
 const base=`http://127.0.0.1:${router.port}`;
 const ps=code=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8',timeout:10000});
 const find=`Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${join(dir,'scripts','credential-window.ps1').replaceAll("'","''")}') }`;
 try{
  const {token}=await(await fetch(base+'/api/settings')).json();
  const r=await fetch(base+'/api/settings',{method:'POST',headers:{origin:base,'content-type':'application/json','x-advisor-token':token},body:JSON.stringify({action:'key-setup'})});
  assert.equal(r.status,200);assert.equal((await r.json()).launched,true);
  const handle=ps(`$p=@(${find}); if($p.Count -ne 1){throw 'Expected one password process'}; (Get-Process -Id $p[0].ProcessId).MainWindowHandle.ToInt64()`).trim();
  assert.notEqual(handle,'0');assert.equal(existsSync(keyPath),false);
 }finally{
  ps(`${find} | ForEach-Object { $p=Get-Process -Id $_.ProcessId; [void]$p.CloseMainWindow(); [void]$p.WaitForExit(3000) }`);
  await router.close();rmSync(home,{recursive:true,force:true});
 }
});

test('settings HTTP action starts a real widget and restores it after close', {skip:process.platform!=='win32',timeout:30000}, async()=>{
 const home=mkdtempSync(join(tmpdir(),'advisor-web-widget-')),dir=join(home,'codex-model-advisor-router');mkdirSync(dir);
 cpSync(new URL('../scripts/',import.meta.url),join(dir,'scripts'),{recursive:true});
 writeFileSync(join(dir,'state.json'),JSON.stringify({port:19999}));
 const router=await startRouter({port:0,logPath:join(dir,'events.jsonl'),metadataHome:home,availablePairs:[{model:'gpt-6-sol',effort:'high'}]});
 const base=`http://127.0.0.1:${router.port}`;
 const ps=code=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8',timeout:10000});
 let pid;
 try{
  const {token}=await(await fetch(base+'/api/settings')).json();
  const show=async()=>{const r=await fetch(base+'/api/settings',{method:'POST',headers:{origin:base,'content-type':'application/json','x-advisor-token':token},body:JSON.stringify({action:'show-widget'})});assert.equal(r.status,200);assert.equal((await r.json()).launched,true);await new Promise(r=>setTimeout(r,500));};
  await show();pid=Number(readFileSync(join(dir,'widget.pid'),'utf8').trim());
  assert.notEqual(ps(`(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`).trim(),'0');
  ps(`[void](Get-Process -Id ${pid}).CloseMainWindow(); Start-Sleep -Milliseconds 400`);
  assert.equal(ps(`(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`).trim(),'0');
  await show();assert.equal(Number(readFileSync(join(dir,'widget.pid'),'utf8').trim()),pid);
  assert.notEqual(ps(`(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`).trim(),'0');
 }finally{
  if(pid)ps(`. '${join(dir,'scripts','widget-control.ps1').replaceAll("'","''")}'; [void](Send-WidgetCommand '${dir.replaceAll("'","''")}' Exit); Start-Sleep -Milliseconds 500`);
  await router.close();rmSync(home,{recursive:true,force:true});
 }
});
