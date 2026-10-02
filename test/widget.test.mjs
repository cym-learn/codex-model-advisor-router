import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('Windows widget follows known main conversations, preserves lock, excludes tests/CLI/unknown and distinguishes evidence', {skip:process.platform!=='win32'}, () => {
  const path=fileURLToPath(new URL('../scripts/widget-view.ps1',import.meta.url));
  const code=`. '${path.replaceAll("'","''")}'
$pair=@{model='gpt-6-luna';effort='low'}
function Make-Group($id,$source,$time) {
 return @{rootThreadId=$id;displayName=$id;sourceKind=$source;latestAt=$time;turns=@(@{latestAt=$time;taskRole='main';finalReply=@{status='unconfirmed'};requests=@(@{runId='r';state='executing';planned=$pair;reported=$pair;verification='unconfirmed'})})}
}
$snapshot=@{schemaVersion=2;runId='r';conversations=@((Make-Group 'main-a' 'desktop' '1'),(Make-Group 'main-b' 'desktop' '2'),(Make-Group 'test' 'test' '9'),(Make-Group 'cli' 'cli' '9'),@{sourceKind='desktop';rootThreadId=$null;displayName=$null;latestAt='9';turns=@()})}
$follow=Get-WidgetView $snapshot ''; if($follow.Root -ne 'main-b'){throw 'Follow failed'}
$locked=Get-WidgetView $snapshot 'main-a'; if($locked.Root -ne 'main-a'){throw 'Lock failed'}
$test=Get-WidgetView $snapshot 'test'; if($test.Root -ne 'test'){throw 'Explicit test lock failed'}
$missing=Get-WidgetView $snapshot 'missing'; if($missing.Root){throw 'Missing lock stole another conversation'}
$snapshot.conversations[1].turns[0].requests[0].state='cancelled';if((Get-WidgetView $snapshot '').Status -notmatch '已取消'){throw 'Cancellation failed'}
$snapshot.conversations[1].turns[0].requests[0].state='finished';$snapshot.conversations[1].turns[0].finalReply=@{status='confirmed';pair=$pair};if((Get-WidgetView $snapshot '').Status -notmatch '最终回复完成确认'){throw 'Final attribution failed'}
$aux=Make-Group 'aux-only' 'desktop' '99';$aux.turns[0].isAuxiliary=$true
$snapshot.conversations += $aux
$newAux=@{latestAt='999';taskRole='main';isAuxiliary=$true;finalReply=@{status='unconfirmed'};requests=@(@{runId='r';state='executing';reported=@{model='gpt-5.6-luna';effort='low'}})}
$snapshot.conversations[0].turns += $newAux;$snapshot.conversations[0].latestAt='999'
if((Get-WidgetView $snapshot '').Root -ne 'main-b'){throw 'Auxiliary stole automatic following'}
if((Get-WidgetView $snapshot 'main-a').Pair -match '5.6'){throw 'Auxiliary replaced main reply'}
$snapshot.conversations[1].turns[0].jev=@{status='suggested';suggested=@{model='gpt-6-astra';effort='max'}}
$advised=Get-WidgetView $snapshot ''
if($advised.Pair -ne 'GPT-6 luna / low' -or $advised.Jev -notmatch 'astra/max.*未执行'){throw 'Jev suggestion replaced actual pair'}
$snapshot.conversations[1].turns[0].experiment=@{applied=$true;arm='jev';fallback=$null}
if((Get-WidgetView $snapshot '').Jev -notmatch '已用于试验请求'){throw 'Actual Jev trial labeled suggestion only'}
$snapshot.conversations[1].turns[0].experiment=@{applied=$false;arm='jev';fallback='timeout'}
if((Get-WidgetView $snapshot '').Jev -notmatch '退回.*timeout'){throw 'Trial fallback missing'}
Write-Output 'WIDGET_VIEW_OK'`;
  assert.match(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8'}),/WIDGET_VIEW_OK/);
});
