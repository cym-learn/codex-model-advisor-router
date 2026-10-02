param([string]$InstallDir = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$state = Get-Content -LiteralPath (Join-Path $InstallDir 'state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$env:ROUTER_PORT = [string]$state.port
$env:ROUTER_LOG = Join-Path $InstallDir 'events.jsonl'
$env:ROUTER_PID_PATH = Join-Path $InstallDir 'router.pid'
$env:ROUTER_BASELINE_MODEL = [string]$state.baseline.model
$env:ROUTER_BASELINE_EFFORT = [string]$state.baseline.effort
. (Join-Path $PSScriptRoot 'codex-path.ps1')
$env:ROUTER_CODEX_PATH = Resolve-CodexExecutable ([string]$state.codexPath)
if ($state.codexPath -ne $env:ROUTER_CODEX_PATH) {
    $state.codexPath = $env:ROUTER_CODEX_PATH
    $state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $InstallDir 'state.json') -Encoding UTF8
}
$target = [Uri]'https://chatgpt.com/backend-api/codex/models'
$systemProxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($target)
if ($systemProxy.AbsoluteUri -ne $target.AbsoluteUri) {
    $env:HTTPS_PROXY = $systemProxy.AbsoluteUri
    $env:HTTP_PROXY = $systemProxy.AbsoluteUri
    $env:NODE_USE_ENV_PROXY = '1'
}
$widget = Join-Path $InstallDir 'scripts\widget.ps1'
if (-not $state.isolated -and (Test-Path -LiteralPath $widget)) {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList "-NoProfile -STA -ExecutionPolicy Bypass -File `"$widget`"" | Out-Null
}
# A crashed controller leaves an offline display; management commands own cleanup.
$routerArguments = @((Join-Path $InstallDir 'src\proxy.mjs'))
if ($state.isolated) {
    $isolatedHome = if ($state.PSObject.Properties.Name -contains 'metadataHome') { [string]$state.metadataHome } else { Split-Path -Parent $InstallDir }
    $expectedHome = [IO.Path]::GetFullPath((Split-Path -Parent $InstallDir))
    if (-not $isolatedHome -or -not [IO.Path]::IsPathRooted($isolatedHome) -or [IO.Path]::GetFullPath($isolatedHome) -ne $expectedHome -or -not (Test-Path -LiteralPath $isolatedHome -PathType Container)) {
        throw 'Isolated metadata directory must equal the installation DataRoot'
    }
    $routerArguments += @('--metadata-home', $expectedHome)
}
& (Join-Path $InstallDir 'runtime\node.exe') @routerArguments
exit $LASTEXITCODE
