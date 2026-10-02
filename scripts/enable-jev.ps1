$ErrorActionPreference='Stop'
Write-Host 'Jev will receive the current task text and necessary recent context, up to 16000 characters, for eligible routed tasks through OpenCode Zen.'
Write-Host 'Read PRIVACY.md before enabling. Rules mode does not call Jev.'
$answer=Read-Host 'Type YES to consent and enable Jev automatic routing'
if ($answer -cne 'YES') { Write-Host 'No change made.'; exit }
& (Join-Path $PSScriptRoot 'manage.ps1') RoutingMode -Mode auto -ConsentToSendTaskText
