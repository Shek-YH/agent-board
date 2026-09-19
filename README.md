# Agent Board

本地看板，实时汇总多个 AI 编程/办公 Agent 的会话记录到一个时间线，并提供路径探测、官方下载入口和 AI 安装 Skill。

后端使用 Node.js 内置 `http` 服务 + 原生前端，运行态零 npm 依赖，单机跑在 `http://127.0.0.1:4876`；Windows 桌面版会将 Electron、Node 运行时和后端一起打包。

## 支持的 Agent

| Agent | 类型 | 说明 |
|---|---|---|
| Claude Code | 命令行 | 提供官方下载页 |
| Codex | 命令行 | 提供官方下载页 |
| Pi | 命令行 | 提供官方下载页 |
| DeepSeek Harness | 命令行 | 提供官方下载页 |
| WorkBuddy | 桌面应用 | 提供官方下载页 |
| ZCode | 桌面应用 | 提供官方下载页 |
| Marvis | 桌面应用 | 仅支持跳转官方下载页手动安装 |

## 功能

- **会话聚合**：按项目/时间线/Agent 分组展示所有会话，支持搜索、筛选、瀑布流多列布局
- **实时活跃状态**：SSE 推送，实时显示哪个会话正在进行中
- **探测引擎**：自动检测每个 Agent 装没装、装在哪、什么版本，探测结果带 5 分钟内存缓存
- **应用管理**：实时探测 Agent 安装状态；每个 Agent 都可以自动配置真实可执行文件路径，未安装时点击“打开下载页”跳转到官方下载入口；内置 Agent Board 安装 Skill，可让 AI 先询问安装范围后协助下载和安装
- **瀑布流列联动**：首页默认只显示"已安装或有历史会话数据"的 Agent 列，用户手动配置过的列设置不受影响
- **用户路径覆盖**：`~/.agent-board/tool-paths.json` 可手动指定某个命令行工具的真实安装路径，用于覆盖非标准安装位置探测不到的情况
- **数据源路径校准**：会话采集默认跟随当前用户的 `USERPROFILE`、`APPDATA` 和 `LOCALAPPDATA`，不依赖某台电脑的绝对路径；非标准位置可在 `~/.agent-board/source-paths.json` 中按 Agent 覆盖，修改后重启 Agent Board，再点击顶栏“重新扫描全部数据源”
- **运行时诊断身份**：`/api/state` 额外返回 server 启动时冻结的 `runtime` 身份（项目根目录、入口、Node、PID、启动时间和 `server.js` SHA-256），用于区分当前源码服务与旧目录常驻进程
- **健康诊断**：`/api/health` 返回当前运行实例、采集器目录是否存在、最近扫描/监听时间和错误摘要，不返回会话正文
- **可靠重扫**：顶栏重扫会真正扫描全部历史文件，不受首次启动的 30 天窗口限制；文件监听之外还有定时快照校准，目录晚创建、文件替换、删除和 WAL 重建都能被补偿

## 快速开始

```bash
node server.js
```

或双击 `start.bat`（Windows）/ 运行 `start.sh`（macOS/Linux）。启动后浏览器打开 `http://127.0.0.1:4876`。

Windows `start.bat` 优先使用项目内置的 `runtime\\node.exe`，仅在该文件不存在时回退到 PATH 中的 Node.js。正式跨电脑使用推荐 Windows 安装包；源码启动只适合开发/诊断场景。

Windows 开机自启/常驻后台可使用 `agent-board-watchdog.js`（配合 `agent-board-watchdog.bat`/`.vbs`）。watchdog 会先读取运行 marker，识别 Electron 当前实际端口；不要同时启动 Electron、`start.bat` 和多个 watchdog 实例。

## 开发态运行

桌面版开发启动需要先安装 Electron 构建依赖：

```bash
npm install
npm run desktop:dev
```

Electron 会使用内置的本地 Node 进程启动后端，后端只监听 `127.0.0.1`。如果只需要调试后端，也可以继续使用上面的 `node server.js` 或 `start.bat`。

## AutoPilot Task Intake

Session 卡片的“AI 托管”入口会先由后端重新解析当前 Session 的项目、Agent 和 Session Ref，再将任务判断为 `direct`、`light`、`standard`、`project` 或 `high_risk`。非直接任务沿用现有 Settings、Model Routing 和 WorkflowStore；高风险任务创建后保持暂停，等待人工审批。

PRD 来源支持自动判断、当前项目、允许目录内的手动文件和不使用 PRD。候选只返回文件名、版本、大小、修改时间与可信度；读取限制为 `.md`、`.mdx`、`.txt` 和 5 MB，并使用真实路径校验阻止符号链接越界。Workflow 仅保存白名单化 Task Contract 与 PRD 的 SHA-256 元数据，不保存 PRD 原文。

主要接口：

- `GET /api/orchestration/prd/candidates?sessionRef=...`：只读候选发现；也兼容受允许根校验的 `projectPath`。
- `POST /api/orchestration/intake/preview`：只读预览 Task Contract，不创建 Workflow、不 dispatch。
- `POST /api/orchestration/workflows/from-session`：重新执行 Intake；`direct` 返回旁路结果，其他等级创建现有 Workflow，`high_risk` 返回 `202` 和 `requiresApproval: true`。
- `POST /api/orchestration/prd-draft`：旧 PRD 草稿接口保持兼容。

开发验证可运行：

```bash
node --test lib/orchestrator/task-intake.test.js lib/orchestrator/project-prd.test.js lib/orchestrator/http.test.js public/autopilot-fast-path.test.js public/autopilot-ui.test.js
npm test
```

如果候选接口返回 `PRD_SELECTION_REQUIRED`，必须由用户选择具体版本；`PRD_PATH_OUTSIDE_ALLOWED_ROOTS` 表示文件不在允许根目录。Supervisor 不可用或 AI JSON 校验失败时会回退到确定性解析，并在预览中返回 warning 和缺失字段，不会伪装成 AI 已完成分析。详细设计见 `docs/superpowers/specs/autopilot-task-intake.md`。

## 构建 Windows 安装包

在 Windows 开发机或 CI 上构建未签名的单用户 NSIS 安装包。`desktop:dist` 会先校验固定版本的 Node 运行时和构建窗口聚焦 DLL，再执行打包。runtime 优先取项目内的 `runtime\\node.exe`，也可通过 `AGENT_BOARD_NODE_SOURCE` 或 `-Source` 指定，不再依赖某台电脑的 WorkBuddy 私有目录：

```powershell
npm run desktop:dist
npm run desktop:verify
```

产物位于 `dist/Agent Board Setup 0.2.0.exe`。首版安装包面向 Windows x64 普通用户，不要求管理员权限；当前未启用自动更新，正式公开分发前还需要配置代码签名。构建完成后必须运行 `npm run desktop:verify`，它会检查资源完整性、runtime 大小和机器绝对路径泄漏。

## 普通用户安装

下载安装包后双击运行，按向导选择安装目录。安装完成后可从桌面快捷方式或开始菜单启动 Agent Board；应用会自动管理本地后端，不需要用户单独安装 Node.js。

用户数据默认保存在 `%LOCALAPPDATA%\AgentBoard`，卸载应用默认保留该目录。重新安装后仍可继续使用原有数据。

## 测试

```bash
node --test
```

不要带路径参数（`node --test lib/` 在这套 Windows/Node 环境下会抛 `MODULE_NOT_FOUND`）。

## 安全边界

桌面模式的变更请求必须通过 loopback、受限 Host/Origin、JSON Content-Type 与 Runtime Bearer Token 校验；WorkBuddy 状态 Hook 和 Agent 完成 Hook 使用彼此独立的 Bearer Token。完成 Hook 的本机配置位于 `%LOCALAPPDATA%\AgentBoard\hooks\complete-hook.json`，由后端启动时生成，不能复制到前端、日志或版本库。更多兼容性与验证记录见 [SECURITY_FIX_2026-09.md](docs/security/SECURITY_FIX_2026-09.md)。

### 数据源路径配置

默认路径会按当前运行用户和平台解析。若某个 Agent 把数据放在非默认位置，在配置目录创建 `source-paths.json`；Windows 默认配置目录为 `%USERPROFILE%\.agent-board`，也可用 `AB_CONFIG_DIR` 指定。

```json
{
  "claude": "D:\\AgentData\\claude-projects",
  "codex": {
    "root": "D:\\AgentData\\codex-sessions",
    "sessionIndex": "D:\\AgentData\\codex-index.jsonl"
  },
  "workbuddy": {
    "root": "D:\\AgentData\\workbuddy-projects",
    "heartbeatDir": "D:\\AgentData\\workbuddy-heartbeats",
    "db": "D:\\AgentData\\workbuddy.db"
  },
  "deepseek": "D:\\AgentData\\deepseek-sessions",
  "marvis": "D:\\AgentData\\marvis\\User",
  "zcode": "D:\\AgentData\\zcode-db",
  "pi": "D:\\AgentData\\pi-sessions",
  "hermes": {
    "root": "D:\\AgentData\\hermes",
    "db": "D:\\AgentData\\hermes\\state.db"
  }
}
```

`/api/health` 会返回实际使用的采集器根目录和当前配置文件位置；配置只影响 Agent Board 读取，不会移动、修改或删除第三方 Agent 数据。

## 项目结构

```
server.js              # HTTP 服务 + 全部 API 路由
lib/
  adapters/*.js         # 每个 Agent 一个适配器：会话解析 + 探测/安装配置
  detect.js              # 探测/路径配置引擎（probe/用户路径覆盖）
  store-sqlite.js         # SQLite 会话存储
  watcher.js               # 本地会话目录文件监听
public/
  index.html, app.js       # 前端（原生 JS，无构建工具）
  downloads/                # 可供用户下载的 Agent Board 安装 Skill
skills/
  agent-board-install-agents/ # Windows Agent 安装 Skill 源文件
docs/superpowers/
  specs/*.md                 # 各功能的设计文档
  plans/*.md                  # 各功能的实现计划（含任务拆分、验证步骤）
```

## 数据存储

会话数据落盘在 `%LOCALAPPDATA%\AgentBoard\data.json`（不进版本库）。历史上尝试过 SQLite 落盘方案被部分国内安全软件误判锁库，故退回 JSON。

## License

闭源，保留所有权利，见 [LICENSE](LICENSE)。
