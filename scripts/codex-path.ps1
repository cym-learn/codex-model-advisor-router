function Resolve-CodexExecutable([string]$CurrentPath) {
    if ($CurrentPath -and (Test-Path -LiteralPath $CurrentPath -PathType Leaf)) { return $CurrentPath }
    $command = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue
    if ($command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) { return [string]$command.Source }
    $desktopBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $desktopBin) {
        $candidate = Get-ChildItem -LiteralPath $desktopBin -Filter codex.exe -Recurse -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    throw 'Codex executable was not found; repair or reinstall Codex before starting the router'
}
