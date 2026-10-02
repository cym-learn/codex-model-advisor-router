param([string]$InstallDir = (Split-Path -Parent $PSScriptRoot), [switch]$CaptureLayout)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Net.Http, System.Windows.Forms, System.Drawing
. (Join-Path $PSScriptRoot 'widget-view.ps1')
$prefsPath = Join-Path $InstallDir 'widget-state.json'
$pidPath = Join-Path $InstallDir 'widget.pid'
$state = Get-Content -LiteralPath (Join-Path $InstallDir 'state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 . (Join-Path $PSScriptRoot 'widget-control.ps1')
$identity = Get-WidgetIdentity $InstallDir
$created = $false
$mutex = New-Object Threading.Mutex($true, $identity, [ref]$created)
if (-not $created) { [void](Send-WidgetCommand $InstallDir Show); $mutex.Dispose(); exit }
$signals = @{}
foreach ($command in @('Show','Hide','Reset','Exit')) { $signals[$command] = New-Object Threading.EventWaitHandle($false,[Threading.EventResetMode]::AutoReset,"$identity-$command") }
try {
    [string]$script:lockedRoot = ''
    $prefs = $null
    try { $prefs = Get-Content -LiteralPath $prefsPath -Raw -Encoding UTF8 | ConvertFrom-Json; $script:lockedRoot = [string]$prefs.lockedRoot } catch {}
    [xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
 Title="Codex Model Advisor" Width="260" Height="100" WindowStyle="None" MinWidth="220" MinHeight="88" ResizeMode="CanResizeWithGrip" Topmost="True" ShowInTaskbar="True" Background="#FAFBFD" FontFamily="Microsoft YaHei" Foreground="#233044">
 <Window.Resources><Style TargetType="Button"><Setter Property="Background" Value="Transparent"/><Setter Property="BorderThickness" Value="0"/><Setter Property="Foreground" Value="#64748B"/><Setter Property="Padding" Value="4,1"/><Setter Property="Cursor" Value="Hand"/></Style></Window.Resources>
 <Border BorderBrush="#DDE3EC" BorderThickness="1" CornerRadius="8" Padding="12,6">
 <Grid><Grid.RowDefinitions><RowDefinition Height="20"/><RowDefinition Height="26"/><RowDefinition Height="16"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/></Grid.RowDefinitions>
  <Grid x:Name="DragBar" Background="Transparent"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="32"/><ColumnDefinition Width="22"/></Grid.ColumnDefinitions>
   <TextBlock x:Name="ConversationName" Text="等待对话" FontSize="11" Foreground="#64748B" TextTrimming="CharacterEllipsis" VerticalAlignment="Center" Margin="0,0,6,0"/>
   <Button x:Name="Mode" Grid.Column="1" Content="⌄" ToolTip="展开详情" FontSize="14"/>
   <Button x:Name="Close" Grid.Column="2" Content="×" ToolTip="隐藏到托盘" FontSize="15"/>
  </Grid>
  <TextBlock x:Name="Pair" Grid.Row="1" Text="连接中…" FontSize="17" FontWeight="SemiBold" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
  <TextBlock x:Name="Status" Grid.Row="2" Text="等待共享状态" FontSize="10" Foreground="#64748B" TextTrimming="CharacterEllipsis"/>
  <StackPanel x:Name="ExtraControls" Grid.Row="3" Visibility="Collapsed" Margin="0,10,0,0">
   <Border BorderBrush="#E4E9F0" BorderThickness="0,1,0,0" Margin="0,0,0,10"/>
   <ComboBox x:Name="Conversation" FontSize="11" ToolTip="自动跟随，或选择一个对话锁定"/>
   <DockPanel Margin="0,8,0,0"><CheckBox x:Name="Pin" Content="置顶" IsChecked="True" FontSize="10" VerticalAlignment="Center"/><Button x:Name="Web" Content="完整状态 ↗" FontSize="10" HorizontalAlignment="Right"/></DockPanel>
   <TextBlock x:Name="Role" FontSize="10" Foreground="#64748B" Margin="0,8,0,0" TextTrimming="CharacterEllipsis"/>
  </StackPanel>
  <ScrollViewer x:Name="DetailArea" Grid.Row="4" Visibility="Collapsed" VerticalScrollBarVisibility="Auto" Margin="0,6,0,0"><TextBlock x:Name="Details" TextWrapping="Wrap" FontSize="11" Foreground="#64748B"/></ScrollViewer>
 </Grid></Border>
</Window>
'@
    $reader = New-Object Xml.XmlNodeReader $xaml
    $window = [Windows.Markup.XamlReader]::Load($reader)
    $selector = $window.FindName('Conversation'); $pairLabel = $window.FindName('Pair')
    $statusLabel = $window.FindName('Status'); $roleLabel = $window.FindName('Role'); $pin = $window.FindName('Pin')
    $script:updating = $false; $script:selectionSignature = ''; $script:pending = $null
    $script:exitWidget = $false
    $script:mode = if ($prefs -and $prefs.mode -eq 'expanded') { 'expanded' } else { 'compact' }
    $script:sizes = @{compact=@{width=260;height=100};expanded=@{width=300;height=230}}
    foreach ($modeName in @('compact','expanded')) {
        if ($prefs -and $prefs.sizes -and $prefs.sizes.$modeName) {
            $size = $prefs.sizes.$modeName
            if ($size.width -ge 220 -and $size.height -ge 88) { $script:sizes[$modeName]=@{width=[double]$size.width;height=[double]$size.height} }
        }
    }
    function Save-Preferences {
        $script:sizes[$script:mode]=@{width=$window.Width;height=$window.Height}
        @{left=$window.Left;top=$window.Top;topmost=$window.Topmost;lockedRoot=$script:lockedRoot;mode=$script:mode;sizes=$script:sizes} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $prefsPath -Encoding UTF8
    }
    function Keep-Visible {
        $dpi = [Windows.Media.VisualTreeHelper]::GetDpi($window)
        $areas = @([Windows.Forms.Screen]::AllScreens | ForEach-Object { $a=$_.WorkingArea; @{Left=$a.Left/$dpi.DpiScaleX;Top=$a.Top/$dpi.DpiScaleY;Right=$a.Right/$dpi.DpiScaleX;Bottom=$a.Bottom/$dpi.DpiScaleY} })
        $bounds = Get-WidgetBounds $window.Left $window.Top $window.Width $window.Height $areas
        $window.Left=$bounds.Left; $window.Top=$bounds.Top
        $window.Width=$bounds.Width; $window.Height=$bounds.Height
    }
    function Apply-Mode {
        $window.MinWidth=if($script:mode -eq 'expanded'){260}else{220}; $window.MinHeight=if($script:mode -eq 'expanded'){200}else{88}
        $window.Width=$script:sizes[$script:mode].width; $window.Height=$script:sizes[$script:mode].height
        foreach($name in @('ExtraControls','DetailArea')) { $window.FindName($name).Visibility = if ($script:mode -eq 'expanded') { 'Visible' } else { 'Collapsed' } }
        $window.FindName('Mode').Content = if ($script:mode -eq 'expanded') { '⌃' } else { '⌄' }
        $window.FindName('Mode').ToolTip = if ($script:mode -eq 'expanded') { '收起详情' } else { '展开详情' }
    }
    function Show-WidgetWindow { $window.Show(); $window.WindowState='Normal'; Keep-Visible; [void]$window.Activate() }
    function Reset-WidgetWindow {
        $script:sizes=@{compact=@{width=260;height=100};expanded=@{width=300;height=230}}
        Apply-Mode; $window.Left=40; $window.Top=40; Show-WidgetWindow; Save-Preferences
    }
    Apply-Mode
    if ($prefs -and $null -ne $prefs.topmost) { $pin.IsChecked=[bool]$prefs.topmost; $window.Topmost=[bool]$prefs.topmost }
    $window.Left = if ($prefs -and $null -ne $prefs.left) { [double]$prefs.left } else { 40 }
    $window.Top = if ($prefs -and $null -ne $prefs.top) { [double]$prefs.top } else { 40 }
    $window.Add_ContentRendered({ Keep-Visible })
    $window.FindName('Mode').Add_Click({ Save-Preferences; $script:mode=if($script:mode -eq 'compact'){'expanded'}else{'compact'}; Apply-Mode; Keep-Visible; Save-Preferences })
    $tray = New-Object Windows.Forms.NotifyIcon
    $tray.Icon=[Drawing.SystemIcons]::Application; $tray.Text='Codex Model Advisor'; $tray.Visible=$true
    $menu=New-Object Windows.Forms.ContextMenuStrip
    $item=$menu.Items.Add('显示小窗'); $item.Add_Click({ Show-WidgetWindow })
    $item=$menu.Items.Add('设置'); $item.Add_Click({ Start-Process "http://127.0.0.1:$($state.port)/settings" })
    $item=$menu.Items.Add('完整状态页'); $item.Add_Click({ Start-Process "http://127.0.0.1:$($state.port)/" })
    $item=$menu.Items.Add('恢复默认大小与位置'); $item.Add_Click({ Reset-WidgetWindow })
    $item=$menu.Items.Add('退出小窗'); $item.Add_Click({ $script:exitWidget=$true; $window.Close() })
    $tray.ContextMenuStrip=$menu; $tray.Add_DoubleClick({ Show-WidgetWindow })
    $window.FindName('DragBar').Add_MouseLeftButtonDown({ if ($_.OriginalSource -is [Windows.Controls.TextBlock] -or $_.OriginalSource -is [Windows.Controls.Grid]) { $window.DragMove() } })
    $pin.Add_Click({ $window.Topmost = [bool]$pin.IsChecked })
    $window.FindName('Close').Add_Click({ Save-Preferences; $window.Hide() })
    $window.FindName('Web').Add_Click({ Start-Process "http://127.0.0.1:$($state.port)/" })
    $selector.Add_SelectionChanged({ if (-not $script:updating -and $selector.SelectedItem) { $script:lockedRoot = [string]$selector.SelectedItem.Tag } })
    $client = New-Object Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(3)
    $client.DefaultRequestHeaders.Add('Accept','application/json')
    $timer = New-Object Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(200)
    $script:nextPoll = [DateTime]::MinValue
    $timer.Add_Tick({
        foreach ($command in @('Show','Hide','Reset','Exit')) {
            if ($signals[$command].WaitOne(0)) {
                switch ($command) {
                    'Show' { Show-WidgetWindow }
                    'Hide' { Save-Preferences; $window.Hide() }
                    'Reset' { Reset-WidgetWindow }
                    'Exit' { $script:exitWidget=$true; $window.Close(); return }
                }
            }
        }
        try {
            if ($script:pending -and $script:pending.IsCompleted) {
                $json = $script:pending.GetAwaiter().GetResult()
                $script:pending = $null
                $snapshot = $json | ConvertFrom-Json
                $view = Get-WidgetView $snapshot $script:lockedRoot
                $pairLabel.Text = $view.Pair; $statusLabel.Text = $view.Status
                $pairLabel.ToolTip=$view.Pair; $statusLabel.ToolTip=$view.Status
                $window.FindName('ConversationName').Text=$view.Name
                $roleLabel.Text = "$($view.Role) · $(if($script:lockedRoot){'已锁定'}else{'自动跟随'})"
                $roleLabel.ToolTip = "$($view.Role) · $($view.Jev)"
                $window.ToolTip = $view.Name
                $window.FindName('Details').Text = $view.Jev
                $signature = @($view.Roots | ForEach-Object { "$($_.rootThreadId):$($_.displayName)" }) -join '|'
                if ($signature -ne $script:selectionSignature -or -not $selector.Items.Count) {
                    $script:updating = $true; $selector.Items.Clear()
                    $auto = New-Object Windows.Controls.ComboBoxItem; $auto.Content = "自动跟随 · $($view.Name)"; $auto.Tag = ''; [void]$selector.Items.Add($auto)
                    $selector.SelectedIndex = 0
                    foreach ($root in $view.Roots) {
                        $item = New-Object Windows.Controls.ComboBoxItem; $item.Tag = $root.rootThreadId
                        $item.Content = "锁定 · $($root.displayName)$(if($root.sourceKind -eq 'test'){' [测试]'})"; [void]$selector.Items.Add($item)
                        if ($root.rootThreadId -eq $script:lockedRoot) { $selector.SelectedItem = $item }
                    }
                    if ($script:lockedRoot -and $selector.SelectedIndex -eq 0) {
                        $item = New-Object Windows.Controls.ComboBoxItem; $item.Tag = $script:lockedRoot; $item.Content = '锁定 · 对话暂不可见'; [void]$selector.Items.Add($item); $selector.SelectedItem=$item
                    }
                    $script:selectionSignature = $signature; $script:updating = $false
                } else { $selector.Items[0].Content = "自动跟随 · $($view.Name)" }
                if ($CaptureLayout) { Save-Layout $view.Name; return }
            }
            if (-not $script:pending -and [DateTime]::UtcNow -ge $script:nextPoll) {
                $script:pending = $client.GetStringAsync("http://127.0.0.1:$($state.port)/api/status")
                $script:nextPoll = [DateTime]::UtcNow.AddSeconds(1)
            }
        } catch {
            $script:pending = $null; $script:updating = $false
            $pairLabel.Text = '模型未知'; $statusLabel.Text = '离线 · 等待重新连接'; $roleLabel.Text = '旧值不代表当前状态'
            $window.FindName('ConversationName').Text='未连接'
            $window.FindName('Details').Text = '控制器暂不可用。可从托盘打开设置或完整状态页检查；连接恢复后自动刷新。'
            if ($CaptureLayout) { Save-Layout 'Offline' }
        }
    })
    function Save-Layout([string]$name) {
        $window.UpdateLayout()
        $directory = Join-Path $InstallDir 'renders'
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        foreach ($scale in @(1.0,1.25,1.5,2.0)) {
            $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap([int]($window.ActualWidth*$scale),[int]($window.ActualHeight*$scale),(96*$scale),(96*$scale),[Windows.Media.PixelFormats]::Pbgra32)
            # Capture the content at its own origin, not the Window's per-monitor screen transform.
            $drawing = New-Object Windows.Media.DrawingVisual
            $context = $drawing.RenderOpen()
            $brush = New-Object Windows.Media.VisualBrush($window.Content)
            $context.DrawRectangle($window.Background,$null,(New-Object Windows.Rect(0,0,$window.ActualWidth,$window.ActualHeight)))
            $context.DrawRectangle($brush,$null,(New-Object Windows.Rect(0,0,$window.ActualWidth,$window.ActualHeight)))
            $context.Close()
            $bitmap.Render($drawing)
            $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
            $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
            $file = [IO.File]::Create((Join-Path $directory "widget-$scale.png"))
            try { $encoder.Save($file) } finally { $file.Dispose() }
        }
        $dpi = [Windows.Media.VisualTreeHelper]::GetDpi($window)
        @{width=$window.ActualWidth;height=$window.ActualHeight;actualDpiScaleX=$dpi.DpiScaleX;actualDpiScaleY=$dpi.DpiScaleY;pair=$pairLabel.Text;status=$statusLabel.Text;name=$name;role=$roleLabel.Text;topmost=$window.Topmost} |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'layout.json') -Encoding UTF8
        $script:exitWidget=$true; $window.Close()
    }
    $window.Add_Closing({
        Save-Preferences
        if (-not $script:exitWidget -and -not $CaptureLayout) { $_.Cancel=$true; $window.Hide(); return }
        $timer.Stop(); $client.Dispose(); $tray.Visible=$false; $tray.Dispose(); $menu.Dispose()
    })
    Set-Content -LiteralPath $pidPath -Value $PID -Encoding ASCII
    $timer.Start()
    # Consume the launcher's hidden first-window hint, then show only the WPF display.
    $window.Show(); $window.Hide()
    $app = New-Object Windows.Application
    $app.ShutdownMode = [Windows.ShutdownMode]::OnMainWindowClose
    [void]$app.Run($window)
} finally {
    if ((Test-Path -LiteralPath $pidPath) -and [string](Get-Content -LiteralPath $pidPath -Raw).Trim() -eq [string]$PID) { Remove-Item -LiteralPath $pidPath }
    foreach ($signal in $signals.Values) { $signal.Dispose() }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
