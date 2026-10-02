param([string]$CredentialPath)
$ErrorActionPreference = 'Stop'
$taskSecure = $null; $taskPointer = [IntPtr]::Zero; $taskKey = $null
try {
    $taskSecure = ConvertTo-SecureString ([IO.File]::ReadAllText($CredentialPath))
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
    $taskKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
    if ($taskKey -notmatch '^oc_sk_[A-Za-z0-9_-]{16,2048}$') { exit 1 }
    # Private child stdout consumed by Node. Never run this helper interactively.
    [Console]::Out.Write($taskKey)
} catch { exit 1 }
finally {
    $taskKey = $null
    if ($taskPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
    if ($taskSecure) { $taskSecure.Dispose() }
}
