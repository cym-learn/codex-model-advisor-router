---
name: codex-model-advisor
description: Check or manage the local Codex Desktop model router, its Jev modes, project summaries and status window, or give manual model advice when asked.
---

# Codex Model Advisor

The Windows package provides a local Responses controller, settings and status pages, and a WPF window. Ordinary routed tasks do not require invoking this skill. A skill cannot change the model already generating its current turn.

## Status and management

Use `scripts/manage.ps1` under the current user's `.codex/codex-model-advisor-router`. `Status` separates installation, provider and health; `RoutingStatus` shows routing mode. `ShowWidget`, `HideWidget`, `ExitWidget`, `Restart`, `Enable`, `Disable`, `Update -SourceDir PATH` and `Uninstall` manage the tool. Do not bypass idle guards or overwrite the full Codex configuration with a backup. Updates preserve earlier files and managed settings.

Settings are at http://127.0.0.1:18765/settings and per-turn execution evidence at http://127.0.0.1:18765/. Closing the window hides it; the tray or `ShowWidget` reopens it. Exiting the window does not stop routing.

The native Desktop model picker can retain the incoming configuration. A recommendation, rewritten request or response-created event is not completed execution. Verify matching upstream completion and the final output message ID. Missing or conflicting evidence remains unconfirmed. Auxiliary requests must not replace a confirmed main reply. Status schema remains 2.

## Modes and protection

Installation defaults to rules. `RoutingMode -Mode rules` makes no new Jev routing call. `shadow` shows Jev suggestions; `auto` may apply a valid model/effort pair. Both require `-ConsentToSendTaskText` and user agreement to send task context to OpenCode Zen / TypeSafe. Existing explicit authorization is sufficient. A request to inspect status does not authorize sending unrelated projects.

The shipped automatic policy is `research-v5b-r10`. Use catalog-supported GPT pairs. Manual model/effort overrides, configuration updates and opaque histories remain protected. A new identified user turn is judged once; tool continuations reuse its selection. Jev abstention, invalid choices, unavailable service and timeout retain the incoming configuration. Do not substitute rules or add automatic paid retries.

## Project context and credentials

User-entered project summaries are off by default, limited to 2,000 characters, and included in the 16,000-character total with task/context. Settings support one or multiple full directory paths per summary. Conversation working directories match the most specific registered root; per-conversation entries take precedence. Unknown project identity means no project summary. Changes apply next user turn; disabling stops future attachment. Do not scan source or everyday history to create context without a separate request.

Jev receives current task text and necessary recent completed rounds, at most two, plus authorized context. Oversize input is skipped without silent truncation. Do not additionally send files, attachments, system instructions, tools or full history. Secret-pattern detection is not comprehensive.

Configure the OpenCode key in the local password window or `Configure-Jev.cmd`. The key is current-user DPAPI-encrypted outside installation files. Never display plaintext helper output, inspect the clipboard for credentials, or put keys in chat, command arguments, screenshots or logs. The controller consumes its private helper pipe. Project summaries are separate unencrypted local JSON and must not contain secrets.

## Checks and reporting

Use offline simulations for configuration, timeout, cancellation and UI checks. Live checks require explicit user scope and separate accounting; do not treat model labels or a successful provider connection as quality or savings evidence. Preserve any existing trial ledgers and registrations. Report GPT/Jev token usage separately from estimated credits and subscription quota. Do not infer quota savings without attributable measurement.

For manual advice, inspect the current catalog and label recommendations as advice unless changing settings is authorized. Older chats may retain another provider; global health does not prove a particular chat is routed.
