---
name: agent-board-install-agents
description: Install the AI Agents supported by Agent Board on Windows. Use this skill whenever a user asks Agent Board or an AI assistant to download, install, or set up one or more supported Agents. Before doing anything, ask whether to install all Agents or only selected Agents; wait for the user's answer, then execute only the approved selection. Use parallel workers when the current AI client provides them, while keeping interactive installer windows manageable.
compatibility: Windows 10/11, PowerShell 5.1 or newer, network access, and permission to run approved installers.
---

# Agent Board Agent Installer

Use this skill to help a Windows user install the Agent applications that Agent Board can monitor. The user remains in control of the selection and any installer confirmation.

## Safety gate: ask before touching the machine

Your first response after this skill is invoked must ask exactly one scope question and must not run a download, open an installer, or execute a package command before the user answers:

> 你想安装全部 Agent，还是只安装其中几个？如果选择几个，请告诉我名称。

Interpret answers such as “全部”“都装”“all” as the full list. For a partial selection, normalize names and confirm the exact list you understood if any name is ambiguous. Never add an Agent the user did not approve.

## Supported Windows Agents

Use only these official pages. The page URLs are intentionally kept here instead of copied from search results so the installation flow has a reviewable allowlist.

| Agent | Official download page |
| --- | --- |
| Claude Code | https://code.claude.com/docs/en/installation |
| Codex | https://github.com/openai/codex/releases/latest |
| WorkBuddy | https://www.workbuddy.cn/work/#download-section |
| DeepSeek Harness | https://www.deepseek.com/harness/en/ |
| Marvis | https://marvis.qq.com/ |
| ZCode | https://zcode.z.ai/cn#all-downloads |
| Pi Agent | https://pi.dev/ |
| Hermes Agent | https://github.com/NousResearch/hermes-agent |

## Installation workflow after the user answers

1. Build a plan containing only the approved Agents. Show the Agent names and official pages before starting.
2. Prefer an official direct installer URL when the official page exposes one. If only a landing page is available, open that official page in the default browser and tell the user that the page requires their normal download or installer interaction. Do not scrape an unknown mirror or substitute a guessed URL.
3. If the current AI client has subagents or parallel task tools, dispatch one worker per approved Agent for independent download preparation. Limit parallelism to three workers. Each worker must use the allowlisted official page, save downloads under a temporary Agent Board folder, and report the exact file path or page it opened.
   如果当前 AI 客户端支持子代理，可以为已选择的 Agent 并行准备下载；并行数最多为 3 个。
4. Parallel downloads are allowed. Launching multiple GUI installers at the same time is not: serialize interactive installers unless the user explicitly asks for parallel installer windows. Command-line installers may run in parallel only when their official instructions are independent.
5. Before launching any downloaded installer, verify that it is the file the official page provided and show the path to the user. Never execute a file from an unapproved host, an email attachment, or a random mirror.
6. Wait for downloads and installer processes to finish where the tool supports waiting. Do not claim an Agent is installed merely because its download page opened.
7. After installation, ask Agent Board to re-detect the approved Agents when the local board API is available. The default standalone endpoint is `http://127.0.0.1:4876`:

   ```powershell
   Invoke-RestMethod 'http://127.0.0.1:4876/api/agents/status?force=1'
   Invoke-RestMethod -Method Post 'http://127.0.0.1:4876/api/agents/<agent-id>/discover-path'
   ```

   If the Electron build chose another local port or the board is not running, report that path discovery must be run from the Agent Board “应用管理” window instead.
8. Return a compact result table with `已安装`、`已下载待安装`、`已打开官方下载页`、`失败` or `未检测到` for each approved Agent. Include the next action for every non-installed result.

## Non-negotiable boundaries

- Do not begin installation until the user answers the all-or-selected question.
- Do not install unselected Agents “for convenience”.
- Use official HTTPS pages only; do not use mirrors or unverified shell snippets.
- Do not silently bypass UAC, antivirus prompts, installer dialogs, or license prompts.
- Never report success without a completed installer or a successful Agent Board re-detection.
- If a download page is unavailable, report the failure and keep the remaining approved Agents moving when it is safe to do so.
