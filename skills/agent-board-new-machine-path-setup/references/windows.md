# Windows 平台专项规则

仅在 `process.platform === 'win32'` 时读取和执行本文件。不要把本文件中的命令、路径或注册表规则带到 macOS。

## 环境和路径

优先使用 PowerShell 5.1+：

```powershell
$PSVersionTable.PSVersion
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsArchitecture
Get-Location
Get-Command node -ErrorAction SilentlyContinue
where.exe node
```

源码版 runtime 选择顺序：

1. 项目 `runtime\node.exe`；
2. 当前 PATH 中的 `node.exe`；
3. 明确配置的 `AGENT_BOARD_NODE_RUNTIME`。

启动脚本必须从自身目录解析项目根目录：`%~dp0`、`WScript.ScriptFullName` 或 `__dirname`。`start.bat` 优先 `%~dp0runtime\node.exe`，缺失才回退 `where node`；两者都缺失时明确报错并退出。不能保留 A 电脑的 `C:\Users\...`、旧盘符或 WorkBuddy 托管 Node 路径。

默认机器目录：

- 数据：`%LOCALAPPDATA%\AgentBoard`；
- 配置：`%USERPROFILE%\.agent-board`；
- Electron 日志：从 `app.getPath('logs')`、userData 和启动输出逐层确认，不要猜固定目录。

## Agent 探测

使用当前用户环境和当前 server 进程分别执行：

```powershell
Get-Command <agent> -All -ErrorAction SilentlyContinue
where.exe <agent>
Get-ChildItem Env: | Where-Object Name -Match 'PATH|LOCALAPPDATA|APPDATA|PROGRAMFILES'
```

再检查：

- `%APPDATA%\npm`、`%LOCALAPPDATA%`、`%USERPROFILE%\.local\bin`、`%USERPROFILE%\.bun\bin`、pnpm/bun/npm 目录；
- `%PROGRAMFILES%`、`%PROGRAMFILES(x86)%` 以及已确认的非系统盘应用目录；
- 卸载注册表：`HKCU/HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall` 和 `WOW6432Node`。

Claude Desktop 的 Windows MSIX 安装必须单独处理：WindowsApps 受系统保护，普通权限下 `Get-ChildItem C:\Program Files\WindowsApps` 失败并不表示未安装。按以下顺序解析真实主程序：

1. 如果 `CLAUDE_DESKTOP_EXE` 已设置且 `Test-Path -LiteralPath` 成功，使用该绝对路径；
2. 检查当前已验证的 `C:\Program Files\WindowsApps\Claude_1.37937.1.0_x64__pzs8sxrjxfjjc\app\claude.exe`；
3. 目录无法枚举时，使用应用包注册表查找版本目录，不扫描整个磁盘：

```powershell
$root = 'HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
$key = reg.exe query $root /f 'Claude_*_x64__pzs8sxrjxfjjc' /k
reg.exe query '<上一步返回的完整 key>' /v PackageRootFolder
```

将返回的 `PackageRootFolder` 与 `app\claude.exe` 拼接，并用 `Test-Path -LiteralPath` 验证。项目代码应复用 `lib/claude-desktop-path.js`，不能把带 `*` 的通配符写入最终配置。若只能确认应用注册而无法读取 exe，启动可使用 `shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude` 作为 Shell 入口，但不得把它伪装成 exe 路径。

注册表命中只是线索。必须在 `InstallLocation`/`DisplayIcon` 的有限深度内找到真实主程序，不能扫描整个磁盘，也不能把残留注册表当成可启动文件。

版本校验规则：

- `.exe` 直接以绝对路径和 argv 执行；
- `.cmd/.bat` 使用 `cmd.exe /d /s /c call "具体路径" 参数`；
- 不使用 `cmd.exe /c "路径 参数"` 这种会误解析带空格路径的写法；
- 独立版本和 `/api/agents/status?force=1` 的版本必须同时成功。

已知可作为候选而非硬编码的路径：

- Codex CLI：`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`；
- DSH Desktop：`%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe`；
- Claude Desktop：优先使用 `lib/claude-desktop-path.js` 解析的真实 `claude.exe`；当前 MSIX 版本为 `C:\Program Files\WindowsApps\Claude_1.37937.1.0_x64__pzs8sxrjxfjjc\app\claude.exe`，版本变化时通过应用包注册表重新解析；
- ZCode：`%LOCALAPPDATA%`、`%PROGRAMFILES%`、`%PROGRAMFILES(x86)%` 和已验证的 D 盘安装根。

## 进程、端口和旧 server

确认端口 PID：

```powershell
Get-NetTCPConnection -LocalPort 4876 -State Listen | Select-Object OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | Select-Object ProcessId,CommandLine,ExecutablePath,ParentProcessId
```

只有完整命令行包含当前项目 `server.js`、端口和正确 Node 时，才允许在 `machine-repair` 中按 PID 停止。停止前记录 PID、命令行、工作目录、runtime 和日志；重启后重新核对 `/api/state` 的 runtime。

## 桌面启动和窗口验证

- `.exe` 冷启动使用 Windows Shell 语义，允许空格、中文和非系统盘路径；
- 对有可靠桌面主窗口的 Agent，先确认主窗口的 `MainWindowHandle`，再发深链；Codex 属于例外：不能用猜测的 `Codex` 进程名做阻塞式窗口验证，只投递固定格式 `codex://` 深链并报告 `protocol-dispatched`；
- `Marvis.exe` 是主程序，`MarvisLauncher.exe` 只用于发送 `marvis://`；
- 冷启动和深链启动都清理 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`；
- Claude Desktop session 跳转必须先启动已解析的 `claude.exe`，等待主窗口，再发送 `claude://` session 深链；不能把深链协议当作唯一的冷启动入口；
- ZCode Desktop 只把 `--open-workspace <path>` 作为工作区入口，不支持 session 深链；冷启动时首次启动就要带 workspace 参数，已运行时再投递同一参数给单实例，随后用 UI Automation 在 `group/task-item` 中按标题定位并真实鼠标点击目标任务。ZCode 的 `resources\glm\zcode.cjs --resume` 只有在 `@zcode/tui` 依赖完整且独立 CLI 验证通过时才可用，不能从 Desktop 安装包路径直接假定可运行；任务卡不在 Desktop 列表或标题多匹配时返回失败并说明原因；
- `windowVerified=false` 时返回 `launch-not-verified` 或 `session-launch-not-verified`，不能只因 `spawn` 不报错就显示成功。

窗口/进程证据可使用 `Get-Process -Name <name>` 并确认 `MainWindowHandle -ne 0`；不要把后台服务、CLI、协议命令或无窗口 Electron 子进程当作成功。

session 卡片回归测试必须覆盖普通完成卡和带“已读”按钮的刚完成卡。使用真实页面点击 `.s-jump[data-action="jump-session"]`；若验证位置选择器，普通卡的跳转按钮是第二个 `button`，已完成/刚完成卡的顺序是“更多” → “已读” → “跳转”，跳转按钮是第三个 `button`。等待接口返回后，再用 `GetForegroundWindow`/Win32 前台句柄核对目标进程和窗口标题；如果 API 成功但前台仍是浏览器或其他程序，状态只能记为 `session-launch-not-verified`，继续检查进程名、窗口句柄、桌面端深链和焦点 DLL/PowerShell 输出。Codex 如果返回 `protocol-dispatched`，记录协议投递和实际 UI 结果分离，不能把 `windowVerified=null` 误判成代码错误；Claude 导入会话如果 UIA 返回 `not_found`，必须确认 session 按钮没有触发 `/api/open-with`，只报告 Claude Desktop 未定位；只有点击“更多”菜单的 CLI 恢复操作才允许打开 `claude --resume` 终端。

## Windows 启动入口

检查 `start.bat`、`launch.vbs`、`start-server.vbs`、`agent-board-watchdog.bat/.vbs/.js`、Startup 快捷方式和计划任务是否引用当前项目。除非用户另行授权，不自动修改计划任务、Startup 或系统 PATH；普通用户路径只写 `tool-paths.json`/`launch-overrides.json`。
