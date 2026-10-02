import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('isolated widget survives hide, duplicate launch awakens, reset and exit preserve preferences', {skip:process.platform!=='win32',timeout:40000},()=>{
  const scripts=fileURLToPath(new URL('../scripts/',import.meta.url)).replaceAll("'","''");
  const code=`$ErrorActionPreference='Stop'
. '${scripts}widget-control.ps1'
$bounds=Get-WidgetBounds 2000 2000 420 280 @(@{Left=0;Top=0;Right=1000;Bottom=800})
if($bounds.Left -ne 580 -or $bounds.Top -ne 520){throw 'Offscreen recovery failed'}
$gap=Get-WidgetBounds 1200 10 340 160 @(@{Left=0;Top=0;Right=1000;Bottom=800},@{Left=1600;Top=0;Right=2600;Bottom=800})
if($gap.Left -ne 660){throw 'Monitor gap recovery failed'}
$area=Join-Path $env:TEMP ('advisor-widget-test-'+[guid]::NewGuid())
New-Item -ItemType Directory $area | Out-Null
'{"port":19999}' | Set-Content -LiteralPath (Join-Path $area 'state.json')
'{"mode":"expanded","left":90000,"top":90000,"sizes":{"compact":{"width":370,"height":180},"expanded":{"width":460,"height":300}}}' | Set-Content -LiteralPath (Join-Path $area 'widget-state.json')
$args='-NoProfile -STA -ExecutionPolicy Bypass -File "${scripts}widget.ps1" -InstallDir "{0}"' -f $area
$process=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $args -PassThru -RedirectStandardError (Join-Path $area 'errors.log')
try {
 for($i=0;$i -lt 50;$i++){if(Test-Path -LiteralPath (Join-Path $area 'widget.pid')){break};Start-Sleep -Milliseconds 100}
 for($i=0;$i -lt 50;$i++){$process.Refresh();if($process.MainWindowHandle -ne 0){break};Start-Sleep -Milliseconds 100}
 if($process.MainWindowHandle -eq 0){throw 'Initial widget did not become visible'}
 if(-not(Send-WidgetCommand $area Hide)){throw 'Hide signal missing'}
 $saved=$false
 for($i=0;$i -lt 30;$i++){
  Start-Sleep -Milliseconds 100;$process.Refresh()
  try{$prefs=Get-Content -LiteralPath (Join-Path $area 'widget-state.json') -Raw|ConvertFrom-Json;$saved=$prefs.PSObject.Properties.Name -contains 'topmost'}catch{$saved=$false}
  # Startup also hides the window; wait for the Hide command to save preferences.
  if($process.MainWindowHandle -eq 0 -and $saved){break}
 }
 $process.Refresh();if($process.HasExited){throw 'Hide killed widget'}
 if($process.MainWindowHandle -ne 0){throw 'Hide left visible window'}
 if(-not $saved){throw 'Hide did not save preferences'}
 $prefs=Get-Content -LiteralPath (Join-Path $area 'widget-state.json') -Raw|ConvertFrom-Json
 if($prefs.sizes.expanded.width -ne 460 -or $prefs.sizes.compact.width -ne 370){throw 'Mode sizes lost'}
 if($prefs.left -gt 10000){throw 'Offscreen window not recovered'}
 $duplicate=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $args -PassThru
 if(-not $duplicate.WaitForExit(5000)){throw 'Duplicate instance stayed alive'}
 if([int](Get-Content -LiteralPath (Join-Path $area 'widget.pid')) -ne $process.Id){throw 'Duplicate replaced first instance'}
 Start-Sleep -Milliseconds 300;$process.Refresh();if($process.MainWindowHandle -eq 0){throw 'Duplicate did not awaken widget'}
 [void]$process.CloseMainWindow();Start-Sleep -Milliseconds 300;$process.Refresh();if($process.HasExited -or $process.MainWindowHandle -ne 0){throw 'Close did not hide to tray'}
 [void](Send-WidgetCommand $area Reset);Start-Sleep -Milliseconds 500
 $prefs=Get-Content -LiteralPath (Join-Path $area 'widget-state.json') -Raw|ConvertFrom-Json
 if($prefs.sizes.expanded.width -ne 300 -or $prefs.sizes.compact.width -ne 260){throw 'Reset did not restore both modes'}
 [void](Send-WidgetCommand $area Exit)
 if(-not $process.WaitForExit(5000)){throw 'Exit failed'}
 if(Test-Path -LiteralPath (Join-Path $area 'widget.pid')){throw 'Stale PID'}
 $errors=Get-Content -LiteralPath (Join-Path $area 'errors.log') -Raw
 if($errors){throw $errors}
 Write-Output 'WIDGET_LIFECYCLE_OK'
} finally {if(-not $process.HasExited){Stop-Process -Id $process.Id};Write-Output $area}
`;
  assert.match(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8',timeout:35000}),/WIDGET_LIFECYCLE_OK/);
});
