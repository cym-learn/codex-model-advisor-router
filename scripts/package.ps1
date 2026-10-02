param([string]$RuntimeDir, [string]$OutputDir, [switch]$StageOnly)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $OutputDir) { $OutputDir = Join-Path $root 'dist\release' }
$output = [IO.Path]::GetFullPath($OutputDir)
$manifest = Get-Content -LiteralPath (Join-Path $root 'release-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$lock = Get-Content -LiteralPath (Join-Path $root 'runtime-lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a numeric release version' }
$source = Join-Path $output 'source\codex-model-advisor-router'
$application = Join-Path $output 'application\codex-model-advisor-router'
$sourceZip = Join-Path $output "codex-model-advisor-router-$version-source.zip"
$windowsZip = Join-Path $output "codex-model-advisor-router-$version-windows-x64.zip"
foreach ($path in @($source,$application,$sourceZip,$windowsZip,(Join-Path $output 'SHA256SUMS.txt'))) {
    if (Test-Path -LiteralPath $path) { throw "Output already exists; use a new output directory: $path" }
}
$files = @($manifest.application) + @($manifest.sourceOnly)
if ($manifest.version -ne 1 -or -not $manifest.application.Count -or -not $manifest.sourceOnly.Count) { throw 'Invalid file manifest' }
if (@($files | Select-Object -Unique).Count -ne $files.Count) { throw 'Duplicate file manifest entries' }
foreach ($name in $files) {
    if ($name -notmatch '^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$' -or $name -match '(^|/)\.\.(/|$)') { throw 'Invalid manifest path' }
    $item = Get-Item -LiteralPath (Join-Path $root $name)
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Expected a regular file: $name" }
}
function Copy-ListedFiles([string]$destination, [array]$names) {
    foreach ($name in $names) {
        $target = Join-Path $destination $name
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $name) -Destination $target
    }
}
Copy-ListedFiles $source $files
if ($StageOnly) { Write-Output $source; return }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('advisor-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    Copy-ListedFiles $application @($manifest.application)
    $runtimeTarget = Join-Path $application 'runtime'
    New-Item -ItemType Directory -Path $runtimeTarget | Out-Null
    if ($RuntimeDir) {
        $runtime = [IO.Path]::GetFullPath($RuntimeDir)
        $info = Get-Content -LiteralPath (Join-Path $runtime 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($info.nodeVersion -ne $lock.nodeVersion -or $info.nodeArchiveSha256 -ne $lock.archiveSha256) { throw 'Runtime manifest does not match lock' }
        $binary = Join-Path $runtime 'node.exe'
        $license = Join-Path $runtime 'NODE_LICENSE'
    } else {
        $archive = Join-Path $temporary $lock.archive
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$($lock.nodeVersion)/$($lock.archive)" -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $lock.archiveSha256) { throw 'Node archive hash mismatch' }
        $unpacked = Join-Path $temporary 'unpacked'
        Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
        $runtime = Join-Path $unpacked ([IO.Path]::GetFileNameWithoutExtension($lock.archive))
        $binary = Join-Path $runtime 'node.exe'
        $license = Join-Path $runtime 'LICENSE'
    }
    if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $lock.binarySha256) { throw 'Node executable hash mismatch' }
    if (-not (Test-Path -LiteralPath $license -PathType Leaf)) { throw 'Node license missing' }
    & $binary --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; if(typeof DatabaseSync !== 'function') process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Runtime does not support built-in SQLite' }
    Copy-Item -LiteralPath $binary -Destination (Join-Path $runtimeTarget 'node.exe')
    Copy-Item -LiteralPath $license -Destination (Join-Path $runtimeTarget 'NODE_LICENSE')
    @{nodeVersion=$lock.nodeVersion;nodeArchiveSha256=$lock.archiveSha256} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeTarget 'manifest.json') -Encoding UTF8
    $lock.binarySha256 | Set-Content -LiteralPath (Join-Path $runtimeTarget 'node.sha256') -Encoding ASCII
    Compress-Archive -LiteralPath $source -DestinationPath $sourceZip
    Compress-Archive -LiteralPath $application -DestinationPath $windowsZip
    $sums = foreach ($path in @($sourceZip,$windowsZip)) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($path) }
    $sums | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ASCII
    Write-Output $sourceZip
    Write-Output $windowsZip
} finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected temporary path' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
