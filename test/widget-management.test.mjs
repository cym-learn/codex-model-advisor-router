import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('management shortcuts stay isolated and stale executable resolution preserves valid paths', {skip:process.platform!=='win32'},()=>{
 const scripts=fileURLToPath(new URL('../scripts/',import.meta.url)).replaceAll("'","''");
 const code=`$ErrorActionPreference='Stop'
. '${scripts}codex-path.ps1'
$area=Join-Path $env:TEMP ('advisor-management-test-'+[guid]::NewGuid())
New-Item -ItemType Directory $area | Out-Null
$valid=Join-Path $area 'codex.exe';Set-Content -LiteralPath $valid -Value 'fixture'
if((Resolve-CodexExecutable $valid) -ne $valid){throw 'Valid executable was replaced'}
function Get-Command {param($Name,$CommandType,$ErrorAction) [pscustomobject]@{Source=$valid} }
if((Resolve-CodexExecutable (Join-Path $area 'missing.exe')) -ne $valid){throw 'Stale path not repaired'}
# Extract only the three shortcut functions; do not execute management actions.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${scripts}manage.ps1',[ref]$tokens,[ref]$errors)
if($errors){throw 'Management parse error'}
foreach($name in @('Get-ShortcutDirectory','Install-Shortcuts','Remove-Shortcuts')) {
 $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 Invoke-Expression $node.Extent.Text
}
$DataRoot=$area;$defaultDataRoot='unrelated';$installRoot=Join-Path $area 'codex-model-advisor-router'
New-Item -ItemType Directory $installRoot | Out-Null
Install-Shortcuts
$directory=Get-ShortcutDirectory
if(-not $directory.StartsWith($area)){throw 'Shortcuts escaped isolation'}
$shell=New-Object -ComObject WScript.Shell
foreach($name in @('Model Advisor','Settings','Uninstall')) {
 $file=Join-Path $directory ($name+'.lnk');if(-not(Test-Path -LiteralPath $file)){throw 'Shortcut missing'}
 $link=$shell.CreateShortcut($file)
 if(-not $link.Arguments.Contains($area) -or -not $link.Arguments.Contains('-WindowStyle Hidden')){throw 'Shortcut arguments lost isolation'}
 [void][Runtime.InteropServices.Marshal]::ReleaseComObject($link)
}
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
Remove-Shortcuts
if(Test-Path -LiteralPath $directory){throw 'Shortcut cleanup failed'}
Write-Output 'WIDGET_MANAGEMENT_OK'
`;
 assert.match(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8'}),/WIDGET_MANAGEMENT_OK/);
});
