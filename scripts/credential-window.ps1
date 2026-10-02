param([string]$CredentialPath = (Join-Path $env:USERPROFILE '.codex\credentials\codex-model-advisor\opencode-jev.dpapi'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
. (Join-Path $PSScriptRoot 'configure-jev-key.ps1') -CredentialPath $CredentialPath -FunctionsOnly
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="Model Advisor · 配置 Jev 密钥" Width="460" Height="245" ResizeMode="NoResize" WindowStartupLocation="CenterScreen" FontFamily="Microsoft YaHei">
 <StackPanel Margin="20">
  <TextBlock Text="输入你自己的 OpenCode Zen API 密钥" FontWeight="Bold" Margin="0,0,0,12"/>
  <PasswordBox x:Name="Key" MaxLength="2048" Margin="0,0,0,12"/>
  <TextBlock Text="仅在本机使用 Windows 当前用户加密保存。保存不会调用模型，也不会自动开启路由。" TextWrapping="Wrap" Margin="0,0,0,12"/>
  <Button x:Name="Save" Content="加密保存" Height="30"/>
  <TextBlock x:Name="Status" TextWrapping="Wrap" Margin="0,10,0,0"/>
 </StackPanel>
</Window>
'@
$window=[Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
$box=$window.FindName('Key');$status=$window.FindName('Status')
$window.FindName('Save').Add_Click({
 $secure=$box.SecurePassword
 try{[void](Save-JevKey -Key $secure -Path $CredentialPath);$box.Clear();$status.Text='已加密保存。可关闭此窗口，回到设置页刷新状态。'}
 catch{$status.Text='保存失败，请检查密钥格式后重试。密钥未显示。'}
 finally{$secure.Dispose()}
})
$window.Add_ContentRendered({
 [void]$window.Activate();[void]$box.Focus()
 if(-not $script:readySent){$script:readySent=$true;[Console]::Out.WriteLine('ADVISOR_CREDENTIAL_WINDOW_READY')}
})
# Consume the launcher's hidden first-window hint before displaying the password dialog.
$window.Show();$window.Hide()
[void]$window.ShowDialog()
