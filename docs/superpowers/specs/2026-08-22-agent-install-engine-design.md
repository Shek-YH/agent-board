# Agent Board：安装引擎（tier:cli） —— 设计文档

日期：2026-08-22
承接：[2026-08-22-agent-detect-install-design.md](2026-08-22-agent-detect-install-design.md)（探测引擎已实现，`lib/adapters/*.js` 的 `detect.install`/`detect.network`/`detect.afterInstall` 数据已经就位但还没被任何代码消费）

## 背景

探测引擎（`lib/detect.js` 的 `probeAgent`/`probeAll`）已经上线：能准确判断 8 个 Agent 装没装、装在哪、什么版本，前端"应用管理"弹窗也已经能展示这些状态。但目前点"安装"没有任何反应——每个 adapter 的 `detect` 对象里其实早就带了 `install.methods`（怎么装）、`network`（网络/被墙信息）、`afterInstall`（装完要告诉用户什么），这些数据从 Task 6-13 就写好了，一直没人用。

本设计要把这些数据接起来，做出真正能点击执行的"安装"功能。

## 范围

**这轮做**：`tier:'cli'` 的 4 个 agent（claude / codex / pi / deepseek）的完整安装链路——依赖检查、执行、校验、结果展示。

**这轮不做**：
- `tier:'gui'` 的 4 个 agent（workbuddy / zcode / doubao / marvis）的安装——留给下一轮，理由是这轮先把范围收窄验证链路能跑通，GUI 类涉及 winget/下载页两种不同分支，单独一轮更干净
- 瀑布流列联动、探测缓存——不在这轮目标里，之前就明确延后了
- 多个安装任务并发执行——这轮明确选择"一次只能装一个"

## 安装链路（`installAgent`）

新增 `lib/detect.js` 导出函数 `installAgent(adapter, onProgress, opts)`，`opts.runCmd` 可注入（测试用，同 `probeRegistryApp` 的 `runReg` 注入模式，默认是真实的 `spawnSync`）：

```
① network.blockedRegions 是否命中当前情况？
   —— 不做真实地区探测，固定按"中国大陆网络环境"判断（agent-board 这轮就是给中文用户用的，
      没必要为了一个假设中的海外用户去建一套地区检测机制）
   ├─ 命中（目前只有 claude）→ onProgress('blocked', {message: blockedRegions['zh-CN']}) → 失败退出，不尝试安装
   └─ 未命中 ↓
② requirements.node 有要求吗？
   —— 用 process.version（agent-board 自己就是 Node 跑的，不用另开子进程查版本）
   ├─ 当前版本不满足 → onProgress('deps-missing', {need: requirements.node, have: process.version}) → 失败退出
   └─ 满足或无要求 ↓
③ 从 install.methods 里选唯一一个确定性方法（不做自动降级链，见下方"方法选择算法"）
   ├─ 没有平台适用的方法 → onProgress('no-method') → 失败退出
   └─ 选中一个 method ↓
④ onProgress('installing', {method}) → 执行该方法的命令（spawnSync，走 cmd.exe /c，同 tryVersion 的模式）
   ├─ 执行失败（status !== 0 或 error）→ onProgress('failed', {stderr/error}) → 失败退出
   └─ 执行成功 ↓
⑤ onProgress('verifying') → 跑 verify.cmd（复用探测引擎已有的 tryVersion）
   ├─ 拿不到版本号 → onProgress('failed', {reason: 'verify 失败，可能装了但 PATH 没刷新'}) → 失败退出
   └─ 拿到版本号 ↓
⑥ onProgress('done', {version, tellUser: afterInstall.tellUser}) → 成功返回
```

## 方法选择算法（新决定，本轮新增设计）

`install.methods` 数组里每个 method 有 `kind`（`'script'` | `'npm'` | `'winget'` | `'download'`）。按平台可用性 + 数组原有优先顺序，**只选第一个可用的，不做失败后自动换下一个**：

```js
function pickMethod(methods, platform = process.platform) {
  for (const m of methods) {
    if (m.kind === 'script') {
      if (platform === 'win32' && m.win32) return m;
      if (platform !== 'win32' && m.posix) return m;
      continue;
    }
    if (m.kind === 'npm') return m;               // 跨平台，总是可用
    if (m.kind === 'winget' && platform === 'win32') return m;
    // kind === 'download' 这轮不处理（tier:cli 的 4 个 agent 都不需要走到这里）
  }
  return null;
}
```

这是这轮唯一的新算法，其余安装链路逻辑就是把已有的 `detect` 数据按顺序跑一遍。

**这条为什么是新决定**：上一版设计文档里写的是"按优先级排列，前一个失败自动降级到下一个"（比如 claude 失败了从原生安装器自动跳到 npm）。这轮改成只选一个、不自动降级，因为四选一的自动降级链会让"这次到底跑了哪条命令"变得不确定，出问题不好复现；范围收窄到 4 个工具的这一轮，简单可控更重要，用户自己能看到失败原因后重试或换个方式。

## API 改动

**`GET /api/agents/status`** 现有响应基础上，每个 agent 的对象里追加：
```json
{ "install": { "methods": [...], "warning": "..." } }
```
（直接从 `adapter.detect.install` 透传，前端要用来渲染确认弹窗）

**`POST /api/agents/:id/install`**（新增）：
- 请求体：无（agent id 从 URL 拿）
- 服务端维护一个全局标记 `installInProgress`（不是 per-agent，是整个 server 一次只能装一个）；已有安装在跑时收到新请求直接 `409 {error: '已有安装任务在进行'}`
- 成功接受后异步执行 `installAgent`，进度通过已有的 `/api/events` SSE 广播新事件 `agent-install-progress`，payload：`{ agentId, step, ...detail }`（`step` 对应上面链路图里的 `blocked`/`deps-missing`/`installing`/`verifying`/`done`/`failed`/`no-method`）
- HTTP 响应本身立即返回 `{ ok: true, background: true }`（参考现有 `/api/rescan` 的异步模式），不等安装跑完才响应

## 前端改动

- `openAgentManager()` 弹窗：`tier === 'cli' && !installed` 的卡片显示"安装"按钮
- 点击 → 用 `install.methods`/`install.warning` 拼一段文字 → 原生 `confirm()` → 确认后 `POST /api/agents/:id/install`
- 监听 SSE 的 `agent-install-progress` 事件（复用页面已有的 `EventSource` 连接，加一个新 case），把对应卡片的状态行换成"检测依赖中/安装中/校验中/完成/失败：原因"
- 装完（`step === 'done'`）：`alert`/toast 展示 `tellUser` 清单，然后重新 `fetch('/api/agents/status')` 刷新整个弹窗

## 错误处理

- 每一步失败都通过 `onProgress('failed', ...)` 带上具体原因，不静默吞掉
- `POST` 端点本身的异常（`installAgent` 抛出未预期的异常）也要能被捕获，通过 SSE 广播一个 `failed` 事件，不能让服务器进程挂掉

## 测试

`lib/detect.test.js` 新增覆盖（`installAgent` 注入 fake `runCmd`）：
- `network.blockedRegions` 命中 → 直接 `blocked`，不调用 `runCmd`
- `requirements.node` 不满足（用假的 `process.version` 覆盖测——需要让 `installAgent` 接受可注入的当前版本号，不要直接读全局 `process.version`，方便测试）→ `deps-missing`
- `pickMethod`：给不同平台/不同 methods 组合，断言选中结果符合预期（win32 优先 script，没有则 npm；纯 posix 环境下 script(win32-only) 被跳过等）
- 执行成功路径：fake `runCmd` 返回成功 → `verify` 阶段也 fake 一个成功版本号 → `done`
- 执行失败路径：fake `runCmd` 返回非 0 → `failed`，且不会继续跑 verify
- verify 失败路径：安装命令成功但 verify 拿不到版本号 → `failed`

**人工验证**：在这台机器上真实卸载一次 `pi`（`npm uninstall -g @earendil-works/pi-coding-agent`），通过应用管理弹窗点安装，确认真的能重新装回来、探测状态刷新正确。选 pi 是因为它是开源小工具、Windows 上走 npm 安装（不涉及 `irm | iex` 这种更激进的操作），风险最低。

## 落地前需要确认的事项

- `installInProgress` 这个全局标记如果 server 重启时正好卡在"进行中"状态会不会导致永久卡死——理论上重启后内存态标记清零，不会有这个问题，但实现时留意一下
