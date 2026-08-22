# Agent Board：应用探测与安装管理 —— 设计文档

日期：2026-08-22
对应商业化路线图"阶段 1：安装体验"中"自动检测已装 Agent + 设置页里按需安装"部分（本设计只覆盖阶段 1，不涉及账号/鉴权/打包分发；路线图本身存在会话历史中，不在本仓库内）

## 背景

agent-board 目前对 8 个 AI Agent（claude / codex / workbuddy / deepseek / marvis / doubao / zcode / pi）的支持是硬编码的：`server.js` 里的 `AGENT_DEFS` 表写死了进程名、URL scheme、部分启动路径（其中 `deepseek` / `marvis` / `zcode` / `pi` 的启动路径直接写死了这台机器的绝对路径），换一台机器就会失效；也没有任何"检测是否已安装""按需安装"的能力。

本设计要解决两件事：
1. **探测**：判断用户机器上到底装没装某个 Agent、装在哪，替换掉硬编码绝对路径。
2. **安装**：在设置页提供"一键安装"，按工具类型自动化程度不同分层处理。

## 范围

**这轮做**：
- 8 个现有 agent 的探测配置化（`lib/adapters/*.js` 各自新增 `detect` 导出）
- 设置页新增"应用管理"模块（卡片网格布局），展示探测状态 + 安装/修复按钮
- CLI 类工具（Claude Code / Codex / Pi / DeepSeek Harness）的全自动安装链路
- GUI 类工具（WorkBuddy / ZCode / 豆包 / Marvis）的探测 + 尽力而为的安装辅助
- 探测结果对瀑布流列的默认显隐

**这轮不做**（留给后续路线图阶段）：
- 账号/鉴权/付费
- Electron/Tauri 打包
- macOS/Linux 平台的实机验证（配置里会带上非 Windows 路径，但这轮只在 Windows 上验证）
- 独立的"首次启动向导" UI（按之前的决定，首次启动只是自动跳转到设置页 + 一句提示文案）

## 参考依据

Windows 上已安装的 EchoBird（同类竞品）在 `%LOCALAPPDATA%\EchoBird\_up_\tools\` 下为每个工具维护了 `paths.json`（每个平台下该工具二进制可能出现的位置，用于探测）和 `config.json`（该工具的模型配置文件位置，EchoBird 用于"一键切换模型"，agent-board 不需要这部分）。**这个目录里没有任何安装命令配置**——EchoBird 的"一键安装"很可能是它内置的 AI 现场决定要跑什么命令，不是从静态配置读出来的。本设计的探测路径直接复用 EchoBird 的 `paths.json` 数据（纯粹是"这个工具通常装在哪"这类事实性技术信息），安装命令部分则用我们自己确定性脚本实现，不引入 LLM。

## 架构

```
public/app.js          设置页新增"应用管理"卡片网格模块
        │  GET /api/agents/status
        │  POST /api/agents/:id/install  (进度走已有 SSE /api/events)
        ▼
server.js               新增两个路由，调用 lib/detect.js
        ▼
lib/detect.js  (新文件)  通用探测/安装引擎，不认识具体 agent，只读各 adapter 的 detect 描述
        │
        ▼
lib/adapters/*.js       每个文件新增一个 detect 导出（8 个文件都要改）
```

`lib/detect.js` 是唯一的新增业务文件，其余都是在现有文件上加导出/加路由/加 UI 模块，不引入新依赖（继续零 npm 依赖）。

## 数据模型：adapter 的 `detect` 导出

```js
// 示例：lib/adapters/pi.js 新增
detect: {
  tier: 'cli',
  probe: {
    kind: 'path',                 // 'path' | 'registry'
    // 直接照抄 EchoBird paths.json 的 win32 数组
    win32: [
      '%APPDATA%\\npm\\pi.cmd',
      '%USERPROFILE%\\.local\\bin\\pi.exe',
      '%USERPROFILE%\\.bun\\bin\\pi.exe',
      '%USERPROFILE%\\.hermes\\node\\bin\\pi.exe',
      '%USERPROFILE%\\.hermes\\node\\bin\\pi.cmd',
      '%LOCALAPPDATA%\\pnpm\\pi.exe',
    ],
    versionCmd: 'pi --version',    // 找到路径后用来取版本号，取不到不算失败
  },
  install: {
    checkDeps: ['node'],           // 前置依赖，用 `node -v` 判断
    cmd: 'npm install -g @earendil-works/pi-coding-agent',
  },
},
```

`tier: 'gui'`（WorkBuddy / ZCode）用 `registry` 探测 + `install.downloadUrl`：

```js
// lib/adapters/zcode.js
detect: {
  tier: 'gui',
  probe: {
    kind: 'registry',              // 查 Windows 卸载注册表
    win32: ['%LOCALAPPDATA%\\Programs\\ZCode\\ZCode.exe'],
    registryHints: { displayNamePrefixes: ['ZCode'] },
  },
  install: {
    downloadUrl: 'https://zcode.z.ai/cn#all-downloads',
  },
},
```

豆包 / Marvis 不在 EchoBird 支持范围内，`probe.win32` 沿用 agent-board 现有 adapter 里已经写的真实数据目录路径（`doubao.js` / `marvis.js` 里已有），`install.downloadUrl` 需要单独去查官网确认，标记为待实现项（见"遗留问题"）。

## 各 agent 的分层结果

| agent | tier | 探测依据 | 安装方式 |
|---|---|---|---|
| claude | cli | EchoBird `claudecode/paths.json`（npm/bun/pnpm/winget 多路径） | `npm install -g @anthropic-ai/claude-code`（需核实包名） |
| codex | cli | EchoBird `codex/paths.json` | `npm install -g @openai/codex`（需核实包名） |
| pi | cli | EchoBird `pi/paths.json` | `npm install -g @earendil-works/pi-coding-agent` |
| deepseek (dsh) | cli | EchoBird `dsh/paths.json` | `npm install -g`（具体包名需核实，官方文档 deepseek-harness.github.io） |
| workbuddy | gui | EchoBird `workbuddy/paths.json` + registry hints（发行商 Tencent） | 官网下载安装包，下载页 `codebuddy.cn/work` |
| zcode | gui | EchoBird `zcode/paths.json` + registry hints | 官网下载安装包，下载页 `zcode.z.ai/cn#all-downloads` |
| doubao | gui | 沿用现有 `doubao.js` 的 IndexedDB 数据目录路径判断"是否用过" | 需另查官网下载地址 |
| marvis | gui | 沿用现有 `marvis.js` 的数据目录路径 | 需另查官网下载地址 |

原先打算保留的 `tier: manual` 这轮用不上（8 个 agent 都有正规安装渠道），架构上继续支持这个档位，留给以后接入真正的私有/内部工具。

## 安装链路

**tier: cli（全自动）**
1. 检查 `install.checkDeps` 声明的依赖（目前只有 `node`，跑 `node -v`）
2. 缺 Node 不做静默自动装（系统级依赖，官方建议手动装最稳），提示"需要先安装 Node.js"+下载链接，中断流程
3. 依赖齐了，展示一张确认卡片（要装什么、用什么命令），用户确认后执行 `install.cmd`
4. 执行完重新跑一次 probe 确认真的装上了；`versionCmd` 能取到版本号就算成功
5. 全程通过 SSE 广播每一步的状态（复用现有 `/api/events`，新增 `agent-install-progress` 事件类型），前端按"检测依赖中 → 安装依赖中(如需要) → 安装 xxx 中 → 校验中 → 完成/失败"渲染成时间线

**tier: gui（尽力而为，不保证零交互）**
1. probe 判断已安装/未安装
2. 未安装时"安装"按钮 = 打开 `install.downloadUrl`（这轮先做到这一步，不做自动下载+静默安装，原因见下方"遗留问题"）

**tier: manual**
- 只做 probe，卡片不出现安装按钮

## API 设计

- `GET /api/agents/status` → 并发对 8 个 adapter 跑 probe，返回 `{ [agentId]: { installed, version, path, tier } }`，前端设置页打开时调用
- `POST /api/agents/:id/install` → 触发 `lib/detect.js` 的 install 流程，进度通过已有 SSE 通道推送，不新开连接
- 是否在瀑布流里默认显示某个 agent：不新增后端路由，沿用前端现有的 `colOrder`/localStorage 机制（`public/app.js` 里"列设置"那套），只是把它的初始默认值从"全部显示"改成"探测到已安装的才默认显示"

## 前端 UI

设置页新增"应用管理"模块，用卡片网格布局（选定的 B 方案）：每张卡片 = 图标 + 名称 + 状态徽标（已启用/未检测到/检测中/检测出错）+ 一个操作按钮（修复/安装/打开下载页，按 tier 和状态变化）。

首次启动（本地从未探测过）：自动展开到这个模块所在位置，给一句提示文案（具体文案后续可迭代，不在这轮设计里定死）。不做独立的全屏引导向导。

瀑布流列：探测结果只影响默认显隐（未检测到的 agent 默认不占列），不改动现有的拖动排序/列设置逻辑。

## 错误处理

- 单个 agent probe 失败（权限/超时）→ 该卡片显示"检测出错"，不影响其他卡片，不阻塞设置页加载
- 安装某一步失败 → 停在失败的那一步，显示具体原因 + 重试按钮；不静默吞错误
- gui tier 目前没有"静默安装失败"这个状态，因为这轮就是"打开下载页"，没有自动执行安装包这一步

## 测试 / 验证方式

项目目前没有自动化测试框架，延续现状，手动验证：
- 在这台机器上跑一遍 `GET /api/agents/status`，核对 8 个 agent 的探测结果和实际安装情况是否一致
- 挑一个已安装的 CLI 工具（比如 Claude Code），验证 probe 能正确识别、版本号读取正确
- 临时卸载一个 CLI 工具（建议用侵入性最小的，比如 Pi），走一遍"未安装 → 点安装 → 自动装好 → probe 变已安装"的完整链路
- WorkBuddy/ZCode 验证探测：确认真实安装路径命中 EchoBird 提供的 `paths.json` 位置
- 验证 SSE 安装进度事件在设置页正确渲染成时间线，失败场景（比如故意用一个错误的包名）显示出清晰的失败原因

## 遗留问题 / 后续

- **claude / codex / dsh 的准确 npm 包名需要核实**：设计文档里写的是推测包名，实现前需要各自查一遍官方文档确认，不能直接假设。
- **豆包 / Marvis 的官网下载地址未确定**：这两个不在 EchoBird 支持范围，需要单独查证准确的下载页 URL，写入 `install.downloadUrl`。
- **gui tier 的静默安装**：这轮先做"打开下载页"，之后如果验证到用户对"更自动"的诉求强烈，可以调研目标安装包是否支持静默参数（NSIS/Inno Setup 常见的 `/S`、`/VERYSILENT`），或者调研 winget 是否已收录这些应用（EchoBird 的路径列表里出现过 `WinGet\Links` 字样，暗示它可能对部分工具走 winget 安装，值得后续调研复用）。
- **macOS/Linux 路径未经验证**：这轮把 EchoBird 提供的 darwin/linux 路径也搬进了配置，但没有实机验证，仅供将来跨平台时使用。
