---
name: agent-board-new-machine-path-setup
description: 跨 Windows 和 macOS 自动初始化、诊断、修复和验证 Agent Board 的非干净环境。只要用户提到 Agent Board 换电脑、重装后路径错误、已有旧配置/旧 server、Agent 检测不到、启动按钮无窗口、session 卡片不能跳转、4876 端口返回旧结果、Node/Electron 路径不一致、WindowsApps/Claude Desktop 路径错误、Windows 或 macOS 适配，就使用此 Skill。它会识别当前平台并读取对应的 Windows/macOS 专项规则；用户明确要求初始化、修复、配置好或正常使用时，完成审计后直接执行可回滚的用户级 machine-repair，不要反复询问普通路径配置。
---

# Agent Board 跨平台环境初始化入口

这是用户面对的统一入口，不把 Windows 和 macOS 规则复制到一个大文件里。执行时必须：

1. 先读取本目录的 `references/common.md`。
2. 根据当前实际 `process.platform` 只读取一个平台文件：`win32` 读取 `references/windows.md`，`darwin` 读取 `references/macos.md`；其他平台只能做通用诊断并标记 `unsupported-platform`。
3. 先完成只读基线，再根据用户意图选择模式：
   - `readonly`：用户说诊断、查看、报告；不改配置、不结束进程。
   - `machine-repair`：用户说初始化、修复、配置好、正常使用；备份后自动修复用户级路径/启动覆盖、精确重启 Agent Board 自身旧 server，并最多自动重试一次。
   - `source-repair`：适配器、启动链、跨平台源码和测试缺陷；必须明确列出源码改动和验证结果。
4. 只把当前电脑真实存在且通过版本/启动验证的路径写入配置。不能复制 A 电脑绝对路径，不能把 Desktop 写入 CLI 配置，不能把候选通配符写入最终配置。
   - Claude Desktop 的 Windows MSIX 安装例外：WindowsApps 目录可能拒绝普通枚举，必须先用 `lib/claude-desktop-path.js` 的注册表解析逻辑找到 `PackageRootFolder`，再拼接 `app\\claude.exe`；不能因为 `Get-ChildItem WindowsApps` 失败就判定未安装。
   - Claude Desktop 的 `claude.exe` 与 Claude Code CLI 的 `claude.cmd` 是两个变体：前者只作为 GUI 启动目标，后者才允许写入 `tool-paths.json`。
5. 如果目标 Agent 未安装、当前平台没有该 Agent、或 macOS 辅助功能权限阻止窗口验证，必须明确报告，不得伪造“正常使用”。

## 统一安全边界

- 不安装/卸载第三方 Agent，不删除用户数据，不修改系统 PATH、注册表、计划任务、Startup、LaunchAgent 或登录项，除非用户另行授权。
- 不读取、上传或输出会话正文、令牌、密码、`.env`、凭据文件；报告只保留路径、版本、PID、状态、错误摘要和日志尾部。
- 修改 `tool-paths.json`、`launch-overrides.json` 或机器级启动配置前必须备份；写入后重新读取、验证文件存在性和 API 探测结果；失败时恢复备份。
- 只能按项目根目录、完整命令行和 runtime 身份精确识别 Agent Board 自己的进程。禁止使用 `taskkill /IM node.exe`、批量 `killall node` 或结束所有 Node 进程。

## 执行顺序

### 1. 识别当前环境

确认当前用户、操作系统、架构、项目根目录、源码版/开发版/打包版、Node/Electron 版本、端口、数据目录、配置目录、源码 commit、工作区修改和未跟踪文件。项目根目录必须通过当前文件系统和 `git rev-parse --show-toplevel` 确认；不能从旧电脑路径猜测。

如果当前项目位于时间戳 WorkBuddy 目录、下载目录、网盘同步目录、临时目录或网络盘，标记 `unstable-project-root`。不要自动移动正在运行的项目；建议迁移到稳定的本地目录后重新验证。

如果用户说是“全新环境”，同时检查旧数据目录、旧配置、旧 server、旧启动项和旧项目压缩包。发现任何残留都标记 `contaminated-test-environment`，不能把“当前可运行”写成“干净环境通过”。

### 2. 读取通用规则并做平台审计

按照 `references/common.md` 检查：

- 项目、Node/Electron、server、数据和配置的路径链；
- runtime `serverRoot/serverEntry/nodeRuntime/pid/port/serverEntrySha256` 与当前监听进程是否一致；
- Agent CLI/Desktop 变体、实际可执行文件、版本和数据源；
- `tool-paths.json` 与 `launch-overrides.json` 是否把其他电脑路径带入当前环境；
- `/api/state`、`/api/agents/status?force=1`、关键版本字段和 session 数据源；
- session 卡片的“已运行直接跳转”和“未运行先启动再跳转”；必须确认真实主窗口后再发送深链。

### 3. 执行当前平台规则

读取对应平台 reference 后，只执行该平台的命令、路径和启动方式：

- Windows：PowerShell、注册表、`.exe/.cmd/.bat`、Win32 主窗口、Startup/计划任务；
- macOS：bash/zsh、`/Applications`/`~/Applications`、`.app/Contents/MacOS`、`open`、`osascript`、LaunchAgent 和辅助功能权限。

不能把 Windows 注册表、`cmd.exe`、`C:\Users\...` 或 `MarvisLauncher.exe` 规则带到 macOS；也不能把 macOS `.app` 路径写回 Windows 配置。

### 4. machine-repair 的自动修复顺序

用户已经明确要求初始化/修复/正常使用时，按以下顺序执行，不把每一个普通用户级路径再拆成确认问题：

1. 记录当前 server PID、完整命令行、工作目录、runtime 身份和旧日志摘要。
2. 备份需要修改的 `tool-paths.json`、`launch-overrides.json` 和当前平台启动配置。
3. 对每个已安装 Agent 执行“探测 → 选择 CLI/Desktop 变体 → 写入具体路径 → 强制重探测 → 版本验证”。
4. 对桌面 Agent 执行“解析真实主程序 → 启动主程序 → 确认窗口 → 发送深链 → 再次聚焦”。Marvis 只能启动 `Marvis.exe`；启动器只负责发送协议。
5. 按 PID 精确重启属于当前项目和当前端口的旧 Agent Board server；不结束其他软件进程。
6. 重新验证 `/api/state`、`/api/agents/status?force=1`、关键版本字段、启动按钮和 session 卡片。
7. 失败时最多自动修正一次路径并重试一次；仍失败则输出真实路径、失败阶段、变体、权限要求和可执行下一步。

### 5. 必须生成的结果

在项目诊断目录生成脱敏的：

- `agent-board-初始化校准报告.md`
- `agent-board-diagnostics.json`

报告必须区分“已验证事实”“推断”“建议”，并包含 `overall: PASS | PASS_WITH_WARNINGS | BLOCKED`。未安装 Agent、平台不支持、辅助功能权限不足、源码快照不可复现和非稳定项目根目录都要单独列为风险。

## 完成标准

只有同时满足以下条件才能报告“已完成”：

- 当前平台和实际项目/运行时已确认；
- 数据目录、配置目录和用户级配置可读写；
- 当前平台适用的 Agent 路径、版本、变体和数据源状态明确；
- 当前监听 server 的 runtime 身份与项目根目录、入口、Node、端口和源码哈希一致；
- 至少一个已安装桌面 Agent 的启动入口确认真实主窗口存在；
- 至少一个 session 卡片完成已运行跳转或未运行冷启动跳转，且返回 `running/launched/windowVerified` 与实际窗口一致；
- 完整测试和关键 API 验证结果已记录；
- 所有已执行修改可回滚，备份路径和回滚方式已记录。

如果只完成路径扫描、没有完成启动或窗口验证，状态必须是 `PASS_WITH_WARNINGS` 或 `BLOCKED`，不能写成成功。
