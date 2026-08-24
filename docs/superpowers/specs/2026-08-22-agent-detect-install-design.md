# Agent Board：应用探测与安装管理 —— 设计文档

日期：2026-08-22（v3，用 EchoBird 官方一手安装定义数据核实并重写）
对应商业化路线图"阶段 1：安装体验"中"自动检测已装 Agent + 设置页里按需安装"部分（本设计只覆盖阶段 1，不涉及账号/鉴权/打包分发；路线图本身存在会话历史中，不在本仓库内）

## 背景

agent-board 目前对 7 个 AI Agent（claude / codex / workbuddy / deepseek / marvis / zcode / pi）的支持是硬编码的：`server.js` 里的 `AGENT_DEFS` 表写死了进程名、URL scheme、部分启动路径（其中 `deepseek` / `marvis` / `zcode` / `pi` 的启动路径直接写死了这台机器的绝对路径），换一台机器就会失效；也没有任何"检测是否已安装""按需安装"的能力。

本设计要解决两件事：
1. **探测**：判断用户机器上到底装没装某个 Agent、装在哪，替换掉硬编码绝对路径。
2. **安装**：在设置页提供"一键安装"，按工具类型和可自动化程度分层处理。

## 参考资料与可信度

三份参考，可信度从高到低：

1. **EchoBird 仓库官方一手安装定义** `github.com/edison7009/EchoBird/docs/api/tools/install/<id>.json`（最高可信度，直接读的原始文件）
   - 每个工具一份 JSON，字段包括 `install`(多种安装方式)、`install_flow.agent_steps`(给内置 AI 的执行步骤)、`install_flow.tell_user`(必须告知用户的信息清单)、`network_requirements`(测试用 URL + 被墙地区 + 镜像)、`identity_guard`(防装错说明)
   - 已取到并核实：`claudecode` / `codex` / `pi` / `dsh` / `workbuddy` / `zcode` 六个，与 agent-board 现有 8 个 adapter 中的 6 个对应
   - **本设计的安装命令、网络策略、identity guard 均以这份数据为准**，之前版本里"未证实"的 WorkBuddy winget id 在这里得到确认：`Tencent.WorkBuddy`
   - 这些文件的字段设计（`note`/`WARNING`/`agent_steps` 都是自然语言）表明 EchoBird 真实的安装执行者是**内置 AI 读这份"菜谱"现场决定命令并口头播报**，不是纯确定性脚本解释器直接执行这个 JSON。本设计仍选择确定性脚本引擎（理由见下方"架构选择"），但会把这份"菜谱"里的命令和自然语言警告拆开，分别放进机器可读的字段和人类可读的提示文案

2. **本机 EchoBird 安装目录** `%LOCALAPPDATA%\EchoBird\_up_\tools\`（一手，可直接读）
   - 每个工具一份 `paths.json`（各平台下二进制的候选位置，用于探测）+ `config.json`（模型配置文件位置与读写映射，本设计不需要）
   - 本设计的**探测路径直接复用这份数据**

3. **`F:\AIagent自动安装包\EchoBird_AI_Agent_App_Manager_安装与配置规范汇总.md`**（二手，AI 整理的汇总，已被第 1 份一手数据基本取代，仅在一手数据未覆盖的工具上——比如 Marvis——作为背景参考）

**实现约定：所有安装命令在写进代码前必须各自实跑一次验证，即便来自一手数据也要跑一遍，因为工具版本/发布渠道会变。**

### 架构选择：为什么不直接抄 EchoBird 的"AI 读菜谱执行"模式

EchoBird 的真实做法（推测）是内置一个通用 LLM，把 `install/<id>.json` 当 few-shot 式的领域知识喂给它，由它决定要跑哪条命令、怎么处理报错、怎么措辞跟用户播报。这个模式的好处是灵活（遇到没写全的边缘情况 AI 能现场应变），坏处是：
- 每次安装都要调用一次模型 API，产品要么自建模型网关要么帮用户出这笔 token 费
- 执行的具体命令不是 100% 确定的，两次安装同一个工具理论上可能跑出不完全一样的命令，出问题不好复现/调试
- 一个"能在用户机器上现场决定并执行 shell 命令"的模块，是这个产品里唯一一处会被安全审查重点关照的地方，作为收费产品应尽量避免

本设计延续 v2 的决定：用**确定性脚本引擎**消费一份结构上向 EchoBird 看齐、但语义上分离干净的静态配置（命令是命令、警告是警告，不混在一起让人/AI 去读）。灵活性换成了"这轮先覆盖已知场景，覆盖不到的场景就诚实报错 + 引导用户去看官方文档"，而不是让 AI 现场兜底。

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
// lib/adapters/pi.js 新增（命令直接取自 EchoBird install/pi.json，字段拆分见下）
detect: {
  tier: 'cli',                  // 'cli' | 'gui' —— 描述它「是什么」，不描述能否自动装

  identityGuard: {               // 结构照抄 EchoBird 的 identity_guard
    description: 'Pi 指 Earendil Works 开发的开源 CLI coding agent（pi.dev）',
    notToConfuseWith: ['Pi Network（加密货币 App）', 'Inflection AI 的 Pi 助手', 'Raspberry Pi 相关工具'],
  },

  requirements: { node: '>=22.19.0' },   // 2026-08-22 实现阶段核实：npm 上最新版 engines 要求，这里原来写的 >=18 是错的

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

  // 按优先级排列，前一个失败自动降级到下一个；命令取自 EchoBird install/pi.json 的 install 字段
  install: {
    methods: [
      { kind: 'script', posix: 'curl -fsSL https://pi.dev/install.sh | sh' },        // macOS/Linux 首选
      { kind: 'npm', pkg: '@earendil-works/pi-coding-agent', flags: ['--ignore-scripts'] }, // Windows 走这条
    ],
    warning: "npm 包名必须是 @earendil-works/pi-coding-agent，不能单独装 'pi'（那是个无关的 JS 包，用来算圆周率数字的）",
  },

  network: {                      // 结构照抄 EchoBird 的 network_requirements
    testUrls: ['https://pi.dev', 'https://registry.npmjs.org/@earendil-works/pi-coding-agent'],
    mirrors: { npm: 'https://registry.npmmirror.com' },   // 仅失败后降级使用
    blockedRegions: {},           // Pi 没有被墙问题，留空
  },

  verify: { cmd: 'pi --version' },

  afterInstall: {                 // 结构照抄 EchoBird 的 tell_user，装完必须展示给用户
    tellUser: [
      '用的是 curl 安装器还是 npm（Windows 走 npm，需要先有 Node.js ≥18）',
      '装完可能要点"刷新"或重启 agent-board 才能识别到新装的 pi（当前进程看不到装之前不存在的 PATH）',
    ],
  },
},
```

`tier: 'gui'` 的（WorkBuddy / ZCode / Marvis），命令取自 `install/zcode.json` / `install/workbuddy.json`：

```js
// lib/adapters/zcode.js
detect: {
  tier: 'gui',
  identityGuard: { description: 'ZCode 是 Z.AI(智谱) 自研的桌面版 coding agent，可切换多种 CLI backend(含 OpenCode)',
                    notToConfuseWith: ['OpenCode CLI', 'OpenCode Desktop'] },
  probe: {
    kind: 'registry',                                     // 路径 + Windows 卸载注册表双重探测
    win32: ['%LOCALAPPDATA%\\ZCode\\ZCode.exe'],           // 2026-08-22 实现阶段核实：没有 \Programs\ 这一段
    registryHints: { displayNamePrefixes: ['ZCode'] },
  },
  install: {
    methods: [                                              // 2026-08-22 实现阶段核实：其实有 winget(ZhipuAI.ZCode)
      { kind: 'winget', id: 'ZhipuAI.ZCode', flags: ['--accept-package-agreements', '--accept-source-agreements'] },
      { kind: 'download', url: 'https://zcode.z.ai/cn#all-downloads' },
    ],
  },
  afterInstall: {
    tellUser: ['下载文件的完整路径', '安装向导已打开', '需要用户自己点完向导，程序不会替你点'],
  },
},

// lib/adapters/workbuddy.js —— 有 winget，可以全自动
detect: {
  tier: 'gui',
  identityGuard: { description: 'WorkBuddy 是腾讯 CodeBuddy 的"办公版"桌面 Agent',
                    notToConfuseWith: ['CodeBuddy 编程 IDE（配置目录是 ~/.codebuddy，完全分开）'] },
  probe: {
    kind: 'registry',
    win32: ['%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe'],
    registryHints: { displayNamePrefixes: ['WorkBuddy'], publisher: 'Tencent' },
  },
  install: {
    methods: [
      { kind: 'winget', id: 'Tencent.WorkBuddy', flags: ['--accept-package-agreements', '--accept-source-agreements'] },
      { kind: 'download', url: 'https://www.codebuddy.cn/work/' },   // winget 不可用时降级
    ],
  },
},
```

**注意 `tier` 与"能否自动安装"是两个正交概念**：tier 描述这个东西是 CLI 还是 GUI 应用（影响探测方式和启动方式），`install.methods` 描述能怎么装。一个 GUI 应用如果有 winget 包，`methods` 里就可以有 `kind: 'winget'` 从而做到全自动 —— 不因为它是 GUI 就一定只能"打开下载页"。

## 各 agent 的配置结果

数据来源标注：🟢 = EchoBird 一手 `install/<id>.json` 已核实；🟡 = EchoBird 探测数据 + 需另查安装信息

| agent | tier | 探测 | 安装方式（优先级从高到低，🟢来源） | 依赖 / 特别注意 |
|---|---|---|---|---|
| claude | cli 🟢 | `claudecode/paths.json`（npm/bun/pnpm/winget 多路径） | ① macOS/Linux: `curl -fsSL https://claude.ai/install.sh \| bash` ② Windows: `irm https://claude.ai/install.ps1 \| iex` ③ `winget install Anthropic.ClaudeCode` ④ `npm i -g @anthropic-ai/claude-code`（官方仍列为有效方式，但不是首选） | **中国大陆无法直连 claude.ai，且没有镜像替代**（EchoBird 原话："success rate is nearly zero without a VPN/proxy"）。这个 agent 的安装失败时，UI 不应该建议"重试"或"换镜像"，而应直接提示"需要代理/VPN，无镜像可用" |
| codex | cli 🟢 | `codex/paths.json` | ① `npm i -g @openai/codex`（官方首选） ② macOS/Linux: `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` ③ Windows: `irm https://chatgpt.com/codex/install.ps1 \| iex` | Node ≥22；**包名必须精确是 `@openai/codex`**，不能单独装 `codex`（那是别的包）；Windows 直接用 PowerShell，不要 WSL；npm 失败可降级 `--registry=https://registry.npmmirror.com` |
| pi | cli 🟢 | `pi/paths.json` | ① macOS/Linux: `curl -fsSL https://pi.dev/install.sh \| sh` ② Windows: `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` | Node ≥22.19.0（仅 Windows/npm 路径需要，2026-08-22 实现阶段核实过，表格这里之前漏改成了旧数字）；包名必须精确，不能单独装 `pi`；npm 失败可降级 `--registry=https://registry.npmmirror.com` |
| deepseek (dsh) | cli 🟢 | `dsh/paths.json` | ① `npm i -g @deepseek-ai/dsh` ② 退化用法：`npx @deepseek-ai/dsh web`（一次性，不装到 PATH） | Node ≥22.19 或 ≥24；装完用 `dsh web` 起本地服务在 127.0.0.1:3080，默认会自动打开浏览器（可用 --no-open 关掉） |
| workbuddy | gui 🟢 | 路径 + 注册表（`displayNamePrefixes:['WorkBuddy']`, publisher: Tencent） | ① `winget install --id Tencent.WorkBuddy --accept-package-agreements --accept-source-agreements`（**winget id 已核实**）② 降级：打开 `codebuddy.cn/work/` 下载页交给用户 | Linux 不支持；winget 失败（比如系统没装 winget 或源不可用）才降级到下载页 |
| zcode | gui 🟢 | 路径 + 注册表（`displayNamePrefixes:['ZCode']`） | ① winget `ZhipuAI.ZCode`（2026-08-22 实现阶段核实存在，EchoBird 当时可能没查到）② 降级：下载页 `zcode.z.ai/cn#all-downloads` | — |
| marvis | gui 🟡 | 沿用现有 `marvis.js` 的数据目录判断 | 下载页 URL **待确定**（同上） | — |

原先设计里的 `tier: 'manual'` 档位这轮用不上（8 个 agent 都有正规安装渠道），从 schema 中移除；将来真遇到私有工具，等价效果是给它一个空的 `install.methods` 数组。

## 安装链路

```
点击安装
   ↓
Identity guard 提示（UI 显示"即将安装 X，它不是 Y/Z"）
   ↓
检测 OS / 架构
   ↓
network.blockedRegions 命中当前地区？
   ├─ 是（如 claude 在中国大陆）→ 直接提示"需要代理/VPN，无镜像可用"，不尝试安装，中断
   └─ 否 ↓
检查 requirements（node --version 等）
   ├─ 缺失 → 提示"需先安装 Node.js ≥22" + 官网链接（Windows 可提示 `winget install OpenJS.NodeJS` 作为可复制命令，但不自动跑），中断
   └─ 满足 ↓
确认卡片（展示：装什么、用哪条命令、装到哪、install.warning 里的措辞如有）→ 用户确认
   ↓
按 install.methods 顺序尝试
   ├─ 某个 method 失败 → 降级下一个 method
   └─ npm 方式失败且疑似网络问题 → 加 network.mirrors.npm 镜像重试一次
   ↓
verify.cmd 验证版本
   ↓
重新 probe（重新扫路径，不依赖当前进程的 PATH）
   ↓
展示 afterInstall.tellUser 清单（比如"可能需要点刷新才能识别新装的工具"）
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

1. **逐条实跑验证安装命令**（即便来自 EchoBird 一手数据也要跑一遍，工具发布渠道会变）
2. **Marvis 的官方下载页 URL** —— 不在 EchoBird 支持范围，需单独查证
3. **Windows 卸载注册表的探测实现细节** —— 读 `HKLM/HKCU` 下 `Uninstall` 子键并按 `DisplayName` 前缀 / `Publisher` 匹配，需确认在非管理员权限下也能读到
4. **`network.blockedRegions` 判断依据** —— EchoBird 用的是"地区代码"（如 `zh-CN`），agent-board 要不要做地区判断、还是干脆固定按"中国大陆网络环境"处理 claude 这一条（不用猜测用户地区，反正 agent-board 这轮就是给你自己/中文用户用的），实现时定一下，避免过度设计一套地区检测机制

## 后续可做（不在本轮）

- GUI 应用的 winget 覆盖调研（EchoBird 路径列表里出现过 `WinGet\Links`，暗示部分工具可走 winget，值得系统性排查一遍）
- macOS / Linux 实机验证
- 更多 agent 接入（EchoBird 支持 28 个，本轮只覆盖 agent-board 现有的 8 个）
