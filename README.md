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

## 快速开始

```bash
node server.js
```

或双击 `start.bat`（Windows）/ 运行 `start.sh`（macOS/Linux）。启动后浏览器打开 `http://127.0.0.1:4876`。

开机自启/常驻后台：`agent-board-watchdog.js`（配合 `agent-board-watchdog.bat`/`.vbs`）每 30 秒检测一次服务是否存活，挂了自动拉起。

## 开发态运行

桌面版开发启动需要先安装 Electron 构建依赖：

```bash
npm install
npm run desktop:dev
```

Electron 会使用内置的本地 Node 进程启动后端，后端只监听 `127.0.0.1`。如果只需要调试后端，也可以继续使用上面的 `node server.js` 或 `start.bat`。

## 构建 Windows 安装包

在 Windows 开发机上准备固定版本的 Node 运行时和窗口聚焦 DLL，然后构建未签名的单用户 NSIS 安装包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/prepare-runtime.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-focus-dll.ps1
npm run desktop:dist
npm run desktop:verify
```

产物位于 `dist/Agent Board Setup 0.2.0.exe`。首版安装包面向 Windows x64 普通用户，不要求管理员权限；当前未启用自动更新，正式公开分发前还需要配置代码签名。

## 普通用户安装

下载安装包后双击运行，按向导选择安装目录。安装完成后可从桌面快捷方式或开始菜单启动 Agent Board；应用会自动管理本地后端，不需要用户单独安装 Node.js。

用户数据默认保存在 `%LOCALAPPDATA%\AgentBoard`，卸载应用默认保留该目录。重新安装后仍可继续使用原有数据。

## 测试

```bash
node --test
```

不要带路径参数（`node --test lib/` 在这套 Windows/Node 环境下会抛 `MODULE_NOT_FOUND`）。

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
