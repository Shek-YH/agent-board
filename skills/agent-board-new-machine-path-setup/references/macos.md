# macOS 平台专项规则

仅在 `process.platform === 'darwin'` 时读取和执行本文件。不要在 macOS 执行 PowerShell、`reg.exe`、`cmd.exe`、Windows `.bat` 或 Windows 盘符路径。

## 环境和路径

使用 bash/zsh：

```bash
sw_vers
uname -m
pwd
printf '%s\n' "$HOME"
command -v node || true
node --version || true
which -a node 2>/dev/null || true
```

源码版 runtime 选择顺序：

1. 项目 `runtime/node`，并确认可执行权限；
2. 当前 PATH 中的 `node`；
3. nvm、asdf、Homebrew 或明确配置的 `AGENT_BOARD_NODE_RUNTIME`。

`start.sh` 必须从脚本自身目录解析项目根目录，优先 `runtime/node`，缺失才回退 `command -v node`；找不到时输出明确错误并退出。不能引用 A 电脑的 Windows 路径，也不能假设启动 shell 一定继承用户交互式 `.zshrc` 的 PATH；必要时从 `~/.zprofile`、`~/.zshrc`、Homebrew 前缀和 nvm/asdf 初始化中核对。

默认机器目录：

- 数据：`~/Library/Application Support/AgentBoard`；
- 配置：`~/Library/Application Support/AgentBoard`，除非 `AB_CONFIG_DIR` 覆盖；
- 日志：`~/Library/Logs/AgentBoard`、Electron `app.getPath('logs')`、userData 和启动输出，按实际存在性确认；
- Agent Board 启动入口：`~/Library/LaunchAgents`、登录项和用户级 watchdog；不自动修改它们，除非用户单独授权。

## Agent 探测

优先使用 `command -v`/`which -a`、Homebrew 前缀、用户目录和应用包：

```bash
command -v <agent> || true
which -a <agent> 2>/dev/null || true
brew --prefix 2>/dev/null || true
mdfind "kMDItemKind == 'Application' && kMDItemFSName == '*.app'" 2>/dev/null | head -200
```

Desktop 需要同时确认 `.app` 包和真正的 `Contents/MacOS/<main>`：

- `/Applications/<Agent>.app/Contents/MacOS/<Agent>`；
- `~/Applications/<Agent>.app/Contents/MacOS/<Agent>`；
- 由 `mdfind` 或应用自身安装信息发现的其他路径；
- Homebrew/npm/pnpm/bun 的 CLI 路径。

不要把 `.app` 目录直接写入 CLI `tool-paths.json`；CLI 和 Desktop 仍按变体分开记录。对 shell shim 先检查 `test -x`、shebang 和实际 `--version`，不要只看文件存在。

## 进程、端口和旧 server

确认端口和进程：

```bash
lsof -nP -iTCP:4876 -sTCP:LISTEN
ps -axo pid=,ppid=,command= | grep -E 'server\.js|agent-board-watchdog' | grep -v grep
launchctl print "gui/$UID" 2>/dev/null | grep -i agent-board || true
```

只有完整命令行包含当前项目 `server.js`、端口和正确 Node 时，才允许在 `machine-repair` 中对该 PID 执行 `kill -TERM <PID>`。不要使用 `killall node`。如果 LaunchAgent 或旧 watchdog 拉起了错误项目，只记录并报告，除非用户明确授权修改/卸载它。

## 桌面启动、深链和窗口验证

- `.app` 启动优先使用 `open -a <App.app>` 或 `open <app-path>`；不能直接把 Windows `.bat` 当作 macOS 启动器；
- 深链使用 `open '<scheme://...>'`，不要手工拼接 shell 字符串；
- 检查主窗口和激活使用 `osascript`/System Events，而不是 Win32 DLL；
- 先启动并确认主窗口，再发送 session deep link，最后再次把应用设为 frontmost；
- Electron/Node 启动 Desktop 时清理 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`。

窗口验证需要辅助功能权限。用 `osascript` 查询窗口数量并设置 frontmost；如果返回权限错误、脚本超时或只能确认进程不能确认窗口，标记 `window-focus-permission-required` 或 `session-launch-not-verified`，不能伪报跳转成功。向用户说明需要在“系统设置 → 隐私与安全性 → 辅助功能”授权实际运行 Agent Board 的 Terminal/Codex/Electron 宿主。

## macOS 平台限制

- Marvis 当前适配器只有 Windows 数据/启动链时，在 macOS 标记 `unsupported-platform`，不能用 Windows 路径猜测；
- macOS 未安装的 Agent 不由 Skill 静默安装；只报告官方安装入口和所需变体；
- 协议能打开应用但无法通过辅助功能确认窗口时，整体最多 `PASS_WITH_WARNINGS`，不能写 `PASS`；
- `start.sh`、`agent-board-watchdog.js` 和源码中的 `process.platform === 'darwin'` 分支必须通过语法测试和平台模拟测试，不能只在 Windows 上运行 `node --test` 就声称 macOS 已验证。
