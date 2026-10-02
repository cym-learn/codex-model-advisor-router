param(
    [ValidateSet('Install', 'Update', 'Restart', 'Enable', 'Disable', 'Status', 'Uninstall', 'ShowWidget', 'HideWidget', 'ExitWidget', 'ResetWidget', 'ShowSettings', 'ShowStatusPage', 'JevStatus', 'JevShadow', 'JevOff', 'RoutingStatus', 'RoutingMode', 'EvaluationStatus', 'EvaluationRegister', 'EvaluationOff')]
    [string]$Action = 'Status',
    [string]$SourceDir = (Split-Path -Parent $PSScriptRoot),
    [string[]]$ThreadId,
    [string]$EvaluationManifest,
    [ValidateSet('rules','shadow','auto')][string]$Mode = 'rules',
    [switch]$ConsentToSendTaskText,
    [string]$DataRoot = (Join-Path $HOME '.codex'),
    [ValidateRange(1024,65535)][int]$ListenPort = 18765
)
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'widget-control.ps1')
. (Join-Path $PSScriptRoot 'codex-path.ps1')
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$defaultDataRoot = [IO.Path]::GetFullPath((Join-Path $HOME '.codex'))
$validationRoot = if ($DataRoot -eq $defaultDataRoot) { $HOME } else { $DataRoot }
$installRoot = Join-Path $DataRoot 'codex-model-advisor-router'
$configPath = Join-Path $DataRoot 'config.toml'
$taskName = 'CodexModelAdvisorRouter'
$port = $ListenPort
if ($DataRoot -ne $defaultDataRoot) {
    $taskDigest = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($DataRoot.ToLowerInvariant()))
    $taskSuffix = ([BitConverter]::ToString($taskDigest) -replace '-','').Substring(0,12)
    $taskName += '-' + $taskSuffix
}
if (Test-Path -LiteralPath (Join-Path $installRoot 'state.json')) {
    $port = (Get-Content -LiteralPath (Join-Path $installRoot 'state.json') -Raw -Encoding UTF8 | ConvertFrom-Json).port
}

function Assert-Within([string]$path, [string]$root) {
    $resolvedPath = [System.IO.Path]::GetFullPath($path)
    $resolvedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing filesystem action outside $root"
    }
}

function Get-SkillPath {
    if ($DataRoot -ne $defaultDataRoot) { return Join-Path $DataRoot 'skills\codex-model-advisor' }
    $legacy = Join-Path $HOME '.codex\skills\codex-model-advisor'
    if (Test-Path -LiteralPath $legacy) { return $legacy }
    return Join-Path $HOME '.agents\skills\codex-model-advisor'
}

function Get-State {
    $path = Join-Path $installRoot 'state.json'
    if (-not (Test-Path -LiteralPath $path)) { throw 'Router is not installed' }
    return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-NodePath { return Join-Path $installRoot 'runtime\node.exe' }

function Assert-Runtime([string]$directory) {
    $binary = Join-Path $directory 'node.exe'
    $checksum = Join-Path $directory 'node.sha256'
    if (Test-Path -LiteralPath $checksum) {
        $expected = (Get-Content -LiteralPath $checksum -Raw -Encoding ASCII).Trim()
        if ($expected -notmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $expected) { throw 'Bundled runtime checksum mismatch' }
    }
    & $binary --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; if(typeof DatabaseSync !== 'function') process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Bundled runtime requires built-in SQLite (Node 24)' }
}

function Test-Health {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
        return ($health.ok -eq $true -and $health.availablePairs -gt 0)
    } catch { return $false }
}

function Stop-Router {
    $pidFile = Join-Path $installRoot 'router.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { return }
    $routerPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$routerPid" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -and $process.CommandLine.Contains((Join-Path $installRoot 'src\proxy.mjs'))) {
        $native = Get-Process -Id $routerPid -ErrorAction SilentlyContinue
        Stop-Process -Id $routerPid -Force
        if ($native) { [void]$native.WaitForExit(5000) }
    }
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}

function Stop-Widget {
    $pidFile = Join-Path $installRoot 'widget.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { return }
    $widgetPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$widgetPid" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -and $process.CommandLine.Contains((Join-Path $installRoot 'scripts\widget.ps1'))) {
        # Signal orderly exit so hidden windows also save preferences.
        $native = Get-Process -Id $widgetPid -ErrorAction SilentlyContinue
        if ($native) {
            $signalled = $false
            if (Get-Command Send-WidgetCommand -CommandType Function -ErrorAction SilentlyContinue) { $signalled = Send-WidgetCommand $installRoot Exit }
            # Legacy widgets have no event channel; retain their graceful close path.
            if (-not $signalled) { [void]$native.CloseMainWindow() }
            [void]$native.WaitForExit(2000)
        }
        if (Get-Process -Id $widgetPid -ErrorAction SilentlyContinue) {
            try { Stop-Process -Id $widgetPid -Force -ErrorAction Stop }
            catch { if (Get-Process -Id $widgetPid -ErrorAction SilentlyContinue) { throw } }
        }
    }
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}

function Show-Widget {
    $launcher = Join-Path $installRoot 'scripts\widget.ps1'
    if (-not (Test-Path -LiteralPath $launcher)) { throw 'Widget is not installed' }
    if (Send-WidgetCommand $installRoot Show) { return }
    $widgetProcess = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList "-NoProfile -STA -ExecutionPolicy Bypass -File `"$launcher`"" -PassThru -RedirectStandardError (Join-Path $installRoot 'widget-launch-error.log')
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 100
        if (Send-WidgetCommand $installRoot Show) { return }
        if ($widgetProcess.HasExited) { throw 'Widget process exited before its control channel became available' }
    }
    throw 'Widget control channel did not become available'
}

function Get-ShortcutDirectory {
    if ($DataRoot -ne $defaultDataRoot) { return Join-Path $DataRoot 'shortcuts\Codex Model Advisor' }
    return Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Model Advisor'
}
function Install-Shortcuts {
    $directory = Get-ShortcutDirectory
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($entry in @(@('Model Advisor','ShowWidget'),@('Settings','ShowSettings'),@('Uninstall','Uninstall'))) {
            $shortcut = $shell.CreateShortcut((Join-Path $directory ($entry[0]+'.lnk')))
            $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
            $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $installRoot 'scripts\manage.ps1')`" -Action $($entry[1]) -DataRoot `"$DataRoot`""
            $shortcut.WorkingDirectory = $installRoot; $shortcut.Save()
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
        }
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}
function Remove-Shortcuts {
    $directory = Get-ShortcutDirectory
    foreach ($name in @('Model Advisor','Settings','Uninstall')) {
        $file = Join-Path $directory ($name+'.lnk')
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
    if ((Test-Path -LiteralPath $directory) -and -not @(Get-ChildItem -LiteralPath $directory).Count) { Remove-Item -LiteralPath $directory }
}

function Assert-Idle {
    if (-not (Test-Health)) { return }
    $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" -TimeoutSec 3
    if ($snapshot.activeRequests -gt 0) { throw 'Router has active requests; finish or cancel them before update/disable/uninstall.' }
    if ($snapshot.jev.pending -gt 0) { throw 'Jev has pending requests; wait before update/disable/uninstall.' }
    if ($snapshot.routing.pending -gt 0) { throw 'Jev routing has pending requests; wait before management changes.' }
    if ($snapshot.evaluation.pending -gt 0) { throw 'Controlled evaluation has pending requests; wait before update/disable/uninstall.' }
    $busy = @($snapshot.turns.requests | Where-Object { $_.runId -eq $snapshot.runId -and $_.state -in @('pending','executing') })
    if ($busy.Count) { throw 'Router has active requests; finish or cancel them before update/disable/uninstall.' }
}

function Disable-Router {
    Assert-Idle
    if (Test-Path -LiteralPath (Get-NodePath)) {
        & (Get-NodePath) (Join-Path $installRoot 'scripts\config-cli.mjs') disable $configPath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not restore Codex configuration' }
    }
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    }
    Stop-Router
    Stop-Widget
}

function Enable-Router {
    $state = Get-State
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { throw 'Router scheduled task is missing' }
    $alreadyManaged = (Test-Path -LiteralPath $configPath) -and
        ((Get-Content -LiteralPath $configPath -Raw) -match '# BEGIN codex-model-advisor-router\r?\n')
    if ($alreadyManaged -and (Test-Health)) { Write-Output 'Router is already enabled.'; return }
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    $healthy = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if ($attempt % 5 -eq 0 -and (Get-ScheduledTask -TaskName $taskName).State -ne 'Running') {
            Start-ScheduledTask -TaskName $taskName
        }
        if (Test-Health) { $healthy = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) {
        $result = (Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult
        throw "Router did not become healthy (task result $result); Codex config was not changed"
    }
    $url = "http://127.0.0.1:$port/v1"
    if (-not $alreadyManaged) {
        & (Get-NodePath) (Join-Path $installRoot 'scripts\config-cli.mjs') enable $configPath $url (Join-Path $installRoot 'backups') | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not enable Codex provider' }
    }
    Write-Output "Enabled: $($state.baseline.model)/$($state.baseline.effort) baseline; Desktop tasks use catalog-supported Astra/Sol/Luna and five effort levels. Status: http://127.0.0.1:$port/"
}

switch ($Action) {
    'EvaluationStatus' {
        & (Get-NodePath) (Join-Path $installRoot 'scripts\evaluation-cli.mjs') status $installRoot
        if ($LASTEXITCODE -ne 0) { throw 'Evaluation status failed' }
    }
    'EvaluationRegister' {
        Assert-Idle
        & (Get-NodePath) (Join-Path $installRoot 'scripts\evaluation-cli.mjs') register $installRoot $EvaluationManifest
        if ($LASTEXITCODE -ne 0) { throw 'Evaluation registration failed' }
    }
    'EvaluationOff' {
        Assert-Idle
        & (Get-NodePath) (Join-Path $installRoot 'scripts\evaluation-cli.mjs') off $installRoot
        if ($LASTEXITCODE -ne 0) { throw 'Evaluation shutdown failed' }
    }
    'RoutingStatus' {
        & (Get-NodePath) (Join-Path $installRoot 'scripts\routing-cli.mjs') status $installRoot
        if ($LASTEXITCODE -ne 0) { throw 'Routing status failed' }
    }
    'RoutingMode' {
        Assert-Idle
        $consentArgument = if ($ConsentToSendTaskText) { '--consent-to-send-task-text' } else { '--no-consent' }
        & (Get-NodePath) (Join-Path $installRoot 'scripts\routing-cli.mjs') set $installRoot $Mode $consentArgument
        if ($LASTEXITCODE -ne 0) { throw 'Routing mode change failed' }
    }
    'JevStatus' {
        & (Get-NodePath) (Join-Path $installRoot 'scripts\jev-cli.mjs') status $installRoot
        if ($LASTEXITCODE -ne 0) { throw 'Jev status failed' }
    }
    'JevShadow' {
        Assert-Idle
        & (Get-NodePath) (Join-Path $installRoot 'scripts\jev-cli.mjs') shadow $installRoot @ThreadId
        if ($LASTEXITCODE -ne 0) { throw 'Jev shadow registration failed' }
    }
    'JevOff' {
        Assert-Idle
        & (Get-NodePath) (Join-Path $installRoot 'scripts\jev-cli.mjs') off $installRoot
        if ($LASTEXITCODE -ne 0) { throw 'Jev disable failed' }
    }
    'ShowWidget' { Show-Widget; Write-Output 'Widget opened; duplicate launches keep a single instance.' }
    'HideWidget' { [void](Send-WidgetCommand $installRoot Hide); Write-Output 'Widget hide requested; router is unchanged.' }
    'ExitWidget' { Stop-Widget; Write-Output 'Widget exited; router is unchanged.' }
    'ResetWidget' {
        if (-not (Send-WidgetCommand $installRoot Reset)) {
            $preferences = Join-Path $installRoot 'widget-state.json'
            if (Test-Path -LiteralPath $preferences) {
                $saved = Get-Content -LiteralPath $preferences -Raw -Encoding UTF8 | ConvertFrom-Json
                foreach ($field in @('left','top','sizes')) { $saved.PSObject.Properties.Remove($field) }
                $saved | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $preferences -Encoding UTF8
            }
            Show-Widget
        }
    }
    'ShowSettings' { Start-Process "http://127.0.0.1:$port/settings" }
    'ShowStatusPage' { Start-Process "http://127.0.0.1:$port/" }
    'Update' {
        $state = Get-State
        $resolvedSource = [IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
        if ($resolvedSource -eq [IO.Path]::GetFullPath($installRoot).TrimEnd('\')) { throw 'Update source must differ from the installation' }
        foreach ($name in @('src','scripts','skills','package.json')) {
            if (-not (Test-Path -LiteralPath (Join-Path $resolvedSource $name))) { throw "Update source is missing $name" }
        }
        & (Get-NodePath) --check (Join-Path $resolvedSource 'src\proxy.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Update source did not pass syntax validation' }
        if (Test-Path -LiteralPath (Join-Path $resolvedSource 'runtime')) { Assert-Runtime (Join-Path $resolvedSource 'runtime') }
        $sourceBinary = Join-Path $resolvedSource 'runtime\node.exe'
        if ((Test-Path -LiteralPath $sourceBinary) -and (Get-FileHash $sourceBinary).Hash -ne (Get-FileHash (Get-NodePath)).Hash) {
            $routerPidFile = Join-Path $installRoot 'router.pid'
            $ownedRouterPid = if (Test-Path -LiteralPath $routerPidFile) { [int](Get-Content -LiteralPath $routerPidFile -Raw) } else { -1 }
            $otherUsers = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq (Get-NodePath) -and $_.ProcessId -ne $ownedRouterPid })
            if ($otherUsers.Count) { throw 'Bundled runtime is in use by another process; close it before updating the runtime.' }
        }
        Assert-Idle
        $wasEnabled = (Get-ScheduledTask -TaskName $taskName).Settings.Enabled
        $backup = Join-Path $installRoot ('backups\update-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        Assert-Within $backup $installRoot
        New-Item -ItemType Directory -Path $backup | Out-Null
        foreach ($name in @('src','scripts','skills','runtime','package.json')) { Copy-Item -LiteralPath (Join-Path $installRoot $name) -Destination (Join-Path $backup $name) -Recurse }
        foreach ($name in @('docs','README.md','README.en.md','PRIVACY.md','EVALUATION.md','THIRD_PARTY_NOTICES.md','LICENSE','routing-policy.json','VALIDATION-0.6.0.md','OUTCOMES-0.6.0.md','EVALUATION-0.7.0.md','PROMPT-AUDIT-0.7.0.md','VALIDATION-0.7.0.md','OUTCOMES-0.7.0.md','RESULTS-0.7.0.zh-CN.md')) { if (Test-Path -LiteralPath (Join-Path $installRoot $name)) { Copy-Item -LiteralPath (Join-Path $installRoot $name) -Destination (Join-Path $backup $name) -Recurse } }
        $state.skillPath | Set-Content -LiteralPath (Join-Path $backup 'skill-path.txt') -Encoding UTF8
        Copy-Item -LiteralPath $state.skillPath -Destination (Join-Path $backup 'active-skill') -Recurse
        if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination (Join-Path $backup 'config-reference.toml') }
        Write-Output "Backup: $backup"
        # Backups take time: a newly arrived model call must still prevent stopping the service.
        Assert-Idle
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Stop-Router; Stop-Widget
        function Copy-Version([string]$from) {
            foreach ($name in @('src','scripts','skills')) {
                $destination = Join-Path $installRoot $name
                Assert-Within $destination $installRoot
                Remove-Item -LiteralPath $destination -Recurse -Force
                Copy-Item -LiteralPath (Join-Path $from $name) -Destination $destination -Recurse
            }
            Copy-Item -LiteralPath (Join-Path $from 'package.json') -Destination (Join-Path $installRoot 'package.json') -Force
            foreach ($name in @('docs','README.md','README.en.md','PRIVACY.md','EVALUATION.md','THIRD_PARTY_NOTICES.md','LICENSE','routing-policy.json','VALIDATION-0.6.0.md','OUTCOMES-0.6.0.md','EVALUATION-0.7.0.md','PROMPT-AUDIT-0.7.0.md','VALIDATION-0.7.0.md','OUTCOMES-0.7.0.md','RESULTS-0.7.0.zh-CN.md')) {
                if ($name -eq 'docs' -and (Test-Path -LiteralPath (Join-Path $installRoot $name))) {
                    Assert-Within (Join-Path $installRoot $name) $installRoot
                    Remove-Item -LiteralPath (Join-Path $installRoot $name) -Recurse -Force
                }
                if (Test-Path -LiteralPath (Join-Path $from $name)) { Copy-Item -LiteralPath (Join-Path $from $name) -Destination (Join-Path $installRoot $name) -Recurse -Force }
            }
            if (Test-Path -LiteralPath (Join-Path $from 'runtime')) {
                Get-ChildItem -LiteralPath (Join-Path $from 'runtime') | ForEach-Object {
                    $destination = Join-Path $installRoot ('runtime\' + $_.Name)
                    if (-not (Test-Path -LiteralPath $destination) -or $_.PSIsContainer -or (Get-FileHash -LiteralPath $_.FullName).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) {
                        Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
                    }
                }
            }
        }
        try {
            Copy-Version $resolvedSource
            Assert-Within ([string]$state.skillPath) $validationRoot
            Remove-Item -LiteralPath $state.skillPath -Recurse -Force
            Copy-Item -LiteralPath (Join-Path $installRoot 'skills\codex-model-advisor') -Destination $state.skillPath -Recurse
            if ($wasEnabled) {
                Start-ScheduledTask -TaskName $taskName
                $healthy=$false
                for ($attempt=0; $attempt -lt 50; $attempt++) { Start-Sleep -Milliseconds 500; if (Test-Health) {$healthy=$true;break} }
                if (-not $healthy) { throw 'Updated router failed health check' }
            }
            Install-Shortcuts
            Write-Output 'Updated. User configuration, history and widget preferences retained.'
        } catch {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
            Stop-Router; Stop-Widget
            Copy-Version $backup
            Assert-Within ([string]$state.skillPath) $validationRoot
            if (Test-Path -LiteralPath $state.skillPath) { Remove-Item -LiteralPath $state.skillPath -Recurse -Force }
            Copy-Item -LiteralPath (Join-Path $backup 'active-skill') -Destination $state.skillPath -Recurse
            if ($wasEnabled) { Start-ScheduledTask -TaskName $taskName }
            throw
        }
    }
    'Install' {
        if (Test-Path -LiteralPath $installRoot) { throw "Installation already exists: $installRoot" }
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "Scheduled task already exists: $taskName" }
        $sourceNode = Join-Path $packageRoot 'runtime\node.exe'
        if (-not (Test-Path -LiteralPath $sourceNode)) { throw 'Use the Windows release package containing runtime\node.exe' }
        Assert-Runtime (Join-Path $packageRoot 'runtime')
        $skillPath = Get-SkillPath
        $skillParent = Split-Path -Parent $skillPath
        $codexPath = Resolve-CodexExecutable ''
        Assert-Within $installRoot $validationRoot
        Assert-Within $skillPath $validationRoot
        $skillReplaced = $false
        try {
            New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
            foreach ($name in @('src', 'scripts', 'skills', 'runtime')) {
                Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination (Join-Path $installRoot $name) -Recurse
            }
            Copy-Item -LiteralPath (Join-Path $packageRoot 'package.json') -Destination (Join-Path $installRoot 'package.json')
            foreach ($name in @('docs','README.md','README.en.md','PRIVACY.md','EVALUATION.md','THIRD_PARTY_NOTICES.md','LICENSE','routing-policy.json','VALIDATION-0.6.0.md','OUTCOMES-0.6.0.md','EVALUATION-0.7.0.md','PROMPT-AUDIT-0.7.0.md','VALIDATION-0.7.0.md','OUTCOMES-0.7.0.md','RESULTS-0.7.0.zh-CN.md')) { if (Test-Path -LiteralPath (Join-Path $packageRoot $name)) { Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination (Join-Path $installRoot $name) -Recurse } }
            $baselineJson = & (Get-NodePath) (Join-Path $installRoot 'scripts\baseline.mjs') $configPath $codexPath
            if ($LASTEXITCODE -ne 0) { throw 'Could not discover a valid baseline model and effort' }
            $baseline = $baselineJson | ConvertFrom-Json
            @{ port = $port; baseline = $baseline; skillPath = $skillPath; codexPath = $codexPath; isolated = ($DataRoot -ne $defaultDataRoot); metadataHome = $DataRoot } |
                ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $installRoot 'state.json') -Encoding UTF8
            New-Item -ItemType Directory -Path $skillParent -Force | Out-Null
            if (Test-Path -LiteralPath $skillPath) {
                Move-Item -LiteralPath $skillPath -Destination (Join-Path $installRoot 'previous-skill')
                $skillReplaced = $true
            }
            Copy-Item -LiteralPath (Join-Path $installRoot 'skills\codex-model-advisor') -Destination $skillPath -Recurse
            $skillReplaced = $true
            $launcher = Join-Path $installRoot 'scripts\run.ps1'
            $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
            $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
            $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $principal | Out-Null
            Enable-Router
            Install-Shortcuts
            Write-Output "Installed in $installRoot"
        } catch {
            try { Disable-Router } catch {}
            Remove-Shortcuts
            if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            }
            if ($skillReplaced -and (Test-Path -LiteralPath $skillPath)) { Remove-Item -LiteralPath $skillPath -Recurse -Force }
            $previous = Join-Path $installRoot 'previous-skill'
            if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $skillPath }
            if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
            throw
        }
    }
    'Restart' {
        Assert-Idle
        if (-not (Get-ScheduledTask -TaskName $taskName).Settings.Enabled) { throw 'Router is disabled; enable it before restarting.' }
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Stop-Router; Stop-Widget
        Start-ScheduledTask -TaskName $taskName
        $healthy = $false
        for ($attempt=0; $attempt -lt 50; $attempt++) { Start-Sleep -Milliseconds 500; if (Test-Health) { $healthy=$true; break } }
        if (-not $healthy) { throw 'Restarted router did not become healthy; inspect status before continuing.' }
        Write-Output 'Restarted. User configuration and persisted choices retained.'
    }
    'Enable' { Enable-Router }
    'Disable' { Disable-Router; Write-Output 'Router disabled; original Codex provider restored.' }
    'Status' {
        $installed = Test-Path -LiteralPath (Join-Path $installRoot 'state.json')
        $managed = (Test-Path -LiteralPath $configPath) -and ((Get-Content -LiteralPath $configPath -Raw) -match '# BEGIN codex-model-advisor-router')
        [pscustomobject]@{ Installed = $installed; Enabled = $managed; Healthy = (Test-Health); InstallPath = $installRoot }
    }
    'Uninstall' {
        $state = Get-State
        Disable-Router
        Remove-Shortcuts
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        $skillPath = [string]$state.skillPath
        Assert-Within $skillPath $validationRoot
        Assert-Within $installRoot $validationRoot
        if (Test-Path -LiteralPath $skillPath) { Remove-Item -LiteralPath $skillPath -Recurse -Force }
        $previous = Join-Path $installRoot 'previous-skill'
        if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $skillPath }
        Remove-Item -LiteralPath $installRoot -Recurse -Force
        Write-Output 'Uninstalled; previous skill and Codex provider restored.'
    }
}
