# Agent Board：探测缓存 + 瀑布流列联动 —— 设计文档

日期：2026-08-23
承接：[2026-08-22-agent-detect-install-design.md](2026-08-22-agent-detect-install-design.md)（探测/安装引擎已实现，cli+gui 全部合并）、[2026-08-23-agent-gui-install-engine.md](2026-08-23-agent-gui-install-engine.md)（同上）

## 背景

上一轮完成后剩两个一直延后的功能，这轮一起做：

1. **探测结果缓存**：`GET /api/agents/status` 现在每次打开"应用管理"弹窗都会跑一次完整探测（registry 查询 + 逐个 agent `spawnSync` 查版本号），没有缓存。
2. **瀑布流列联动**：`GET /api/board` 现在固定返回"全部 8 个已知 agent ∪ store 里有历史数据的 agent"作为可用列（`agentIds`），前端首页默认视图不管装没装都全部显示，探测引擎的结果完全没有接入首页布局。

这两件事放一起做的原因：列联动需要知道每个 agent 装没装，而这个数据只能来自探测；如果每次 `/api/board`（首页高频调用，每次筛选/翻页/SSE 触发刷新都会打一次）都触发一次完整探测，开销不可接受——所以联动的前提就是先有缓存。

## 范围

**这轮做**：
- `server.js` 加一个内存态探测结果缓存，`GET /api/agents/status` 和新的 `/api/board` 联动逻辑共用同一份
- `/api/board` 新增 `defaultAgentIds` 字段，前端用它计算默认列
- 应用管理弹窗加"重新探测"按钮，手动跳过缓存
- 顺带修一个现有小 bug：列设置弹窗的"恢复默认"按钮目前恢复成全部 8 列，这次对齐成同一个过滤后的默认列表
- **真实端到端验证**：卸载 pi（用户确认基本没用它建过项目，store 里没有历史数据，是验证"未安装+无历史→默认隐藏"这条规则的干净样本），验证列自动隐藏，再通过 UI 真实重装一次，验证列自动恢复 + 缓存正确失效

**这轮不做**：
- 缓存过期的 UI 提示（静默重新探测，用户无感）
- 不为过滤逻辑新建独立可测试模块（详见下方"实现"一节的理由）

## 探测缓存

`server.js` 里，紧挨着现有的 `installInProgress` 锁（第 144-148 行附近）加一个模块级缓存：

```js
// 探测结果缓存：5 分钟 TTL。避免 /api/board（首页高频调用）每次都触发一次完整探测
// （registry 查询 + 逐个 agent spawnSync 查版本号）。安装成功时主动失效，不等 TTL。
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
let probeCache = { data: null, ts: 0 };
async function getProbe(force = false) {
  if (!force && probeCache.data && Date.now() - probeCache.ts < PROBE_CACHE_TTL_MS) {
    return probeCache.data;
  }
  const data = await detect.probeAll(ADAPTERS);
  probeCache = { data, ts: Date.now() };
  return data;
}
```

- `GET /api/agents/status` 改用 `getProbe(url.searchParams.get('force') === '1')` 代替直接调 `detect.probeAll(ADAPTERS)`
- `GET /api/board` 也调 `getProbe()`（不强制），用来算 `defaultAgentIds`（见下）
- `POST /api/agents/:id/install` 的 `installAgent` 在 `onProgress` 回调收到 `step === 'done'` 时，顺手把 `probeCache = { data: null, ts: 0 }`，让下一次任意一个端点的调用重新探测（不用等 5 分钟 TTL，也不用专门为这个失效写额外的抓取逻辑——下次谁调用 `getProbe()` 谁自然触发重探）

## 瀑布流列联动

`GET /api/board` 现在的动态列逻辑（第 497-500 行）：

```js
const agentIds = new Set();
for (const id of Object.keys(AGENT_DEFS)) agentIds.add(id);
for (const a of store.stmts.agents.all()) if (a.agent) agentIds.add(a.agent);
```

这次改成同时追踪"哪些 id 是因为有历史数据才进来的"：

```js
const agentIds = new Set();
const agentsWithData = new Set();
for (const id of Object.keys(AGENT_DEFS)) agentIds.add(id);
for (const a of store.stmts.agents.all()) if (a.agent) { agentIds.add(a.agent); agentsWithData.add(a.agent); }
```

然后在响应里加一个新字段，基于探测缓存过滤：

```js
const probed = await getProbe();
const defaultAgentIds = [...agentIds].filter((id) => (probed[id] && probed[id].installed) || agentsWithData.has(id));
```

响应体加上 `defaultAgentIds`（`agentIds` 字段本身不变，前端两个都收到）：
```js
res.end(JSON.stringify({
  groups, agentIds: [...agentIds], defaultAgentIds,
  liveRefs: store.getActive().map((a) => a.sessionRef),
}));
```

**只影响默认视图**：这条规则只用来算"用户从没手动配过列时，默认显示哪些列"，不影响用户已经手动保存过的列设置——延续 `public/app.js` 里 `effectiveCols()` 已有的"一旦 `colOrder` 非 null 就完全尊重用户选择"的规则，这次不改这条规则本身，只是把"计算默认值用的候选列表"从 `agentIds`（全集）换成 `defaultAgentIds`（过滤后）。

### 前端改动

`public/app.js`：

1. `loadBoard()`（第 108-133 行）：
   - `state.agentIds = d.agentIds || [];` 后面加一行 `state.defaultAgentIds = d.defaultAgentIds || d.agentIds || [];`
   - 第 129 行 `if (!state.colOrder) state.colOrder = loadColOrder() || ['all', ...state.agentIds];` 改成 `if (!state.colOrder) state.colOrder = loadColOrder() || ['all', ...state.defaultAgentIds];`
2. `openColManager()`（第 937-942 行）的"恢复默认"按钮：`saveColOrder(['all', ...state.agentIds]);` 改成 `saveColOrder(['all', ...state.defaultAgentIds]);`（对齐修复：现在"恢复默认"和"首次加载默认"用的是两份不同的候选列表，这次统一）
3. `effectiveCols()`（第 27-38 行）本身不改——它的"自动补全新出现的 agent"兜底逻辑是防止 `colOrder` 里缺了某个真实存在的 id（数据完整性兜底，不是装没装的判断），继续用全集 `state.agentIds` 是对的，不属于这次"默认视图"的范围

### 应用管理弹窗加"重新探测"按钮

`openAgentManager()` 里，弹窗头部（`pop-head` 那一行）加一个"重新探测"按钮，点击后 `fetch('/api/agents/status?force=1')` 重新渲染整个弹窗（复用现有的整体重渲染逻辑，不用单独写局部更新）。

## 真实端到端验证（这轮唯一一次真实卸载/重装）

用户确认：pi 基本没有实际用过（没建过项目、store 里没有它的历史会话数据），是验证"未安装 + 无历史数据 → 默认视图自动隐藏"这条新规则的干净样本，风险和上一轮 cli 安装引擎验证时选 pi 的原因一样低（开源小工具、npm 安装、卸了能立刻装回来）。

验证步骤：
1. 确认 pi 目前在 store 里确实没有历史数据（查一下 `store.stmts.agents.all()` 里有没有 `pi`）
2. 真实卸载：`npm uninstall -g @earendil-works/pi-coding-agent`
3. 临时移除 `~/.agent-board/tool-paths.json` 里的 pi 覆盖，让探测反映真实情况（和上一轮 Task 7 一样的手法）
4. 验证：`/api/board` 返回的 `defaultAgentIds` 里不再包含 `pi`（而 `agentIds` 全集里仍然有，因为它还在 `AGENT_DEFS` 里）
5. 通过 UI 应用管理弹窗真实点击"安装"重装 pi（走已经上线的 cli 安装引擎）
6. 验证：安装成功后缓存立即失效（不用等 5 分钟），`/api/board` 的 `defaultAgentIds` 重新包含 `pi`
7. 恢复 `tool-paths.json` 覆盖，确认恢复到 8 个全部 installed 的基线状态

## 实现取舍说明

`defaultAgentIds` 的过滤逻辑是一行 `.filter()`，不为它新建一个独立的、带单测的纯函数模块——`/api/board` 现有的 `agentIds` 拼装逻辑（第 497-500 行）本来就是内联在路由里、没有单测的，这次保持同一风格，不引入新的不一致。`server.js` 路由本身也一直没有路由级单测（`GET /api/agents/status`、`POST /api/rescan` 等都没有），这次的 `getProbe()`/`defaultAgentIds` 同样靠人工 curl/真实点击验证，不新开先例。

## 测试

- 人工验证：见上方"真实端到端验证"整节
- curl 验证缓存生效：连续两次 `GET /api/agents/status`，第二次应该明显更快（不用真的量化到毫秒断言，人工感知即可，因为探测本身在这台机器上也就几百毫秒量级，不构成一个值得写自动化性能测试的场景）
- curl 验证 `?force=1` 确实跳过缓存：改动 `~/.agent-board/tool-paths.json` 后，不带 `force` 的请求应该还是旧数据（5 分钟内），带 `force=1` 的应该立刻反映新数据
