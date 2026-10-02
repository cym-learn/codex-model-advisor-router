# 数据与隐私 / Data and privacy

## 本地服务与外发信息

服务仅监听 `127.0.0.1`。使用 Codex 现有认证，把 GPT 请求转发到原 OpenAI 服务；Codex 凭据不发送给 Jev。本项目不向项目作者的服务器发送统计信息。

固定规则不调用 Jev。只建议和自动模式需要明确同意，才发送当前任务、必要的最近上下文（最多两轮已完成的用户/最终回复）、已授权的匹配摘要，以及选型所需的候选说明。

任务、上下文和摘要合计最多 16,000 个 JavaScript 字符，摘要最多 2,000 字符。超长输入保护性跳过，不静默截断。不另外读取项目源码、附件、系统提示、工具输出或完整聊天历史给 Jev；直接粘贴进用户消息的内容属于消息的一部分。

摘要默认关闭，只发送你填写并授权的原文。目录用于匹配对话归属，不用于扫描文件。关闭停止后续附加，无法撤回已发送的信息；逐对话配置优先于项目配置。

Jev 使用 OpenCode Zen 的 `https://opencode.ai/zen/v1/systemone` 和 `jev-1.13-free`。模型名不代表永久免费或始终可用，条款和数据保留政策以 [提供商说明](https://opencode.ai/docs/en/zen/) 为准。不会自动切换到付费 Jev 后备服务。

## 本地存储

- 密钥通过本机界面输入，使用当前 Windows 用户的 DPAPI 加密，位于安装目录之外。网页不读取或保存明文密钥；内部辅助进程通过私有管道传递。
- `project-contexts.json` 保存摘要原文、目录、授权和版本信息，**未加密**。兼容旧 `project-briefs.json`。不要填写密钥或敏感资料。
- 路由日志、状态和缓存记录标识符、配置、状态、耗时和用量，不记录任务/回答正文或认证信息。任务归属显示会读取本地 Codex 的对话名称、工作目录和任务关系等元数据。
- 摘要设置页会显示已保存的摘要；同机程序可以访问本地服务。设置写操作使用本机、同源和会话校验。
- 已知密钥格式检测不能识别所有敏感信息，请自行检查将发送的文字。

卸载恢复受管理的 Codex 配置并移除安装目录，独立存储的加密密钥会保留。需要彻底移除时，在卸载后删除 `%USERPROFILE%\.codex\credentials\codex-model-advisor` 中本工具的密钥和备份。升级备份、解压目录和自行导出的文件也需自行管理。

## English

The controller listens on `127.0.0.1` only and forwards GPT requests to the original OpenAI service using existing Codex authentication. It does not send Codex credentials to Jev or analytics to a project-operated service.

Rules mode makes no Jev call. Suggestion and automatic modes require consent to send task text, necessary recent context (up to two completed user/final-assistant turns), matching authorized summaries and routing criteria. Task/context/summary text shares a 16,000-JavaScript-character limit; summaries have a 2,000-character limit. Oversized input is skipped, not silently truncated.

The tool does not additionally read project source, attachments, system instructions, tool outputs or full chat history as Jev context. Pasted message content is part of the message. Summaries are off by default and contain only text you enter and authorize. Directories match conversations, not file contents. Disabling stops future attachment but cannot retract sent information; per-conversation settings take precedence.

Jev uses `https://opencode.ai/zen/v1/systemone` with `jev-1.13-free`. Availability, pricing and retention follow [provider terms](https://opencode.ai/docs/en/zen/); the name does not promise permanent free access. No automatic paid Jev fallback is configured.

Keys are entered locally, encrypted using current-user Windows DPAPI outside the installation and passed internally through a private process pipe. The webpage neither reads nor saves plaintext keys. `project-contexts.json` is **unencrypted** local JSON containing summaries, directories, consent and revisions; legacy `project-briefs.json` is supported.

Runtime logs, status and caches retain identifiers, configuration, state, timings and usage, not task/answer bodies or authentication. Local Codex metadata supplies display names, directories and task relationships. Settings display saved summaries. Other local programs can reach the service; writes require local origin and session validation. Secret-pattern detection is not comprehensive.

Uninstallation restores managed settings and removes the installation, but retains the encrypted key. To remove it, delete this tool's key and backups under `%USERPROFILE%\.codex\credentials\codex-model-advisor` after uninstalling. Manage upgrade backups, extracted packages and your exports separately.
