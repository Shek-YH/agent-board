# 探测缓存 + 瀑布流列联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给探测结果加 5 分钟内存缓存（`/api/agents/status` 复用、`force=1` 可跳过），并让首页瀑布流默认列跟着探测结果走——只有"探测为已安装"或"store 里有历史会话数据"的 agent 才出现在默认视图里，不影响用户已手动保存过的列设置。

**Architecture:** `server.js` 加一个模块级探测缓存 `probeCache`，`GET /api/agents/status` 和 `GET /api/board` 共用；安装成功时主动失效。`/api/board` 新增 `defaultAgentIds` 字段（`agentIds` 全集里过滤出"已安装或有数据"的子集），前端只在计算"默认列顺序"时改用这个字段，其余列管理逻辑不变。

**Tech Stack:** Node.js 内置 `http`，无第三方依赖；前端原生 JS。

设计文档：[2026-08-23-agent-detect-cache-column-linkage-design.md](../specs/2026-08-23-agent-detect-cache-column-linkage-design.md)

---

### Task 1: server.js —— 探测缓存基础设施 + `/api/agents/status` 接入

**Files:**
- Modify: `server.js`（`installInProgress` 声明附近，约第 148 行；`/api/agents/status` 路由，约第 712 行；`POST /api/agents/:id/install` 的 `installAgent` 回调，约第 771 行）

- [ ] **Step 1: 加缓存基础设施**

在 `server.js` 里找到：

```js
let installInProgress = false;
```

在它后面插入：

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

- [ ] **Step 2: `/api/agents/status` 改用缓存，支持 `?force=1`**

找到：

```js
      const probed = await detect.probeAll(ADAPTERS);
```

改成：

```js
      const probed = await getProbe(url.searchParams.get('force') === '1');
```

- [ ] **Step 3: 安装成功时主动失效缓存**

找到：

```js
        detect.installAgent(adapter, (step, detail) => {
          sseBroadcast('agent-install-progress', { agentId: id, step, ...detail });
        });
```

改成：

```js
        detect.installAgent(adapter, (step, detail) => {
          if (step === 'done') probeCache = { data: null, ts: 0 };
          sseBroadcast('agent-install-progress', { agentId: id, step, ...detail });
        });
```

- [ ] **Step 4: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('server.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`

- [ ] **Step 5: 跑一遍完整测试套件**

Run: `node --test`（不要带路径参数）
Expected: 全部 PASS，0 失败（应该还是 57/57，这个任务不涉及 `lib/` 下任何文件）

- [ ] **Step 6: 提交**

```bash
git add server.js
git commit -m "feat: server.js 加探测结果缓存（5 分钟 TTL，force=1 跳过，安装成功即失效）"
```

---

### Task 2: server.js —— `/api/board` 联动 `defaultAgentIds`

**Files:**
- Modify: `server.js`（`/api/board` 路由，约第 494-509 行；依赖 Task 1 加的 `getProbe`）

- [ ] **Step 1: 修改 `/api/board`**

找到：

```js
    const groups = {
      all: store.getSessions({ ...qBase, agent: '' }),
    };
    // 动态列：AGENT_DEFS 定义顺序优先，再补 store 实际存在的 agent（如手动导入的自定义名）
    const agentIds = new Set();
    for (const id of Object.keys(AGENT_DEFS)) agentIds.add(id);
    for (const a of store.stmts.agents.all()) if (a.agent) agentIds.add(a.agent);
    for (const id of agentIds) {
      groups[id] = store.getSessions({ ...qBase, agent: id });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // liveRefs：当前实时活跃的 session ref 集合（getActive 按 10 分钟窗口），供前端渲染状态用
    res.end(JSON.stringify({
      groups, agentIds: [...agentIds],
      liveRefs: store.getActive().map((a) => a.sessionRef),
    }));
    return;
  }
```

改成：

```js
    const groups = {
      all: store.getSessions({ ...qBase, agent: '' }),
    };
    // 动态列：AGENT_DEFS 定义顺序优先，再补 store 实际存在的 agent（如手动导入的自定义名）
    const agentIds = new Set();
    const agentsWithData = new Set();
    for (const id of Object.keys(AGENT_DEFS)) agentIds.add(id);
    for (const a of store.stmts.agents.all()) if (a.agent) { agentIds.add(a.agent); agentsWithData.add(a.agent); }
    for (const id of agentIds) {
      groups[id] = store.getSessions({ ...qBase, agent: id });
    }
    // defaultAgentIds：瀑布流默认视图只显示「探测为已安装」或「store 里有历史数据」的 agent 列；
    // 复用探测缓存（不额外增加真实探测开销），只影响默认视图，不影响用户手动保存过的列设置
    const probed = await getProbe();
    const defaultAgentIds = [...agentIds].filter((id) => (probed[id] && probed[id].installed) || agentsWithData.has(id));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // liveRefs：当前实时活跃的 session ref 集合（getActive 按 10 分钟窗口），供前端渲染状态用
    res.end(JSON.stringify({
      groups, agentIds: [...agentIds], defaultAgentIds,
      liveRefs: store.getActive().map((a) => a.sessionRef),
    }));
    return;
  }
```

- [ ] **Step 2: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('server.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`

- [ ] **Step 3: 跑一遍完整测试套件**

Run: `node --test`
Expected: 全部 PASS，0 失败

- [ ] **Step 4: 提交**

```bash
git add server.js
git commit -m "feat: /api/board 新增 defaultAgentIds（已安装或有历史数据的 agent 子集）"
```

---

### Task 3: 前端 —— `loadBoard`/列设置弹窗联动 `defaultAgentIds`

**Files:**
- Modify: `public/app.js`（`state` 初始对象，约第 8 行；`loadBoard()`，约第 108-133 行；`openColManager()` 的"恢复默认"按钮，约第 937-942 行）

- [ ] **Step 1: `state` 初始对象加 `defaultAgentIds`**

找到：

```js
  board: {}, agentIds: [], colOrder: null,
```

改成：

```js
  board: {}, agentIds: [], defaultAgentIds: [], colOrder: null,
```

- [ ] **Step 2: `loadBoard()` 接住新字段，首次默认列改用它**

找到：

```js
    state.board = d.groups || state.board;
    state.agentIds = d.agentIds || [];
    // 后端返回的实时活跃集合：只并入不覆盖——移除动作完全由 SSE active 事件权威执行，
    // 避免 loadBoard 重建时（即使后端快照 status 恰好过期）把进行中会话闪回「已完成」
    if (Array.isArray(d.liveRefs)) {
      const next = new Set(d.liveRefs);
      for (const r of state.liveRefs) next.add(r);
      state.liveRefs = next;
    }
    // 首次加载：把当前配置的列存好（默认 = all + 所有 agent）
    if (!state.colOrder) state.colOrder = loadColOrder() || ['all', ...state.agentIds];
```

改成：

```js
    state.board = d.groups || state.board;
    state.agentIds = d.agentIds || [];
    // defaultAgentIds：探测为已安装 或 有历史数据的 agent 子集，只用来算「默认列」，
    // 不影响 state.agentIds（列设置弹窗仍然要能看到全部 agent，供手动勾选恢复）
    state.defaultAgentIds = d.defaultAgentIds || d.agentIds || [];
    // 后端返回的实时活跃集合：只并入不覆盖——移除动作完全由 SSE active 事件权威执行，
    // 避免 loadBoard 重建时（即使后端快照 status 恰好过期）把进行中会话闪回「已完成」
    if (Array.isArray(d.liveRefs)) {
      const next = new Set(d.liveRefs);
      for (const r of state.liveRefs) next.add(r);
      state.liveRefs = next;
    }
    // 首次加载：把当前配置的列存好（默认 = all + 探测/历史数据过滤后的 agent）
    if (!state.colOrder) state.colOrder = loadColOrder() || ['all', ...state.defaultAgentIds];
```

- [ ] **Step 3: "恢复默认"按钮改用 `defaultAgentIds`（对齐修复）**

找到：

```js
  pop.querySelector('#cols-reset').onclick = () => {
    state.colOrder = null;
    saveColOrder(['all', ...state.agentIds]);
    closePopover();
    loadBoard();
  };
```

改成：

```js
  pop.querySelector('#cols-reset').onclick = () => {
    state.colOrder = null;
    saveColOrder(['all', ...state.defaultAgentIds]);
    closePopover();
    loadBoard();
  };
```

**不要改的地方**：`effectiveCols()`（文件开头，约第 27-38 行）和 `openColManager()` 里 `const items = [...state.agentIds];`（约第 877 行）都继续用全集 `state.agentIds`，不改成 `defaultAgentIds`——前者是"防止配置了不存在的列"的数据完整性兜底，后者是列设置弹窗要能让用户看到全部 8 个 agent 供手动勾选（包括被默认隐藏的），这两处都不属于"默认视图"的范围，改了会破坏各自的功能。

- [ ] **Step 4: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('public/app.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`

- [ ] **Step 5: 提交**

```bash
git add public/app.js
git commit -m "feat: 首页默认列联动探测结果（已安装或有历史数据才默认显示）"
```

---

### Task 4: 前端 —— 应用管理弹窗"重新探测"按钮

**Files:**
- Modify: `public/app.js`（`openAgentManager()` 函数，约第 951-1050 行；`$('btn-agents').onclick`，约第 1052 行）

- [ ] **Step 1: 函数加 `force` 参数，fetch 带上 `?force=1`**

找到：

```js
async function openAgentManager() {
  closePopover();
  state.popoverFor = 'agents';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '420px';
  pop.style.maxWidth = '520px';
  document.body.appendChild(pop);
  pop.innerHTML = '<div class="pop-head">应用管理</div><div style="padding:16px;color:var(--text3);font-size:13px">检测中…</div>';

  let data;
  try {
    const r = await fetch('/api/agents/status');
    data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
  } catch {
    pop.innerHTML = '<div class="pop-head">应用管理</div><div style="padding:16px;color:var(--text3);font-size:13px">检测失败，请稍后重试</div>';
    return;
  }

  const agents = Object.values(data.agents || {});
  let html = `<div class="pop-head">应用管理 <span style="opacity:.5;font-weight:400">（命令行/桌面类工具支持一键安装）</span></div>
    <div style="padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:60vh;overflow-y:auto">`;
```

改成：

```js
async function openAgentManager(force) {
  closePopover();
  state.popoverFor = 'agents';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '420px';
  pop.style.maxWidth = '520px';
  document.body.appendChild(pop);
  pop.innerHTML = '<div class="pop-head">应用管理</div><div style="padding:16px;color:var(--text3);font-size:13px">检测中…</div>';

  let data;
  try {
    const r = await fetch('/api/agents/status' + (force ? '?force=1' : ''));
    data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
  } catch {
    pop.innerHTML = '<div class="pop-head">应用管理</div><div style="padding:16px;color:var(--text3);font-size:13px">检测失败，请稍后重试</div>';
    return;
  }

  const agents = Object.values(data.agents || {});
  // 探测结果服务端有 5 分钟缓存，这里加个「重新探测」按钮手动跳过缓存（force=1）
  let html = `<div class="pop-head">应用管理 <span style="opacity:.5;font-weight:400">（命令行/桌面类工具支持一键安装）</span>
    <button class="btn ab-rescan-probe" style="float:right;min-height:22px;padding:2px 8px;font-size:11px">重新探测</button>
  </div>
    <div style="padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:60vh;overflow-y:auto">`;
```

- [ ] **Step 2: 渲染完成后绑定"重新探测"按钮**

找到：

```js
  html += '</div>';
  pop.innerHTML = html;

  // 安装按钮：能静默装的（picked 有值）走「确认 + POST + SSE」；只能手动下载的直接跳转下载页
  pop.querySelectorAll('.ab-install').forEach((b) => {
```

改成：

```js
  html += '</div>';
  pop.innerHTML = html;

  const rescanBtn = pop.querySelector('.ab-rescan-probe');
  if (rescanBtn) rescanBtn.onclick = () => openAgentManager(true);

  // 安装按钮：能静默装的（picked 有值）走「确认 + POST + SSE」；只能手动下载的直接跳转下载页
  pop.querySelectorAll('.ab-install').forEach((b) => {
```

- [ ] **Step 3: 修正 `btn-agents` 的事件绑定（重要，容易踩坑）**

`openAgentManager` 现在接受一个 `force` 参数。如果直接把函数本身赋给 `onclick`（`el.onclick = openAgentManager`），浏览器点击时会把 **click 事件对象**作为第一个参数传进去——事件对象是真值，等于每次点开应用管理弹窗都会被当成 `force=true`，缓存直接失去意义。

找到：

```js
$('btn-agents').onclick = openAgentManager;
```

改成：

```js
$('btn-agents').onclick = () => openAgentManager();
```

**不要改**第 1137 行附近、SSE 收到 `done` 事件后触发的那次自动刷新（`if (state.popoverFor === 'agents') setTimeout(() => openAgentManager(), 600);`）——保持无参数调用。安装成功那一刻服务端已经在 Task 1 里把缓存主动失效了，这里再传 `true` 强制跳过缓存没有意义，纯属多余。

- [ ] **Step 4: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('public/app.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`

- [ ] **Step 5: 提交**

```bash
git add public/app.js
git commit -m "feat: 应用管理弹窗加「重新探测」按钮，修正 btn-agents 事件绑定避免误传 force"
```

---

### Task 5: 验证缓存行为（不做真实安装/卸载）

**Files:** 无代码改动，纯验证

- [ ] **Step 1: 跑全部单元测试**

Run: `node --test`
Expected: 全部 PASS，0 失败

- [ ] **Step 2: 重启 server.js 让新代码生效**

用 PowerShell 工具（不要用 Bash 工具的 `cmd.exe`，这台机器上它的 PATH 缺 `WindowsApps`，会导致部分命令解析行为跟正常用户会话不一致）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent-board\server.js*' } | Select-Object ProcessId
```

记下 ProcessId，只结束这一个（绝对不能碰看门狗进程）：

```powershell
Stop-Process -Id <上面记下的PID> -Force -Confirm:$false
```

等待约 70 秒，确认新进程已经起来且只有一个：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent-board\server.js*' } | Select-Object ProcessId, CreationDate
```
Expected: 只有一条记录，`CreationDate` 是重启之后的时间

- [ ] **Step 3: 用请求耗时验证缓存确实生效**

```bash
echo "第一次（冷，重启后首次探测）："
curl -s -o /dev/null -w "%{time_total}s\n" http://127.0.0.1:4876/api/agents/status
echo "第二次（应该命中缓存，明显更快）："
curl -s -o /dev/null -w "%{time_total}s\n" http://127.0.0.1:4876/api/agents/status
echo "第三次，带 force=1（应该跳过缓存，耗时接近第一次）："
curl -s -o /dev/null -w "%{time_total}s\n" "http://127.0.0.1:4876/api/agents/status?force=1"
```
Expected: 第二次明显快于第一次和第三次（第一次和第三次都是真实探测，耗时量级接近；第二次是内存读取，应该快一个数量级以上）。这是人工判断耗时数字合理与否，不是精确断言。

- [ ] **Step 4: 验证 `/api/board` 返回 `defaultAgentIds`**

```bash
curl -s http://127.0.0.1:4876/api/board | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  console.log('agentIds:', JSON.stringify(j.agentIds));
  console.log('defaultAgentIds:', JSON.stringify(j.defaultAgentIds));
});"
```
Expected: `defaultAgentIds` 是一个数组字段，存在且是 `agentIds` 的子集（这台机器目前 8 个 agent 全部 installed，所以这一步预期两个数组内容相同，只是确认字段存在、类型正确——真正的"过滤生效"验证在 Task 6 里用 pi 真实测）

---

### Task 6: 真实端到端验证——卸载再装一次 pi，验证列自动隐藏/恢复

**Files:** 无代码改动，纯验证

**背景**：用户确认 pi 基本没有实际用过，原计划是拿它当"未安装+无历史数据→默认隐藏"这条规则的干净样本。**2026-08-23 实测发现前提不成立**：Step 1 一跑，`pi 的会话数` 实际是 `1`，不是 `0`（用户记忆有误，不是 bug）。这台机器上其余候选工具风险都更高（workbuddy 疑似是本机工具链的一部分；claude/codex/deepseek 是当前会话可能依赖的真实开发工具；doubao 被排除；marvis/zcode 都是真实在用的桌面应用），没有更干净的候选，所以不再追加一个新工具去真测"隐藏"这一支；转而用 pi 现有的"1 条历史"实测"有历史数据 → 即使未安装也保留可见"这一支（同一个 `||` 条件表达式的另一半），配合上一轮已经跑通的 cli 安装引擎，一次性验证：真实卸装/重装 + 缓存失效 + 列联动。"未安装且零历史 → 隐藏"这一支不做真实点击验证，靠代码审查（`(probed[id]?.installed) || agentsWithData.has(id)` 这个布尔表达式足够简单，"有历史保留可见"分支被真实验证过之后，"两个条件都不满足才会被过滤掉"是同一行代码逻辑上的必然推论，不是另一套没测过的逻辑）——这个取舍和上一轮 GUI 安装引擎验证时"这台机器上 4 个 gui 工具全部已安装，没法伪造未安装状态"是同一类型的、如实记录的范围收窄，不是疏漏。

- [ ] **Step 1: 确认 pi 目前的历史会话数（记录真实值，不强制要求是 0）**

```bash
curl -s "http://127.0.0.1:4876/api/board?limit=1" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  console.log('pi 的会话数:', (j.groups.pi||[]).length);
});"
```
Expected: 记录实际数字即可（已知是 `1`，不是 `0`）。只要这个数字 > 0，就走下面"有历史数据保留可见"的验证路径。

- [ ] **Step 2: 记录当前 pi 版本，真实卸载**

```bash
cmd.exe /c "pi --version"
```
记下版本号。然后：
```bash
cmd.exe /c "npm uninstall -g @earendil-works/pi-coding-agent"
```
确认真的卸掉了：
```bash
cmd.exe /c "pi --version"
```
Expected: 报"找不到命令"之类的错误

- [ ] **Step 3: 临时移除 pi 的路径覆盖，让探测反映真实情况**

先完整读一遍 `~/.agent-board/tool-paths.json`（即 `%USERPROFILE%\.agent-board\tool-paths.json`）记下原始内容，后面 Step 6 要原样恢复。然后：

```bash
node -e "const fs=require('fs'),p=process.env.USERPROFILE+'/.agent-board/tool-paths.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));delete j.pi;fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('已临时移除 pi 覆盖')"
```

- [ ] **Step 4: 验证卸载后 `defaultAgentIds` 里仍然有 pi（因为有历史数据，OR 条件的另一半生效）**

```bash
curl -s "http://127.0.0.1:4876/api/agents/status?force=1" > /dev/null
curl -s http://127.0.0.1:4876/api/board | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  console.log('agentIds 里有 pi:', j.agentIds.includes('pi'));
  console.log('defaultAgentIds 里有 pi:', j.defaultAgentIds.includes('pi'));
});"
```
Expected（按 pi 实际有 1 条历史数据调整后的预期）：`agentIds 里有 pi: true`；`defaultAgentIds 里有 pi: true`——虽然此刻 pi 探测为未安装，但 store 里有它的历史数据，`(probed.pi?.installed) || agentsWithData.has('pi')` 里 OR 的右半边为真，仍然保留在默认视图里，这正是设计文档里"有历史数据就显示"那条决策要验证的行为。

**注**：第一条 `curl ".../status?force=1"` 是为了让 Task 1 的探测缓存失效并重新探测一次（服务端探测缓存 5 分钟 TTL，不强制刷新的话 `/api/board` 可能还在用卸载前缓存的"已安装"数据，导致这一步误判）；第二条 `/api/board` 的调用不需要 force，因为 Task 2 里 `/api/board` 用的 `getProbe()` 不强制但会自然复用刚刚被刷新过的缓存。

- [ ] **Step 5: 通过 UI 真实点击"安装"重装 pi**

浏览器打开 `http://127.0.0.1:4876`，点"应用管理"，pi 卡片应显示"未检测到"+"安装"按钮（这是 Task 4 之前就有的 cli 安装引擎功能，这里只是复用它做真实验证）。点"安装"，confirm 弹窗点**确定**。观察状态行依次出现"安装中…"→"校验中…"→"完成"。

- [ ] **Step 6: 交叉确认真的装上了，且 `defaultAgentIds` 恢复包含 pi**

```bash
cmd.exe /c "pi --version"
```
Expected: 输出版本号（应该和 Step 2 记的一致或更新）

```bash
curl -s http://127.0.0.1:4876/api/board | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  console.log('defaultAgentIds 里有 pi:', j.defaultAgentIds.includes('pi'));
});"
```
Expected: `defaultAgentIds 里有 pi: true`——不用等 5 分钟 TTL，因为 Task 1 Step 3 已经让安装成功（`done` 事件）主动失效了缓存，这里应该立刻就能看到最新状态

- [ ] **Step 7: 恢复 pi 的路径覆盖**

```bash
node -e "const fs=require('fs'),p=process.env.USERPROFILE+'/.agent-board/tool-paths.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.pi=['D:\\\\Program Files\\\\node-v22.14.0-win-x64\\\\node_global\\\\pi.cmd'];fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('已恢复 pi 覆盖')"
```

**重要**：上一轮的经验教训——这条 `node -e` 命令如果通过 Bash 工具的 git-bash 环境执行，内嵌的 `D:\...` 风格路径里的反斜杠转义在传递过程中可能被破坏（上一轮真实发生过，2 个反斜杠丢失导致路径损坏）。执行完之后必须读回文件验证：

```bash
node -e "
const fs=require('fs'),p=process.env.USERPROFILE+'/.agent-board/tool-paths.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
console.log('pi 覆盖路径:', j.pi);
console.log('文件真实存在:', require('fs').existsSync(j.pi[0]));
"
```
Expected: `pi 覆盖路径: [ 'D:\\Program Files\\node-v22.14.0-win-x64\\node_global\\pi.cmd' ]`，`文件真实存在: true`。如果路径不对或文件不存在，不要将就——用 Write 工具直接写入正确的完整 JSON 内容（绕开 shell 转义问题），再读回验证一次。

```bash
curl -s "http://127.0.0.1:4876/api/agents/status?force=1" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  console.log('全部 8 个 installed:', Object.values(j.agents).every(a=>a.installed));
});"
```
Expected: `全部 8 个 installed: true`（恢复到这轮开工前的状态）

---

## 完成后

这份计划跑完，agent-board 能：
- 探测结果有 5 分钟内存缓存，`/api/board` 高频调用不再每次都触发完整探测
- 首页瀑布流默认视图只显示"探测为已安装"或"有历史会话数据"的 agent 列，不再固定显示全部 8 个
- 用户手动保存过的列设置完全不受影响
- 应用管理弹窗可以手动"重新探测"跳过缓存，安装成功后缓存也会立即失效，不用等 5 分钟
- "恢复默认"按钮和"首次加载默认"用的是同一份过滤后的默认列表，不再不一致

**没做的**（如果以后要做）：
- 缓存过期/重新探测中的 loading 态提示（这次是静默刷新）
- 缓存的 TTL 不可配置（写死 5 分钟，没有做成环境变量或设置项）
