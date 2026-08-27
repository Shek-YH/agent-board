# 跨平台通用校准规则

本文件适用于 Windows/macOS。平台命令、平台默认目录和窗口激活方式必须由入口 Skill 交给 `windows.md` 或 `macos.md`，本文件只描述不随平台改变的事实、配置和验收规则。

## 1. 环境基线

记录：

- 当前用户、平台、架构、项目根目录、源码版/开发版/打包版；
- `sourceCommit`、`workingTreeModified`、修改文件数、未跟踪文件数和当前源码快照哈希；
- Node/Electron 版本、实际 `process.execPath`、端口、server PID、父 PID、工作目录；
- 数据目录、配置目录、`tool-paths.json`、`launch-overrides.json`、日志目录；
- 旧配置、旧项目目录、旧 server、旧启动项和旧 watchdog 是否存在。

当前项目如果有未提交或未跟踪修改，不能只用 commit 判断 A/B 一致。优先复制完整工作树；不能完整复制时生成 `source-manifest.json`，记录跟踪文件 diff hash、未跟踪文件及 hash、生成时间和项目根目录。否则标记 `source-snapshot-unreproducible`。

## 2. server 身份与端口

端口返回 200 不等于使用了最新源码。先取得端口监听 PID，再读取 `/api/state`，核对：

```text
runtime.pid                 = 监听端口 PID
runtime.serverRoot          = 当前项目根目录
runtime.serverEntry         = 当前 server.js
runtime.nodeRuntime         = 实际运行 Node
runtime.port                = 当前端口
runtime.serverEntrySha256   = 启动前计算的当前 server.js 哈希
runtime.startedAt           >= 本次源码复制/修改时间
```

任一项不一致标记 `runtime-identity-mismatch` 和 `stale-server-process`。旧版本没有 runtime 字段时，使用完整命令行、工作目录、Node 路径、PID 和启动时间兼容核对，并明确这是降级证据。

在 `machine-repair` 中只能按完整命令行确认属于当前项目、当前端口的 Agent Board server 后按 PID 停止并重启。重启后重新读取 `/api/state`、`/api/agents/status?force=1` 和关键版本字段；不能把旧 API 返回当作新源码证据。

## 3. 路径、数据和配置

检查项目根目录是否包含 `package.json`、`server.js`、`lib/`、`public/` 和需要的 `desktop/`/runtime。路径必须从当前文件系统、脚本自身位置、`__dirname`、`process.execPath`、Electron `resourcesPath` 或当前用户环境变量解析，不能复制其他电脑的绝对路径。Windows Claude Desktop 的 MSIX 路径要通过项目的 `resolveClaudeDesktopExe()` 解析；WindowsApps 无法枚举时读取应用包注册表，不把目录访问失败误判为未安装。

非干净环境的旧配置按以下顺序处理：

1. 读取并记录旧值摘要，不输出凭据；
2. 备份文件；
3. 只保留当前平台且文件真实存在的路径；
4. 将 CLI 路径写入 `tool-paths.json`，将 Desktop 路径写入 `launch-overrides.json` 的 `manualDesktop.target`；
5. 重新读取 JSON，验证路径、变体、版本和 API 探测结果。

不能把 `*`/`?` 通配符写入最终配置；只能用它们扫描版本目录，最后保存具体文件。

## 4. Agent 变体和状态

对每个 Agent 先读取 adapter 的 `identityGuard`、`tier`、`probe` 和 `desktopProbe`，再分别探测 CLI 与 Desktop：

- 真实 CLI 路径可以在用户明确授权后写入 `tool-paths.json`；
- Desktop 只写入 `launch-overrides.json` 或作为 GUI 启动目标；
- 找到 Desktop 不能证明 CLI 已安装；找到 CLI 不能证明存在可聚焦窗口；
- 独立绝对路径 `--version` 成功但 `/api/agents/status?force=1` 的 `version` 为空时，标记 `installed-but-version-check-failed`；
- 注册表、应用包或数据目录存在但可执行文件缺失时，不能伪报已安装；
- 未安装、当前平台不支持或数据源没有 user/assistant 消息时，要分别报告 `not-installed`、`unsupported-platform`、`data-source-present-no-messages`。

路径、版本、变体、数据源和启动状态必须分别记录，不能用一个 `installed=true` 覆盖所有问题。

桌面 Agent 的 CLI 命令名、应用显示名和实际进程名可能不同。前台验证必须以当前平台实际进程映像名为准（Windows 用 `Get-Process` 的 `ProcessName`，macOS 用 `ps`/`pgrep` 结果），并记录 `MainWindowHandle`/窗口数量；不能把 `pi`、应用标题或 CLI shim 直接当作 Pi Desktop 的进程名。发现“进程已出现但窗口验证失败”时，回溯 adapter 的平台进程名映射，再验证启动接口和前台句柄。

协议原生 Agent 需要单独处理：Codex 的 Windows Store/Electron 进程可能没有稳定的可见主窗口，不能用猜测的 `Codex` 进程名等待 9 秒，也不能把 `windowVerified=false` 当作深链失败。Codex session 跳转只投递经过校验的固定 `codex://` 深链，返回 `action=protocol-dispatched`、`windowVerified=null`，再用实际 Codex UI 或用户确认完成可见性验证。该例外只适用于窗口探测本身不可靠的协议原生 Agent，不能套用到 Hermes、Pi、WorkBuddy、DeepSeek 等有真实主窗口进程名的桌面端。

## 5. 启动与 session 卡片

“spawn 成功”“URL scheme 返回 0”只代表请求交给了操作系统，不代表软件有可用窗口。所有顶栏启动、应用管理启动和 session 卡片都遵循：

1. 检查主窗口，不只检查后台服务、CLI 或协议进程；
2. 未运行时解析真实 Desktop 主程序并启动；
3. 等待主窗口确认；
4. 再发送 session deep link；
5. 再次激活窗口；
6. 返回并记录 `running`、`launched`、`windowVerified`、深链结果和错误恢复建议。

Marvis 的 `MarvisLauncher.exe` 只负责协议转发，不能代替 `Marvis.exe` 主程序。Electron/Node 启动 Desktop 时清理 `ELECTRON_RUN_AS_NODE` 和 `NODE_OPTIONS`。Claude Windows session 不能把后台 `Claude.exe` 进程存在当作可见窗口成功：导入 CLI 会话的 resume 深链只带 `session` 参数；session 按钮必须先打开 Claude Desktop，再异步由 UIA 定位目标 Code 会话；UIA 失败只能记录并提示 Desktop 未定位，不能自动改开 CLI。CLI 的 `claude --resume <sessionId>` 只能由用户从“更多”菜单显式选择。

ZCode Windows Desktop 当前只处理 `--open-workspace <path>` 和 `zcode://workspace/open?path=...`，没有可验证的 session 深链；不要把 `ZCode.exe --resume <sessionId>` 当作 Desktop 跳转方式。ZCode session 卡片必须先按 session 的 `directory/project` 启动或投递 workspace，再用 Windows UI Automation 找到 `group/task-item` 的任务项并真实鼠标点击；UIA 找不到或同名多项时必须返回失败，不能只因 ZCode 进程存在就显示成功。ZCode `resources/glm/zcode.cjs` 即使存在，也要先确认 `@zcode/tui` 等运行时依赖完整，不能把 Desktop 内置但缺依赖的 CLI bundle 当成可用恢复入口。

macOS 如果 `osascript/System Events` 因辅助功能权限无法确认窗口，必须标记 `window-focus-permission-required`；可以报告“启动请求已发送”，不能报告“窗口跳转已验证”。

前端 session 卡片验收不能只依赖脆弱的绝对 XPath。优先使用 `.s-jump[data-action="jump-session"]`、`data-agent` 和 `data-session-id`；如果外部自动化必须使用位置选择器，源码必须保持稳定契约：普通卡片操作区第一个 `button` 是“更多”、第二个是“跳转”；已完成/刚完成卡片则固定为“更多” → “已读” → “跳转”，因此跳转按钮位于“已读”右侧并占用第三个 `button` 位置。点击后必须同时记录：目标 Agent、目标 session ID、HTTP 状态/响应、窗口前台进程和窗口标题；不能把点击事件触发或 API `ok=true` 单独当成跳转成功。

## 6. 备份和回滚

备份至少包括实际修改的路径配置、启动覆盖和当前平台启动入口。报告记录：修改前摘要、修改后摘要、备份绝对路径、恢复命令/步骤。失败时优先恢复备份，再报告阻塞原因；不要通过删除数据目录或清空数据库恢复。

## 7. 验收报告

输出以下字段：

```text
overall: PASS | PASS_WITH_WARNINGS | BLOCKED
mode: readonly | machine-repair | source-repair
platform: win32 | darwin | other
projectRoot / sourceType / sourceCommit / workingTreeModified
nodeRuntime / nodeVersion / port / runtime.pid / runtime.serverEntrySha256
dataDir / configDir / contaminationStatus
```

至少包含四张表：路径检查、Agent CLI/Desktop 检查、启动按钮验证、Session 卡启动/跳转验证。每张表都区分“已验证事实”“推断”“建议”。

只有服务、Agent 探测、窗口启动和至少一个 session 跳转都满足完成标准时才能写 `PASS`；非稳定项目根目录、脏源码未生成快照、平台权限不足、未安装 Agent 或只完成扫描时至少写 `PASS_WITH_WARNINGS`。
