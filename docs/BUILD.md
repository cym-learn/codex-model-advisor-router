# 从源码构建

使用 Windows x64、PowerShell 和 Node.js 24。无需 npm 依赖安装。`npm test` 运行清单中的产品离线检查；Windows 窗口检查需交互式桌面会话，不消耗模型请求。

```powershell
npm test
.\scripts\package.ps1 -OutputDir .\dist\release-0.9.0
```

脚本按 `release-files.json` 分别导出源码与应用。Node.js 的版本及 SHA256 固定在 `runtime-lock.json`，只下载该版本并核验，不使用 latest。

也可通过 `-RuntimeDir` 提供已有运行时目录，需包含 `node.exe`、`NODE_LICENSE` 和 `manifest.json`，其版本和校验值必须匹配锁定文件。

`-StageOnly` 仅导出干净源码，不下载运行时、不生成 ZIP。输出目录必须是新的，已有源码导出或附件不会被覆盖。

产物包括干净源码目录、源码 ZIP、Windows ZIP 和 `SHA256SUMS.txt`。源码与安装包都不含个人配置、凭据、日志或实验材料。导出的源码执行同一套 `npm test`，不依赖原工作区。

## English

Use Windows x64, PowerShell and Node.js 24. No npm dependency installation is required. `npm test` runs the listed offline product checks; native-window checks require an interactive Windows desktop and make no model requests.

Run the commands above. Packaging uses `release-files.json` for separate source and application exports. The Node.js version and SHA256 are pinned in `runtime-lock.json`, never resolved from latest.

Alternatively pass `-RuntimeDir` with `node.exe`, `NODE_LICENSE` and `manifest.json` matching the lock. `-StageOnly` exports clean source without downloading a runtime or creating ZIPs. Use a new output directory; existing exports and archives are not overwritten.

Outputs include clean source, a source ZIP, a Windows ZIP and `SHA256SUMS.txt`. Personal configuration, credentials, logs and experiment material are excluded. The exported source runs the same `npm test` without the original workspace.
