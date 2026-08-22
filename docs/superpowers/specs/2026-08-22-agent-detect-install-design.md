# Agent Board：应用探测与安装管理 —— 设计文档

日期：2026-08-22（v2，参考 EchoBird 安装规范汇总重写）
对应商业化路线图"阶段 1：安装体验"中"自动检测已装 Agent + 设置页里按需安装"部分（本设计只覆盖阶段 1，不涉及账号/鉴权/打包分发；路线图本身存在会话历史中，不在本仓库内）

## 背景

agent-board 目前对 8 个 AI Agent（claude / codex / workbuddy / deepseek / marvis / doubao / zcode / pi）的支持是硬编码的：`server.js` 里的 `AGENT_DEFS` 表写死了进程名、URL scheme、部分启动路径（其中 `deepseek` / `marvis` / `zcode` / `pi` 的启动路径直接写死了这台机器的绝对路径），换一台机器就会失效；也没有任何"检测是否已安装""按需安装"的能力。

本设计要解决两件事：
1. **探测**：判断用户机器上到底装没装某个 Agent、装在哪，替换掉硬编码绝对路径。
2. **安装**：在设置页提供"一键安装"，按工具类型和可自动化程度分层处理。

## 参考资料与可信度

两份参考，可信度不同，处理方式也不同：

1. **本机 EchoBird 安装目录** `%LOCALAPPDATA%\EchoBird\_up_\tools\`（一手，可直接读）
   - 每个工具一份 `paths.json`（各平台下二进制的候选位置，用于探测）+ `config.json`（该工具的模型配置文件位置与读写映射）
   - **这个目录里没有任何安装命令** —— EchoBird 把安装定义放在仓库的 `docs/api/tools/install/<id>.json`，本机安装包里没带
   - 本设计的**探测路径直接复用这份数据**（属于"这个工具通常装在哪"的事实性技术信息）

2. **`F:\AIagent自动安装包\EchoBird_AI_Agent_App_Manager_安装与配置规范汇总.md`**（二手，AI 从 EchoBird 仓库整理，正文含 `fileciteturn` 引用残留）
   - 提供了安装命令、依赖版本、identity guard、镜像策略、用户路径覆盖等设计，价值很高
   - 但**属于 AI 生成的汇总，个别条目需落地前再验证**。已抽查两条：
     - ✅ `@deepseek-ai/dsh` 属实（npm 上真实存在，Node ^22.19 或 ≥24，`dsh web` 起在 127.0.0.1:3080）
     - ❌ `winget install --id Tencent.WorkBuddy` **未能证实**（能查到 `Tencent.WeChat` / `Tencent.TencentDocs` 等其他腾讯 winget 包，唯独没有 WorkBuddy）——本设计按"未证实"处理
   - ✅ `@earendil-works/pi-coding-agent` 与用户提供的真实安装记录一致，可信

**实现约定：所有安装命令在写进代码前必须各自实跑一次验证，不得直接照抄本文档。**

## 范围

**这轮做**：
- 8 个现有 agent 的探测配置化（`lib/adapters/*.js` 各自新增 `detect` 导出）
- 设置页新增"应用管理"模块（卡片网格布局），展示探测状态 + 安装/修复按钮
- 可自动化安装的工具的全自动安装链路（含依赖检查、安装、验证、刷新）
- GUI 类工具的探测 + "下载并打开安装器，由用户完成向导"
- Identity guard（防止装错同名/近名产品）
- 用户自定义路径覆盖（`~/.agent-board/tool-paths.json`）
- 镜像降级策略（官方源失败后再切国内镜像）
- 探测结果对瀑布流列的默认显隐

**明确不做（非目标，非遗漏）**：
- **模型配置读写映射**（EchoBird `config.json` 那套 `read`/`write` 字段映射）。那是 EchoBird "统一模型中心"的核心功能；agent-board 是**会话看板**，不负责替用户改各 Agent 的模型/API Key 配置。引入这个能力等于新增一个"能改用户所有 AI 工具凭据"的高危面，与本产品定位无关。
- **首次启动的 onboarding 自动化**（如给 Claude Code 写 `~/.claude.json` 的 `hasCompletedOnboarding: true`、写 `allowedTools`）。EchoBird 需要它是因为它要以非交互方式代启 Agent；agent-board 的 `/api/open-with` 是**开一个终端窗口让用户自己交互**，不存在卡在 onboarding 的问题。替用户改 Claude Code 的权限白名单属于越权。
- 账号/鉴权/付费、Electron/Tauri 打包（后续路线图阶段）
- macOS/Linux 实机验证（配置里会带上非 Windows 路径，但这轮只在 Windows 上验证）
- 独立的全屏"首次启动向导" UI（按既定决策，首次启动只是自动跳到设置页 + 一句提示文案）

## 架构

```
public/app.js          设置页"应用管理"卡片网格模块
        │  GET  /api/agents/status
        │  POST /api/agents/:id/install   (进度走已有 SSE /api/events)
        ▼
server.js               新增两个路由，调用 lib/detect.js
        ▼
lib/detect.js  (新文件)  通用探测/安装引擎：不认识任何具体 agent，
        │                只消费各 adapter 的 detect 描述
        ├── 读 ~/.agent-board/tool-paths.json （用户路径覆盖，优先级最高）
        ▼
lib/adapters/*.js       每个文件新增 detect 导出（8 个文件都要改）
```

`lib/detect.js` 是唯一新增业务文件，其余是在现有文件上加导出/加路由/加 UI 模块。继续保持零 npm 依赖。

**探测与安装分离**（EchoBird 最值得抄的一点）：`probe` 只回答"装没装、装在哪"，`install` 只回答"怎么装"。安装方式变了不影响探测逻辑；用户自己手动装的、或装在非标准位置的，探测照样能认出来。

## 数据模型：adapter 的 `detect` 导出

```js
// lib/adapters/pi.js 新增
detect: {
  tier: 'cli',                  // 'cli' | 'gui' —— 描述它「是什么」，不描述能否自动装

  identityGuard: {              // 防止装错近名产品；实现时用于日志与 UI 提示
    is: 'Pi coding agent (earendil-works)，CLI 命令为 pi',
    isNot: ['npm 上的同名 pi 包', 'Pi 币 / Pi Network', 'π 相关数学库'],
  },

  requirements: { node: '>=18' },

  probe: {
    kind: 'path',
    // 直接照抄 EchoBird pi/paths.json 的 win32 数组
    win32: [
      '%APPDATA%\\npm\\pi.cmd',
      '%USERPROFILE%\\.local\\bin\\pi.exe',
      '%USERPROFILE%\\.bun\\bin\\pi.exe',
      '%USERPROFILE%\\.hermes\\node\\bin\\pi.exe',
      '%USERPROFILE%\\.hermes\\node\\bin\\pi.cmd',
      '%LOCALAPPDATA%\\pnpm\\pi.exe',
    ],
    darwin: [...], linux: [...],   // 一并搬入，本轮不验证
  },

  // 按优先级排列，前一个失败自动降级到下一个
  install: {
    methods: [
      { kind: 'script', win32: 'irm https://pi.dev/install.ps1 | iex',
                        posix: 'curl -fsSL https://pi.dev/install.sh | sh' },
      { kind: 'npm',    pkg: '@earendil-works/pi-coding-agent', flags: ['--ignore-scripts'] },
    ],
    mirrors: { npm: 'https://registry.npmmirror.com' },   // 仅失败后降级使用
  },

  verify: { cmd: 'pi --version' },
},
```

`tier: 'gui'` 的（WorkBuddy / ZCode / 豆包 / Marvis）：

```js
// lib/adapters/zcode.js
detect: {
  tier: 'gui',
  identityGuard: { is: 'Z.AI 的 ZCode 桌面版', isNot: ['OpenCode CLI', 'OpenCode Desktop'] },
  probe: {
    kind: 'registry',                                     // 路径 + Windows 卸载注册表双重探测
    win32: ['%LOCALAPPDATA%\\Programs\\ZCode\\ZCode.exe'],
    registryHints: { displayNamePrefixes: ['ZCode'] },
  },
  install: {
    methods: [{ kind: 'download', url: 'https://zcode.z.ai/cn#all-downloads' }],
  },
},
```

**注意 `tier` 与"能否自动安装"是两个正交概念**：tier 描述这个东西是 CLI 还是 GUI 应用（影响探测方式和启动方式），`install.methods` 描述能怎么装。一个 GUI 应用如果有 winget 包，`methods` 里就可以有 `kind: 'winget'` 从而做到全自动 —— 不因为它是 GUI 就一定只能"打开下载页"。

## 各 agent 的配置结果

| agent | tier | 探测 | 安装方式（优先级从高到低） | 依赖 |
|---|---|---|---|---|
| claude | cli | EchoBird `claudecode/paths.json`（npm/bun/pnpm/winget 多路径） | ① 原生安装器 `irm https://claude.ai/install.ps1 \| iex`（官方推荐，能自动更新）② `winget install Anthropic.ClaudeCode` ③ `npm i -g @anthropic-ai/claude-code` | — |
| codex | cli | EchoBird `codex/paths.json` | ① `irm https://chatgpt.com/codex/install.ps1 \| iex` ② `npm i -g @openai/codex` | Node ≥22 |
| pi | cli | EchoBird `pi/paths.json` | ① `irm https://pi.dev/install.ps1 \| iex` ② `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` | Node ≥18 |
| deepseek (dsh) | cli | EchoBird `dsh/paths.json` | `npm i -g @deepseek-ai/dsh` ✅已核实 | Node ^22.19 或 ≥24 |
| zcode | gui | 路径 + 注册表（`displayNamePrefixes: ['ZCode']`） | 下载页 `zcode.z.ai/cn#all-downloads`，打开安装器交给用户 | — |
| workbuddy | gui | 路径 + 注册表（发行商 Tencent） | 下载页 `codebuddy.cn/work/`；`winget Tencent.WorkBuddy` **未证实，实现时先验证，成立则升为首选** | — |
| doubao | gui | 沿用现有 `doubao.js` 的数据目录判断 | 下载页 URL **待确定**（不在 EchoBird 覆盖范围） | — |
| marvis | gui | 沿用现有 `marvis.js` 的数据目录判断 | 下载页 URL **待确定**（同上） | — |

原先设计里的 `tier: 'manual'` 档位这轮用不上（8 个 agent 都有正规安装渠道），从 schema 中移除；将来真遇到私有工具，等价效果是给它一个空的 `install.methods` 数组。

## 安装链路

```
点击安装
   ↓
Identity guard 提示（UI 显示"即将安装 X，它不是 Y/Z"）
   ↓
检测 OS / 架构
   ↓
检查 requirements（node --version 等）
   ├─ 缺失 → 提示"需先安装 Node.js ≥22" + 官网链接，中断
   └─ 满足 ↓
确认卡片（展示：装什么、用哪条命令、装到哪）→ 用户确认
   ↓
按 install.methods 顺序尝试
   ├─ 官方安装器/winget 失败 → 降级下一个 method
   └─ npm 失败且疑似网络问题 → 加 --registry 镜像重试一次
   ↓
verify.cmd 验证版本
   ↓
重新 probe（重新扫路径，不依赖当前进程的 PATH）
   ↓
完成
```

**关键实现约束（来自 EchoBird 的经验）**：

- **不预先 ping 一堆域名来决定走官方还是镜像**。默认走官方源，**失败后**再判断是哪个 host 出问题、针对性降级到对应镜像（npm → npmmirror）。预先探测网络既不准又慢。
- **官方安装脚本必须来自官方域名**，不因为网络问题就替换成第三方源的脚本。
- **安装完成后不能假设当前进程能看到新的 binary** —— npm/bun/pnpm/scoop 装完，当前 Node 进程的 `PATH` 环境变量是旧的。所以验证一律走"重新扫 `probe` 路径列表"，而不是直接 `spawn('pi')` 靠 PATH 找。这也是 EchoBird 让用户点 REFRESH 的原因。
- **GUI 应用：下载 → 明确告诉用户文件存到哪 → 打开安装器 → 由用户完成向导。绝不自动点击安装向导。**
- 全程通过 SSE 广播每一步状态（复用现有 `/api/events`，新增 `agent-install-progress` 事件类型，不新开连接），前端渲染成时间线。

## 用户自定义路径覆盖

新增 `~/.agent-board/tool-paths.json`，优先级高于 adapter 内置路径：

```json
{
  "pi": ["D:\\Tools\\pi\\pi.exe"],
  "codex": "D:\\Tools\\Codex\\codex.exe"
}
```

支持数组或单字符串两种写法。解决 portable 安装、自定义安装目录、企业环境特殊 PATH 等情况。

**容错要求**：文件不存在、JSON 解析失败、字段类型异常，都只能降级为"忽略这份覆盖"，绝不能让整个探测流程崩溃。

## API 设计

- `GET /api/agents/status` → 并发对 8 个 adapter 跑 probe，返回 `{ [agentId]: { installed, version, path, tier, source } }`（`source` 标明命中的是内置路径还是用户覆盖），设置页打开时调用
- `POST /api/agents/:id/install` → 触发 `lib/detect.js` 的 install 流程，进度通过已有 SSE 通道推送
- 瀑布流默认显隐：不新增后端路由，沿用前端现有 `colOrder`/localStorage 机制（`public/app.js` 的"列设置"那套），只把初始默认值从"全部显示"改成"探测到已安装的才默认显示"

## 前端 UI

设置页新增"应用管理"模块，卡片网格布局（已选定的 B 方案）：每张卡片 = 图标 + 名称 + 状态徽标（已安装 / 未检测到 / 检测中 / 检测出错）+ 操作按钮（修复 / 安装 / 打开下载页，随 tier 和状态变化）。安装中的卡片就地展开成步骤时间线。

首次启动（本地从未探测过）：自动展开到该模块位置 + 一句提示文案。不做独立全屏向导。

## 错误处理

- 单个 agent probe 失败（权限/超时）→ 该卡片显示"检测出错"，不影响其他卡片，不阻塞设置页加载
- `tool-paths.json` 异常 → 忽略覆盖、正常走内置路径，在日志里留痕
- 安装某一步失败 → 停在该步，显示具体原因 + 重试按钮，不静默吞错误
- 所有 `install.methods` 都失败 → 降级为"打开官方下载页"，并把最后一次失败原因展示出来
- 依赖缺失 → 不自动装系统级依赖（Node/Python/Git），只提示 + 给官方链接

## 测试 / 验证方式

项目没有自动化测试框架，延续现状用手动验证：

1. `GET /api/agents/status` 的结果与本机实际安装情况逐一核对（8 个 agent）
2. 已安装的 CLI 工具（如 Claude Code）：probe 命中正确路径、版本号读取正确
3. 卸载一个侵入性最小的 CLI 工具（建议 Pi），走完整"未安装 → 点安装 → 自动装好 → probe 转已安装"链路
4. 故意用错误包名触发失败，确认失败原因清晰展示且能重试
5. 断网后触发一次 npm 安装，确认镜像降级逻辑被触发（而不是直接报错退出）
6. 写一份 `~/.agent-board/tool-paths.json` 指向非标准位置，确认覆盖生效；再写一份坏 JSON，确认探测不崩溃
7. WorkBuddy / ZCode：确认真实安装路径命中 EchoBird 提供的候选位置与注册表探测
8. SSE 安装进度在设置页正确渲染成时间线

## 落地前必须先确认的事项

1. **逐条实跑验证安装命令**（本文档的命令来自二手汇总，不可直接照抄进代码）
2. **`winget Tencent.WorkBuddy` 是否真实存在** —— 成立则 WorkBuddy 升级为全自动安装，不成立就只保留下载页
3. **豆包 / Marvis 的官方下载页 URL** —— 不在 EchoBird 覆盖范围，需单独查证
4. **Windows 卸载注册表的探测实现细节** —— 读 `HKLM/HKCU` 下 `Uninstall` 子键并按 `DisplayName` 前缀 / `Publisher` 匹配，需确认在非管理员权限下也能读到

## 后续可做（不在本轮）

- GUI 应用的 winget 覆盖调研（EchoBird 路径列表里出现过 `WinGet\Links`，暗示部分工具可走 winget，值得系统性排查一遍）
- macOS / Linux 实机验证
- 更多 agent 接入（EchoBird 支持 28 个，本轮只覆盖 agent-board 现有的 8 个）
