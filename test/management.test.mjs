import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('baseline uses an explicit executable without Codex on PATH and rejects an empty catalog', {skip:process.platform!=='win32'}, () => {
  const dir=mkdtempSync(join(tmpdir(),'advisor-baseline-'));
  const command=join(dir,'mock-codex.exe'),config=join(dir,'config.toml');
  const compiler=join(dir,'compile.ps1');
  const reply=JSON.stringify({id:2,result:{data:[{id:'gpt-6-sol',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}]}});
  writeFileSync(config,'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n');
  writeFileSync(compiler,`Add-Type -TypeDefinition @'\nusing System; public class MockCatalog { public static void Main() { string line; while((line=Console.ReadLine())!=null) { if(line.Contains("model/list")) { Console.WriteLine(Environment.GetEnvironmentVariable("ADVISOR_TEST_EMPTY_CATALOG")=="1" ? "{\\"id\\":2,\\"result\\":{\\"data\\":[]}}" : @"${reply.replaceAll('"','""')}"); return; } } } }\n'@ -OutputAssembly '${command.replaceAll("'","''")}' -OutputType ConsoleApplication`);
  try {
    execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',compiler],{stdio:'pipe'});
    const env={...process.env,PATH:process.env.SystemRoot+'\\System32',ROUTER_CODEX_PATH:join(dir,'missing.exe')};
    const args=[fileURLToPath(new URL('../scripts/baseline.mjs',import.meta.url)),config,command];
    assert.deepEqual(JSON.parse(execFileSync(process.execPath,args,{env,encoding:'utf8',stdio:'pipe'})),{model:'gpt-6-sol',effort:'high'});
    assert.throws(()=>execFileSync(process.execPath,args,{env:{...env,ADVISOR_TEST_EMPTY_CATALOG:'1'},stdio:'pipe'}),/No available Codex model/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('setup worker reports completion and failure without changing arguments or hiding the idle guard', {skip:process.platform!=='win32'}, () => {
  const dir=mkdtempSync(join(tmpdir(),'advisor-setup-'));
  const fake=join(dir,'manager.ps1'),check=join(dir,'check.ps1');
  const quote=s=>s.replaceAll("'","''");
  writeFileSync(fake,`param($Action,$DataRoot,$ListenPort)\nif($Action -eq 'Restart'){throw 'active requests'}\nif($DataRoot -ne '${quote(dir)}' -or $ListenPort -ne 19991){throw 'wrong target'}\n'completed'`);
  writeFileSync(check,`$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${quote(fileURLToPath(new URL('../scripts/setup-window.ps1',import.meta.url)))}',[ref]$null,[ref]$null)
foreach($name in @('Start-SetupOperation','Get-SetupErrorMessage')) {
 $f=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 Invoke-Expression $f.Extent.Text
}
foreach($action in @('Install','Restart')) {
 $op=Start-SetupOperation '${quote(fake)}' '${quote(dir)}' 19991 $action
 try {
  if(!$op.handle.AsyncWaitHandle.WaitOne(10000)){throw 'worker did not finish'}
  $result=@($op.worker.EndInvoke($op.handle))[-1]
  if($action -eq 'Install' -and !$result.ok){throw 'success lost'}
  if($action -eq 'Restart' -and ($result.ok -or $result.message -ne 'active requests')){throw 'failure hidden'}
  if(!(Test-Path -LiteralPath $op.log)){throw 'diagnostic missing'}
 } finally {$op.worker.Dispose();$op.runspace.Dispose()}
}
'SETUP_WORKER_OK'`);
  try {assert.match(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',check],{encoding:'utf8',stdio:'pipe'}),/SETUP_WORKER_OK/);}
  finally {rmSync(dir,{recursive:true,force:true});}
});

test('widget cleanup tolerates exit between lookup and stop but reports a process that remains alive', {skip:process.platform!=='win32'}, () => {
  const path=fileURLToPath(new URL('../scripts/manage.ps1',import.meta.url));
  const code=`$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'","''")}',[ref]$null,[ref]$null)
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-Widget'},$true)
Invoke-Expression $definition.Extent.Text
$installRoot=Join-Path ([IO.Path]::GetTempPath()) ('router-widget-stop-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $installRoot | Out-Null
function Get-CimInstance {return @{CommandLine=(Join-Path $installRoot 'scripts\\widget.ps1')}}
$native=New-Object PSObject
$native | Add-Member ScriptMethod CloseMainWindow {return $true}
$native | Add-Member ScriptMethod WaitForExit {return $false}
function Get-Process { $script:lookups++; if($script:remainAlive -or $script:lookups -le 2){return $native} }
function Stop-Process {throw 'process already exited or stop refused'}
try {
 $script:lookups=0;$script:remainAlive=$false
 '123' | Set-Content -LiteralPath (Join-Path $installRoot 'widget.pid') -Encoding ASCII
 Stop-Widget
 if(Test-Path -LiteralPath (Join-Path $installRoot 'widget.pid')){throw 'Stale widget pid retained'}
 $script:lookups=0;$script:remainAlive=$true
 '123' | Set-Content -LiteralPath (Join-Path $installRoot 'widget.pid') -Encoding ASCII
 $refused=$false;try{Stop-Widget}catch{$refused=$_.Exception.Message -match 'stop refused'}
 if(-not $refused){throw 'Live process cleanup failure was hidden'}
 Write-Output 'WIDGET_EXIT_RACE_OK'
} finally {
 $resolved=[IO.Path]::GetFullPath($installRoot);$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
 if(-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture path outside temp'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}`;
  assert.match(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8'}),/WIDGET_EXIT_RACE_OK/);
});
test('management refuses active requests even when recent-turn history omits them', {skip:process.platform!=='win32'}, () => {
  const path=fileURLToPath(new URL('../scripts/manage.ps1',import.meta.url));
  const code=`$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'","''")}',[ref]$null,[ref]$null)
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-Idle'},$true)
Invoke-Expression $definition.Extent.Text
function Test-Health {return $true}
function Invoke-RestMethod {return @{runId='r';activeRequests=1;turns=@()}}
$refused=$false;try{Assert-Idle}catch{$refused=$_.Exception.Message -match 'active requests'}
if(-not $refused){throw 'Active update was allowed'}
function Invoke-RestMethod {return @{runId='r';activeRequests=0;turns=@(@{requests=@(@{runId='r';state='executing'})})}}
$refused=$false;try{Assert-Idle}catch{$refused=$_.Exception.Message -match 'active requests'}
if(-not $refused){throw 'Legacy active update was allowed'}
function Invoke-RestMethod {return @{runId='r';activeRequests=0;turns=@()}}
function Invoke-RestMethod {return @{runId='r';activeRequests=0;jev=@{pending=1};turns=@()}}
$refused=$false;try{Assert-Idle}catch{$refused=$_.Exception.Message -match 'Jev has pending'}
if(-not $refused){throw 'Background Jev update was allowed'}
function Invoke-RestMethod {return @{runId='r';activeRequests=0;jev=@{pending=0};turns=@()}}
Assert-Idle
Write-Output 'IDLE_GUARD_OK'`;
  assert.match(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8'}),/IDLE_GUARD_OK/);
});

test('version copy skips a byte-identical runtime held open by another process', {skip:process.platform!=='win32'}, () => {
  const path=fileURLToPath(new URL('../scripts/manage.ps1',import.meta.url));
  const code=`$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'","''")}',[ref]$null,[ref]$null)
foreach($name in @('Assert-Within','Copy-Version')) {
 $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 Invoke-Expression $definition.Extent.Text
}
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('router-update-test-'+[guid]::NewGuid().ToString('N'))
$installRoot=Join-Path $fixtureRoot 'installed';$candidateRoot=Join-Path $fixtureRoot 'candidate'
$held=$null
try {
 foreach($root in @($installRoot,$candidateRoot)) {
  foreach($name in @('src','scripts','skills','runtime')){New-Item -ItemType Directory -Path (Join-Path $root $name) -Force | Out-Null}
  'same runtime bytes' | Set-Content -LiteralPath (Join-Path $root 'runtime\\node.exe') -Encoding ASCII
  '{}' | Set-Content -LiteralPath (Join-Path $root 'package.json') -Encoding ASCII
 }
 $held=[IO.File]::Open((Join-Path $installRoot 'runtime\\node.exe'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 Copy-Version $candidateRoot
 Write-Output 'LOCKED_IDENTICAL_RUNTIME_OK'
} finally {
 if($held){$held.Dispose()}
 Assert-Within $fixtureRoot ([IO.Path]::GetTempPath())
 if(Test-Path -LiteralPath $fixtureRoot){Remove-Item -LiteralPath $fixtureRoot -Recurse -Force}
}`;
  assert.match(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8'}),/LOCKED_IDENTICAL_RUNTIME_OK/);
});
