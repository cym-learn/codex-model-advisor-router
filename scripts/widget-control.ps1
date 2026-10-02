function Get-WidgetIdentity([string]$InstallDir) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($InstallDir).TrimEnd('\').ToLowerInvariant()))).Replace('-','') }
    finally { $sha.Dispose() }
    return "Local\CodexModelAdvisorWidget-$sid-$hash"
}

function Send-WidgetCommand([string]$InstallDir, [ValidateSet('Show','Hide','Reset','Exit')][string]$Command) {
    try { $signal = [Threading.EventWaitHandle]::OpenExisting("$(Get-WidgetIdentity $InstallDir)-$Command") }
    catch [Threading.WaitHandleCannotBeOpenedException] { return $false }
    try { [void]$signal.Set(); return $true } finally { $signal.Dispose() }
}

function Get-WidgetBounds($Left, $Top, $Width, $Height, $Areas) {
    # WPF positions and supplied work areas are device-independent coordinates.
    $area = @($Areas | Where-Object { $Left -lt $_.Right -and ($Left+$Width) -gt $_.Left -and $Top -lt $_.Bottom -and ($Top+$Height) -gt $_.Top } | Select-Object -First 1)
    if (-not $area.Count) { $area = @($Areas | Select-Object -First 1) }
    $a = $area[0]
    $w = [Math]::Min($Width,$a.Right-$a.Left); $h = [Math]::Min($Height,$a.Bottom-$a.Top)
    return @{Left=[Math]::Max($a.Left,[Math]::Min($Left,$a.Right-$w));Top=[Math]::Max($a.Top,[Math]::Min($Top,$a.Bottom-$h));Width=$w;Height=$h}
}
