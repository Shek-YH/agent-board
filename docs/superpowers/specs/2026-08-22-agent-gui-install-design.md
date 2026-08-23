# Agent Board：GUI 类工具安装引擎 —— 设计文档

日期：2026-08-22
承接：[2026-08-22-agent-install-engine-design.md](2026-08-22-agent-install-engine-design.md)（`tier:'cli'` 的安装引擎已实现并合并到 main：claude/codex/pi/deepseek 支持一键安装，点击后确认 → 执行 → SSE 进度 → 校验）

## 背景

上一轮明确把 `tier:'gui'` 的 4 个工具（workbuddy / zcode / doubao / marvis）留到"下一轮"，理由是 GUI 类涉及 winget 静默安装 / 下载页手动安装两种不同分支，单独一轮更干净。这一轮把这块补上。

**豆包（doubao）排除**：用户明确表示豆包不好用，以后 agent-board 的所有开发都不再把豆包纳入范围。这一轮不碰 `lib/adapters/doubao.js`，现有的探测代码保留但不做任何安装引擎相关改动。

## 范围

这一轮做：`workbuddy` / `zcode` / `marvis` 三个 `tier:'gui'` 工具的安装。

这一轮不做：
- 豆包的任何改动
- `tier:'cli'` 已有功能的改动
- 真实卸载/重装任何 GUI 工具做端到端验证（原因见"测试"一节）

## 现状核查（这一轮开工前做的实测，不是假设）

用户最初的说法（workbuddy 只有下载地址、没有命令行安装方式）与仓库里 `lib/adapters/workbuddy.js` 现有数据（`winget install --id Tencent.WorkBuddy`）矛盾。用 PowerShell 实测 `winget search --id Tencent.WorkBuddy --exact` 和 `winget search --id ZhipuAI.ZCode --exact`，两个包都真实存在（版本分别是 5.3.14、3.8.1），确认是用户记忆有误，不是仓库里的臆想数据。用户确认后决定保留这两条 winget 记录。

（顺带发现一个环境细节：这台机器上 Bash 工具启动的 `cmd.exe` 会话 PATH 里缺 `%LOCALAPPDATA%\Microsoft\WindowsApps`，找不到 `winget`；但通过 PowerShell 启动的 `cmd.exe` 能正常找到。之后凡是需要验证 `winget`/依赖用户级 PATH 的命令，一律用 PowerShell 工具而不是 Bash 工具，避免误判"命令不存在"。这不影响 agent-board 本身的运行时——`server.js` 是从开机自启的正常用户会话里启动的，继承的是完整用户 PATH，不是 Bash 工具的沙盒环境。）

## Adapter 数据改动

**`lib/adapters/workbuddy.js`**：`install.methods` 不变（保留 winget 条目），把 `download` 方法的 `url` 从 `https://www.codebuddy.cn/work/`（旧域名/错误数据）改成用户提供的 `https://www.workbuddy.cn/work/#download-section`。

**`lib/adapters/zcode.js`**：不改。现有的 `winget`（`ZhipuAI.ZCode`）+ `download`（`https://zcode.z.ai/cn#all-downloads`，和用户给的地址一致）已经是对的。

**`lib/adapters/marvis.js`**：`install.methods` 从 `[]` 改成：
```js
methods: [
  { kind: 'download', url: 'https://marvis.qq.com/' },
],
```
`warning` 从"官方下载地址待确认，这轮只做探测"改成："仅支持手动下载安装，暂无命令行安装方式"。

**`lib/adapters/doubao.js`**：不动。

## 安装行为（核心设计）

上一轮已经在 `GET /api/agents/status` 里给每个 agent 算好了 `install.picked`（用 `pickMethod()` 按平台优先级选出的、真正会执行的方法；没有可执行方法时是 `null`）和 `install.pickedCommand`（对应的命令字符串）。这一轮直接复用这两个字段做分支，不新增探测逻辑：

```
点击"安装"
  ├─ install.picked 有值（真能静默装：这轮里 workbuddy/zcode 在 Windows 上会走到这，pickMethod 选中 winget）
  │   → 和 tier:'cli' 完全一样的流程：confirm() 展示 pickedCommand → 确认 → POST /api/agents/:id/install → SSE 进度（安装中/校验中/完成/失败）
  │
  └─ install.picked 为空、但 methods 里有 kind:'download' 的条目（这轮里 marvis 会走到这，以及 workbuddy/zcode 在非 win32 环境或 winget 不可用时的理论情况）
      → 新分支："下载安装"：不弹 confirm()，直接 window.open(下载页 URL, '_blank')，
        toast 提示"已在新标签页打开下载页，按提示完成安装后关闭再重新打开本弹窗可刷新状态"
      → 不发 POST，不走 SSE，不占用全局安装锁（纯前端动作，跟"点了外部链接"性质一样，不需要二次确认）
```

（注：弹窗顶栏原有的"重新扫描"按钮触发的是 `/api/rescan`——那是会话数据扫描，和这里的安装探测状态 `/api/agents/status` 完全无关，点它刷新不了卡片的已装/未装状态。真正能刷新的动作是关闭弹窗再重新打开，因为 `openAgentManager()` 每次调用都会重新 `fetch('/api/agents/status')`。写自查时发现设计初稿里误写成"点重新扫描"，这里已经改正。）

**为什么下载分支不用 confirm()**：静默安装分支会真的执行一条系统命令（有副作用、值得让用户确认一遍"即将执行什么"），而打开下载页只是导航到一个 URL，性质上和点击页面里任何一个外部链接一样，不需要额外的确认摩擦。

**为什么下载分支没有进度追踪**：用户自己在弹出的系统安装向导里操作，agent-board 没有任何信号能知道装到哪一步、装完没有——不去伪造一个假进度条，如实告诉用户"装完了自己关闭弹窗重开一下"（不需要新控件，`openAgentManager()` 本来就是全量重新拉取）。

## 后端改动

**`server.js`**：`POST /api/agents/:id/install` 路由的 tier 校验，从

```js
if (adapter.detect.tier !== 'cli') { ... 400 ... }
```

放宽成

```js
if (adapter.detect.tier !== 'cli' && adapter.detect.tier !== 'gui') { ... 400 ... }
```

`GET /api/agents/status` 里 `install.picked`/`install.pickedCommand` 的计算逻辑本来就是通用的（不区分 tier），gui 类工具自动就有，不用改。

**安全边界**：即使前端因为某个 bug 意外对一个只有 `download` 方法的 gui agent 发起了真实 POST，后端的 `installAgent()` 在方法选择这一步（`pickMethod` 返回 `null`）会走 `onProgress('no-method')` 分支直接失败退出，不会真的执行任何命令——这是上一轮就有的安全网，这一轮不用额外加代码。

## 前端改动

**`public/app.js`**：

1. `canInstall` 判断从 `a.tier === 'cli'` 放宽成 `(a.tier === 'cli' || a.tier === 'gui')`（其余条件不变：`!a.installed && a.install && (a.install.methods||[]).length`）。
2. `.ab-install` 点击处理逻辑加一层分支：
   - `a.install.picked` truthy → 走现有代码路径（confirm + POST + SSE），不变。
   - `a.install.picked` falsy → 找 `(a.install.methods||[]).find(m => m.kind === 'download')`：
     - 有 → `window.open(m.url, '_blank')` + `toast('已在新标签页打开下载页，按提示完成安装后关闭再重新打开本弹窗可刷新状态')`，直接返回，不碰 `installInProgress`/按钮 disabled 状态（因为没有异步任务在跑）。
     - 没有（理论上不会发生，因为 `canInstall` 已经要求 `methods.length > 0`，但防御性处理）→ 保留原来的 `'(未知)'` 兜底文案 + 走静默流程原样报错（`installAgent` 会返回 `no-method`）。
3. 按钮文案：静默安装分支保持"安装"；下载分支按钮文案改成"下载安装"，让用户点之前就知道这是两种不同性质的操作（不是所有 agent 点了都会自动装好）。

doubao 不受影响（`methods` 一直是空数组，`canInstall` 恒为 `false`，不会出现按钮）。

## 错误处理

和上一轮一致：静默安装分支的每一步失败都通过 `onProgress('failed', ...)` 带上具体原因；下载分支本身没有"失败"这个状态（打开新标签页这个动作本身不会失败，除非浏览器拦截弹窗——如果发生，用户会看到浏览器自己的弹窗拦截提示，不需要 agent-board 额外处理）。

## 测试

`lib/detect.test.js` 新增覆盖：
- `pickMethod` 对 workbuddy/zcode 的真实 adapter 数据在 win32 平台下选中 winget 方法（和 cli 引擎那轮给 codex 做的回归测试是同一种模式）
- `pickMethod` 对 marvis 的真实 adapter 数据（只有一个 `download` 方法）在任意平台下返回 `null`
- 现有的"8 个 adapter 的 detect 配置符合基本 schema"测试自然覆盖 marvis 新增的 `methods` 数据格式，不用专门再写一个

**人工验证**（范围收窄，原因见下）：
- 不真实卸载/重装任何 GUI 工具。原因：`workbuddy` 疑似是这台机器上现有工具链的一部分（进程列表里能看到 `.workbuddy` 目录下的常驻进程），真实卸载它的风险远高于上一轮验证用的 `pi`（一个独立的小工具）；`zcode`/`marvis` 同样是没把握的重量级 GUI 应用，没必要为了验证一个"打开确认框"级别的功能去动它们。
- 只验证"下载安装"分支：在浏览器里点 marvis 卡片的"下载安装"按钮，确认真的新开标签页跳到 `https://marvis.qq.com/`，且 agent-board 自身状态和进程都没有任何变化。
- 静默安装分支（workbuddy/zcode 的 winget 路径）不做真实执行验证，靠代码审查 + 单测里对 `pickMethod`/`methodToCommand` 的真实数据断言来保证正确性——这和上一轮对 claude（网络被墙）的处理方式是同一个思路：能安全验证的边界就到"确认要跑的命令是对的"为止，不需要真的跑一遍已知有风险的操作。
