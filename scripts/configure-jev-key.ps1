param(
    [string]$CredentialPath = (Join-Path $env:USERPROFILE '.codex\credentials\codex-model-advisor\opencode-jev.dpapi'),
    [switch]$FunctionsOnly
)
$ErrorActionPreference = 'Stop'

function Save-JevKey([Security.SecureString]$Key, [string]$Path) {
    $pointer = [IntPtr]::Zero
    $plain = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Key)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($plain -notmatch '^oc_sk_[A-Za-z0-9_-]{16,}$' -or $plain.Length -gt 2048) {
            throw 'Invalid OpenCode key format. Nothing was saved.'
        }
    } finally {
        $plain = $null
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
    # Without a custom key, Windows protects this for the current user with DPAPI.
    $encrypted = ConvertFrom-SecureString -SecureString $Key
    $check = ConvertTo-SecureString -String $encrypted
    try { if ($check.Length -ne $Key.Length) { throw 'Encryption verification failed.' } }
    finally { $check.Dispose() }
    $resolved = [IO.Path]::GetFullPath($Path)
    $directory = [IO.Path]::GetDirectoryName($resolved)
    [void][IO.Directory]::CreateDirectory($directory)
    $temporary = Join-Path $directory ('.jev-key-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $encrypted, (New-Object Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($resolved)) {
            $backup = $resolved + '.previous-' + [guid]::NewGuid().ToString('N')
            [IO.File]::Replace($temporary, $resolved, $backup)
        } else { [IO.File]::Move($temporary, $resolved) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
    return $resolved
}

if ($FunctionsOnly) { return }
$Host.UI.RawUI.WindowTitle = 'Model Advisor - Jev Key Setup'
Write-Host 'Paste your NEW OpenCode Zen API key below, then press Enter.'
Write-Host 'The key is hidden and saved with Windows current-user encryption.'
Write-Host 'This does not enable Jev routing or send any API request.'
Write-Host ''
$taskKey = $null
try {
    $taskKey = Read-Host 'OpenCode API key' -AsSecureString
    $taskSavedPath = Save-JevKey -Key $taskKey -Path $CredentialPath
    Write-Host ''
    Write-Host 'Saved successfully.' -ForegroundColor Green
    Write-Host ('Encrypted file: ' + $taskSavedPath)
} catch {
    Write-Host 'Key setup failed. The key was not printed. Please retry.' -ForegroundColor Red
} finally {
    if ($taskKey) { $taskKey.Dispose() }
}
[void](Read-Host 'Press Enter to close this window')
