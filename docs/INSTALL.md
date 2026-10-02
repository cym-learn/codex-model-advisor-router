# 安装、升级与恢复

## 安装

需要 Windows x64 和已安装、登录的 Codex Desktop。从 Releases 下载 Windows ZIP 和 `SHA256SUMS.txt`，在 PowerShell 检查：

```powershell
Get-FileHash .\codex-model-advisor-router-0.9.0-windows-x64.zip -Algorithm SHA256
```

与清单相符后解压，双击 `Model-Advisor.vbs`（或 `Install.cmd`），在中文窗口点击“安装并启动”。安装到当前用户 `.codex\codex-model-advisor-router`，使用 Windows 计划任务启动服务。安装前先完成正在运行的 Codex 任务。

同一个窗口提供打开设置、显示小窗、重启和更新，操作时显示进度；失败时显示说明和本地记录位置。未安装时重启按钮不可用。卸载方法见下方“停用与卸载”。若系统不支持 VBS，可运行 `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\setup-window.ps1` 打开相同窗口。

默认固定规则。到 <http://127.0.0.1:18765/settings> 配置本机密钥和可选摘要，明确启用 Jev 自动选择。密钥按钮打开 Windows 密码窗口，粘贴并保存，不要把密钥发进聊天。

## 连接与管理

新建目标项目的 Codex 对话，使输入配置与设置页显示的基准一致。默认基准为 GPT-6 Sol / high，实际以设置页为准。旧对话可能仍使用旧 provider；不能只凭输入框标签确认接入。

“检查一次连接”验证 Jev 访问，实际 GPT 执行请查看状态页的完成配置和最终回复归属。端口占用、密钥窗口失败或模型目录为空时，先查看错误，不反复发送任务。

小窗可缩放、展开；关闭后可从托盘、快捷方式或设置页重新显示。退出小窗不停止路由。

在解压目录运行以下 PowerShell 命令：

```powershell
.\scripts\manage.ps1 -Action Status
.\scripts\manage.ps1 -Action ShowWidget
.\scripts\manage.ps1 -Action HideWidget
.\scripts\manage.ps1 -Action RoutingMode -Mode rules
.\scripts\manage.ps1 -Action Restart
```

若执行策略阻止脚本，可使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage.ps1 -Action Status`，不必永久修改系统执行策略。

## 升级与回退

等待任务结束，保留旧版备份。解压新版后，在新版目录运行：

```powershell
.\scripts\manage.ps1 -Action Update -SourceDir (Get-Location).Path
```

更新输出旧版备份路径，并保留受支持的配置和小窗偏好。遇到活动请求时等待，不强行停止其他任务。

回退时，从保留的解压目录运行同一管理命令，把 `-SourceDir` 改为输出的旧版备份路径：

```powershell
.\scripts\manage.ps1 -Action Update -SourceDir 'C:\path\to\previous-version'
```

不要将整个旧 `config.toml` 覆盖到现有配置。

## 停用与卸载

```powershell
.\scripts\manage.ps1 -Action Disable
.\scripts\manage.ps1 -Action Enable
.\scripts\manage.ps1 -Action Uninstall
```

停用恢复本工具管理的 provider 配置；卸载还移除安装和启动任务，恢复原有 skill。需要空闲。单独存储的 Jev 密钥不会随卸载删除，见 [隐私说明](../PRIVACY.md)。

## English

Requires Windows x64 and an installed, signed-in Codex Desktop. Download the Windows ZIP and `SHA256SUMS.txt`, compare `Get-FileHash -Algorithm SHA256`, extract and open `Model-Advisor.vbs` (or `Install.cmd`) after active tasks finish. Click **安装并启动** (Install and start). Node.js is bundled. Installation uses the current user's `.codex\codex-model-advisor-router` and a Windows scheduled task.

The same Chinese-language window provides Settings, widget, restart and update controls, progress and readable errors with local log locations. Restart is disabled before installation. Uninstall instructions appear below. If VBS is unavailable, run `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\setup-window.ps1` to open the same window.

Installation starts in rules mode. In <http://127.0.0.1:18765/settings>, enter your key through the native password dialog, optionally add project context, then explicitly enable Jev automatic mode. Do not paste keys into chats.

Use a conversation in your target project with the baseline shown in Settings (default GPT-6 Sol / high). Old conversations may retain a different provider. A connection check verifies Jev only; completed configuration and final-message attribution appear on the dashboard. Composer labels alone do not confirm execution.

The window can be resized, expanded and reopened through the tray, shortcut or Settings. Exiting it does not disable routing. If the port is occupied, the key window fails or the catalog is empty, inspect the error before sending more tasks.

Run the PowerShell commands above from an extracted package. `Status`, `ShowWidget`, `HideWidget`, `RoutingMode -Mode rules` and `Restart` cover routine management. If execution policy blocks a script, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` without permanently changing system policy.

To upgrade, wait until idle and run `Update -SourceDir (Get-Location).Path` from the new package. Keep the backup path printed by the manager. To roll back, run `Update` using that previous version's path. Do not overwrite the user's entire `config.toml`.

`Disable` restores managed provider settings; `Enable` enables routing again. `Uninstall` removes the installation and scheduled task and restores the previous skill. These require idle requests. The separately stored key survives uninstall; see [privacy](../PRIVACY.md#english).
