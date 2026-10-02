param(
    [string]$DataRoot = (Join-Path $HOME '.codex'),
    [ValidateRange(1024,65535)][int]$ListenPort = 18765
)
$ErrorActionPreference = 'Stop'
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$packageRoot = Split-Path -Parent $PSScriptRoot
$manager = Join-Path $PSScriptRoot 'manage.ps1'
$installed = Join-Path $DataRoot 'codex-model-advisor-router'
$isolated = $DataRoot -ne [IO.Path]::GetFullPath((Join-Path $HOME '.codex'))

function Start-SetupOperation([string]$ManagerPath,[string]$Root,[int]$Port,[ValidateSet('Install','Update','Restart','ShowWidget','ShowSettings')][string]$Action) {
    $logs = Join-Path $Root 'advisor-setup-logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $log = Join-Path $logs ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + $Action + '.log')
    $runspace = [runspacefactory]::CreateRunspace()
    $runspace.ApartmentState = 'STA'
    $runspace.Open()
    $worker = [powershell]::Create()
    $worker.Runspace = $runspace
    [void]$worker.AddScript({
        param($managerPath,$root,$port,$action,$logPath)
        $ErrorActionPreference = 'Stop'
        try {
            & $managerPath -Action $action -DataRoot $root -ListenPort $port *> $logPath
            [pscustomobject]@{ok=$true;message=''}
        } catch {
            $_ | Out-String | Add-Content -LiteralPath $logPath -Encoding UTF8
            [pscustomobject]@{ok=$false;message=$_.Exception.Message}
        }
    }).AddArgument($ManagerPath).AddArgument($Root).AddArgument($Port).AddArgument($Action).AddArgument($log)
    [pscustomobject]@{worker=$worker;runspace=$runspace;handle=$worker.BeginInvoke();action=$Action;log=$log}
}

function Get-SetupErrorMessage([string]$Message) {
    if($Message -match 'baseline|catalog|Codex executable') { return '未能取得 Codex 模型目录。请确认已安装并登录 Codex，网络正常后再试；已有配置会保留。' }
    if($Message -match 'active requests|pending|idle') { return '请等待正在运行的任务结束，再点击重试。没有中断你的任务。' }
    if($Message -match 'not installed') { return '尚未安装，请先点击“安装并启动”。' }
    if($Message -match 'healthy|health check') { return '服务未能就绪。请确认 Codex 可以正常打开，再尝试重启。' }
    return '本次操作未完成。请把下方记录位置或报错现象告诉我，先不要反复安装。'
}

Add-Type -AssemblyName PresentationFramework
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="Model Advisor · 安装与管理" Width="550" Height="450" MinWidth="500" MinHeight="430" WindowStartupLocation="CenterScreen" Background="#F4F6FA" FontFamily="Microsoft YaHei UI" FontSize="13">
 <Window.Resources>
  <Style TargetType="Button"><Setter Property="Padding" Value="16,10"/><Setter Property="Margin" Value="0,0,10,10"/><Setter Property="Background" Value="White"/><Setter Property="BorderBrush" Value="#D7DFEA"/><Setter Property="Foreground" Value="#23354B"/><Setter Property="Cursor" Value="Hand"/></Style>
 </Window.Resources>
 <Grid Margin="26">
  <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
  <StackPanel><TextBlock Text="Model Advisor" FontSize="25" FontWeight="SemiBold" Foreground="#1C2D43"/><TextBlock x:Name="Subtitle" Margin="0,6,0,20" Foreground="#60718A" TextWrapping="Wrap"/></StackPanel>
  <Border Grid.Row="1" Background="White" CornerRadius="10" Padding="18" BorderBrush="#E0E6EF" BorderThickness="1">
   <StackPanel><TextBlock x:Name="Status" FontSize="16" FontWeight="SemiBold" Foreground="#243B57"/><TextBlock x:Name="Detail" Margin="0,7,0,0" TextWrapping="Wrap" Foreground="#60718A"/><ProgressBar x:Name="Progress" Height="4" Margin="0,12,0,0" IsIndeterminate="True" Visibility="Collapsed"/></StackPanel>
  </Border>
  <StackPanel Grid.Row="2" Margin="0,20,0,0">
   <WrapPanel><Button x:Name="Primary" Content="安装并启动" Background="#245DC7" Foreground="White" BorderBrush="#245DC7"/><Button x:Name="Settings" Content="打开设置"/><Button x:Name="Restart" Content="重启服务"/></WrapPanel>
   <WrapPanel><Button x:Name="Widget" Content="显示小窗"/><Button x:Name="Refresh" Content="刷新状态"/></WrapPanel>
   <TextBlock x:Name="Result" Foreground="#40536D" TextWrapping="Wrap" Margin="0,2,0,0"/>
   <TextBox x:Name="LogPath" IsReadOnly="True" BorderThickness="0" Background="Transparent" TextWrapping="Wrap" MaxHeight="40" VerticalScrollBarVisibility="Auto" Foreground="#6D7C90" FontSize="11" Margin="0,5,0,0" Visibility="Collapsed"/>
  </StackPanel>
  <TextBlock Grid.Row="3" Text="关闭本窗口不会停止后台路由。" Foreground="#75849A" FontSize="12" Margin="0,12,0,0"/>
 </Grid>
</Window>
'@
$window = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
foreach($name in @('Subtitle','Status','Detail','Progress','Primary','Settings','Restart','Widget','Refresh','Result','LogPath')) { Set-Variable -Name $name -Value $window.FindName($name) }
$buttons = @($Primary,$Settings,$Restart,$Widget,$Refresh)
$script:operation = $null
if($isolated) {
    $window.Title = 'Model Advisor · 独立试用'
    $Subtitle.Text = '独立试用 · 不改变日常 Codex，无需填写密钥或发送模型题。'
} else { $Subtitle.Text = '安装、设置与日常管理，都从这里开始。' }

function Refresh-SetupState {
    $exists = Test-Path -LiteralPath (Join-Path $installed 'state.json')
    $healthy = $false
    if($exists) {
        try {
            $state = Get-Content -LiteralPath (Join-Path $installed 'state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $script:ListenPort = [int]$state.port
            $health = Invoke-RestMethod "http://127.0.0.1:$ListenPort/healthz" -TimeoutSec 2
            $healthy = $health.ok -eq $true -and $health.availablePairs -gt 0
        } catch {}
    }
    $Settings.IsEnabled = $healthy; $Widget.IsEnabled = $healthy
    $Restart.IsEnabled = $exists; $Refresh.IsEnabled = $true; $Primary.IsEnabled = $true
    if(!$exists) {
        $Primary.Content = '安装并启动'; $script:primaryAction = 'Install'
        $Status.Text = '尚未安装'; $Detail.Text = '点击“安装并启动”即可。安装默认使用固定规则。'
    } else {
        $version = (Get-Content -LiteralPath (Join-Path $installed 'package.json') -Raw | ConvertFrom-Json).version
        $sourceVersion = (Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json).version
        $Primary.Content = '更新此安装'; $script:primaryAction = 'Update'
        $Status.Text = if($healthy){"已就绪 · $version"}else{"已安装 · $version · 服务未就绪"}
        $Detail.Text = if($healthy){"可以打开设置或显示小窗。当前安装包：$sourceVersion。"}else{'可以尝试重启服务；如果仍不成功，请保留操作记录。'}
    }
}

function Invoke-SetupAction([string]$Action) {
    if($script:operation) { return }
    foreach($button in $buttons) { $button.IsEnabled = $false }
    $Status.Text = '正在处理，请稍候…'; $Detail.Text = '无需重复点击。遇到运行中的任务会停止操作并保留原状态。'
    $Result.Text = ''; $LogPath.Visibility = 'Collapsed'; $Progress.Visibility = 'Visible'
    try { $script:operation = Start-SetupOperation $manager $DataRoot $ListenPort $Action }
    catch { $Progress.Visibility='Collapsed';Refresh-SetupState;$Result.Text=Get-SetupErrorMessage $_.Exception.Message }
}
$Primary.Add_Click({Invoke-SetupAction $script:primaryAction})
$Settings.Add_Click({Invoke-SetupAction 'ShowSettings'})
$Restart.Add_Click({Invoke-SetupAction 'Restart'})
$Widget.Add_Click({Invoke-SetupAction 'ShowWidget'})
$Refresh.Add_Click({Refresh-SetupState})
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(300)
$timer.Add_Tick({
    if(!$script:operation -or !$script:operation.handle.IsCompleted) { return }
    $op = $script:operation
    try {
        $outcome = @($op.worker.EndInvoke($op.handle))[-1]
        Refresh-SetupState
        if($outcome.ok) {
            $Result.Text = switch($op.action) {
                Install {'安装完成。点击“打开设置”或“显示小窗”。'}
                Update {'更新完成，原配置已保留。'}
                Restart {'重启完成，可以继续使用。'}
                default {'已打开。'}
            }
        } else {
            $Result.Text = Get-SetupErrorMessage $outcome.message
            $LogPath.Text = '操作记录：' + $op.log; $LogPath.Visibility = 'Visible'
        }
    } catch { $Result.Text='操作结果未能读取。请保留记录并反馈。';$LogPath.Text=$op.log;$LogPath.Visibility='Visible' }
    finally { $op.worker.Dispose();$op.runspace.Dispose();$script:operation=$null;$Progress.Visibility='Collapsed' }
})
$window.Add_Closing({param($sender,$event) if($script:operation){$event.Cancel=$true;$Result.Text='操作正在完成，请稍候再关闭。'}})
$window.Add_Closed({$timer.Stop()})
Refresh-SetupState
$timer.Start()
[void]$window.ShowDialog()
