# Agent Board

本地看板，实时汇总多个 AI 编程/办公 Agent 的会话记录到一个时间线，并提供一键检测/安装这些 Agent 的能力。

纯 Node.js 内置 `http` 服务 + 原生前端，零 npm 依赖，无需构建工具，单机跑在 `http://127.0.0.1:4876`。

## 支持的 Agent

| Agent | 类型 | 说明 |
|---|---|---|
| Claude Code | 命令行 | 支持一键安装 |
| Codex | 命令行 | 支持一键安装 |
| Pi | 命令行 | 支持一键安装 |
| DeepSeek Harness | 命令行 | 支持一键安装 |
| WorkBuddy | 桌面应用 | 支持一键安装（winget） |
| ZCode | 桌面应用 | 支持一键安装（winget） |
| Marvis | 桌面应用 | 仅支持跳转官方下载页手动安装 |
| 豆包（Doubao） | 桌面应用 | 仅支持会话读取，不再纳入后续开发范围 |

## 功能

- **会话聚合**：按项目/时间线/Agent 分组展示所有会话，支持搜索、筛选、瀑布流多列布局
- **实时活跃状态**：SSE 推送，实时显示哪个会话正在进行中
- **探测引擎**：自动检测每个 Agent 装没装、装在哪、什么版本，探测结果带 5 分钟内存缓存
- **安装引擎**：应用管理弹窗里点击即可安装未装的 Agent（命令行类走 npm/winget/官方脚本，桌面类能静默装的走 winget，不能的直接跳转官方下载页），安装前有确认框展示真实要执行的命令，安装中有实时进度
- **瀑布流列联动**：首页默认只显示"已安装或有历史会话数据"的 Agent 列，用户手动配置过的列设置不受影响
- **用户路径覆盖**：`~/.agent-board/tool-paths.json` 可手动指定某个命令行工具的真实安装路径，用于覆盖非标准安装位置探测不到的情况

## 快速开始

```bash
node server.js
```

或双击 `start.bat`（Windows）/ 运行 `start.sh`（macOS/Linux）。启动后浏览器打开 `http://127.0.0.1:4876`。

开机自启/常驻后台：`agent-board-watchdog.js`（配合 `agent-board-watchdog.bat`/`.vbs`）每 30 秒检测一次服务是否存活，挂了自动拉起。

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
  detect.js              # 探测/安装引擎（probe/pickMethod/installAgent）
  store-sqlite.js         # SQLite 会话存储
  watcher.js               # 本地会话目录文件监听
public/
  index.html, app.js       # 前端（原生 JS，无构建工具）
docs/superpowers/
  specs/*.md                 # 各功能的设计文档
  plans/*.md                  # 各功能的实现计划（含任务拆分、验证步骤）
```

## 数据存储

会话数据落盘在 `%LOCALAPPDATA%\AgentBoard\data.json`（不进版本库）。历史上尝试过 SQLite 落盘方案被部分国内安全软件误判锁库，故退回 JSON。

## License

闭源，保留所有权利，见 [LICENSE](LICENSE)。
