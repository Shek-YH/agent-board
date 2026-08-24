# GUI 类工具安装引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `tier:'gui'` 的 workbuddy / zcode / marvis 三个工具接上"安装"按钮——能静默装的（workbuddy/zcode 在 win32 上都能用 winget）走上一轮已经建好的"确认 + POST + SSE 进度"流程；只能手动下载的（marvis）点击后直接打开官方下载页，不追踪进度。

**Architecture:** 复用上一轮 cli 安装引擎已经建好的 `install.picked`/`install.pickedCommand`（服务端算好、和真正执行的命令保证一致）。前端按 `picked` 是否有值分两条路径：有值走原有的静默安装流程；没有值但 `methods` 里有 `download` 方式，就直接 `window.open` 跳转，不经过后端、不占用安装锁。后端只需要把 `POST /api/agents/:id/install` 的 tier 校验从"只允许 cli"放宽到"允许 cli 和 gui"。

**Tech Stack:** Node.js 内置 `http`/`node:test`，无第三方依赖；前端原生 JS，无构建工具。

设计文档：[2026-08-22-agent-gui-install-design.md](../specs/2026-08-22-agent-gui-install-design.md)

---

### Task 1: Adapter 数据修正 + 回归测试

**Files:**
- Modify: `lib/adapters/workbuddy.js`（`detect.install.methods` 里的 `download` 方法，约第 231 行）
- Modify: `lib/adapters/marvis.js`（`detect.install`，约第 163 行）
- Test: `lib/detect.test.js`（追加到文件末尾）

- [ ] **Step 1: 写失败测试**

在 `lib/detect.test.js` 文件末尾追加：

```js
test('workbuddy 的下载页地址是 workbuddy.cn（不是旧的 codebuddy.cn）', () => {
  const workbuddy = require('./adapters/workbuddy');
  const dl = workbuddy.detect.install.methods.find((m) => m.kind === 'download');
  assert.ok(dl, 'workbuddy 应该有一个 download 方式');
  assert.equal(dl.url, 'https://www.workbuddy.cn/work/#download-section');
});

test('workbuddy 的 winget 方式仍然保留（实测 winget 里真实存在 Tencent.WorkBuddy 5.3.14）', () => {
  const workbuddy = require('./adapters/workbuddy');
  const wg = workbuddy.detect.install.methods.find((m) => m.kind === 'winget');
  assert.ok(wg, 'workbuddy 应该保留 winget 方式');
  assert.equal(wg.id, 'Tencent.WorkBuddy');
});

test('pickMethod 对 workbuddy 真实数据在 win32 上选中 winget', () => {
  const workbuddy = require('./adapters/workbuddy');
  const m = pickMethod(workbuddy.detect.install.methods, 'win32');
  assert.ok(m, 'workbuddy 在 win32 上应该能选出方法');
  assert.equal(m.kind, 'winget');
  assert.equal(m.id, 'Tencent.WorkBuddy');
});

test('pickMethod 对 zcode 真实数据在 win32 上选中 winget（zcode.js 本轮不改，锁定现有正确行为）', () => {
  const zcode = require('./adapters/zcode');
  const m = pickMethod(zcode.detect.install.methods, 'win32');
  assert.ok(m, 'zcode 在 win32 上应该能选出方法');
  assert.equal(m.kind, 'winget');
  assert.equal(m.id, 'ZhipuAI.ZCode');
});

test('marvis 现在有一个 download 方式，指向 marvis.qq.com', () => {
  const marvis = require('./adapters/marvis');
  assert.equal(marvis.detect.install.methods.length, 1);
  assert.equal(marvis.detect.install.methods[0].kind, 'download');
  assert.equal(marvis.detect.install.methods[0].url, 'https://marvis.qq.com/');
});

test('marvis 的 warning 文案已更新（不再是"待确认"）', () => {
  const marvis = require('./adapters/marvis');
  assert.equal(marvis.detect.install.warning, '仅支持手动下载安装，暂无命令行安装方式');
});

test('pickMethod 对 marvis 真实数据返回 null（只有 download 方式，没有能静默执行的）', () => {
  const marvis = require('./adapters/marvis');
  const m = pickMethod(marvis.detect.install.methods, 'win32');
  assert.equal(m, null);
});

```

- [ ] **Step 2: 运行测试，确认新增的 4 个断言按预期失败**

Run: `node --test` (不要带路径参数)
Expected: 新增的 7 个测试里，`workbuddy 的下载页地址是 workbuddy.cn`、`marvis 现在有一个 download 方式`、`marvis 的 warning 文案已更新` 这 3 个 FAIL（因为生产代码还没改）；其余 4 个（`workbuddy 的 winget 方式仍然保留`、两个 `pickMethod` 真实数据测试、`marvis 返回 null`）应该已经 PASS，因为它们断言的是这一轮**不改**的现有行为。

- [ ] **Step 3: 修改 `lib/adapters/workbuddy.js`**

找到（约第 228-234 行）：

```js
  install: {
    methods: [
      { kind: 'winget', id: 'Tencent.WorkBuddy', flags: ['--accept-package-agreements', '--accept-source-agreements'] },
      { kind: 'download', url: 'https://www.codebuddy.cn/work/' },
    ],
    warning: 'Linux 不支持',
  },
```

改成：

```js
  install: {
    methods: [
      { kind: 'winget', id: 'Tencent.WorkBuddy', flags: ['--accept-package-agreements', '--accept-source-agreements'] },
      { kind: 'download', url: 'https://www.workbuddy.cn/work/#download-section' },
    ],
    warning: 'Linux 不支持',
  },
```

（只改 `download.url` 这一行，`winget` 条目不动——2026-08-22 已用 `winget search --id Tencent.WorkBuddy --exact` 实测确认这个包真实存在，用户确认保留。）

- [ ] **Step 4: 修改 `lib/adapters/marvis.js`**

找到（约第 156-165 行）：

```js
// 探测配置：Marvis 同样不在 EchoBird 支持范围内，官方下载地址待确认，这轮 install.methods 留空。
// probe 复用上面已有的 ROOT 常量（本机是否有 Marvis 会话数据目录）。
const detect = {
  tier: 'gui',
  identityGuard: { description: 'Marvis（腾讯）桌面 AI 助手', notToConfuseWith: [] },
  requirements: {},
  probe: { kind: 'path', win32: [ROOT], darwin: [], linux: [] },
  install: { methods: [], warning: '官方下载地址待确认，这轮只做探测' },
  network: { testUrls: [], mirrors: {}, blockedRegions: {} },
};
```

改成：

```js
// 探测配置：Marvis 不在 EchoBird 支持范围内，没有命令行安装方式，只能手动下载安装
// （官方下载页 2026-08-22 由用户提供：https://marvis.qq.com/）。
// probe 复用上面已有的 ROOT 常量（本机是否有 Marvis 会话数据目录）。
const detect = {
  tier: 'gui',
  identityGuard: { description: 'Marvis（腾讯）桌面 AI 助手', notToConfuseWith: [] },
  requirements: {},
  probe: { kind: 'path', win32: [ROOT], darwin: [], linux: [] },
  install: {
    methods: [{ kind: 'download', url: 'https://marvis.qq.com/' }],
    warning: '仅支持手动下载安装，暂无命令行安装方式',
  },
  network: { testUrls: [], mirrors: {}, blockedRegions: {} },
};
```

- [ ] **Step 5: 运行测试，确认全部通过**

Run: `node --test`
Expected: 全部测试 PASS，0 失败（新增的 7 个测试全绿，加上之前已有的全部继续通过）

- [ ] **Step 6: 提交**

```bash
git add lib/adapters/workbuddy.js lib/adapters/marvis.js lib/detect.test.js
git commit -m "feat: 修正 workbuddy 下载页域名 + marvis 补上下载安装方式"
```

---

### Task 2: server.js —— 放宽安装接口的 tier 校验

**Files:**
- Modify: `server.js`（`POST /api/agents/:id/install` 路由，tier 校验，约第 755-758 行）

**说明**：这个改动不加专门的单元测试——仓库里目前没有任何 `server.js` 路由的单元测试（`GET /api/agents/status`、`POST /api/rescan` 等都没有），一直是靠人工 curl 验证，这次跟随现有约定，验证放进 Task 4。

- [ ] **Step 1: 修改 tier 校验**

在 `server.js` 里找到：

```js
    if (adapter.detect.tier !== 'cli') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '这一版只支持命令行类工具的自动安装' }));
      return;
    }
```

改成：

```js
    if (adapter.detect.tier !== 'cli' && adapter.detect.tier !== 'gui') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '这一版只支持命令行类和桌面类工具的自动安装' }));
      return;
    }
```

- [ ] **Step 2: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('server.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`

- [ ] **Step 3: 跑一遍完整测试套件，确认没有破坏别的东西**

Run: `node --test`
Expected: 全部 PASS，0 失败

- [ ] **Step 4: 提交**

```bash
git add server.js
git commit -m "feat: /api/agents/:id/install 放宽 tier 校验，允许 gui 类工具"
```

---

### Task 3: 前端 —— gui 类工具的安装/下载按钮

**Files:**
- Modify: `public/app.js`（`openAgentManager` 函数里的卡片渲染 + 安装按钮点击逻辑，约第 975-1029 行）

- [ ] **Step 1: 替换卡片渲染 + 点击逻辑整段**

在 `public/app.js` 里找到这一整段（从 `const agents = Object.values(data.agents || {});` 到 `openAgentManager` 函数结尾的 `}`）：

```js
  const agents = Object.values(data.agents || {});
  let html = `<div class="pop-head">应用管理 <span style="opacity:.5;font-weight:400">（命令行类工具支持一键安装）</span></div>
    <div style="padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:60vh;overflow-y:auto">`;
  for (const a of agents) {
    const badge = a.installed
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#DCFCE7;color:#15803D">已安装${a.version ? ' ' + esc(a.version) : ''}</span>`
      : `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--text3)">未检测到</span>`;
    // 只有未安装的 cli 类工具给「安装」按钮（gui 类下一版再说）
    const canInstall = !a.installed && a.tier === 'cli' && a.install && (a.install.methods || []).length;
    const btn = canInstall
      ? `<div style="margin-top:6px"><button class="btn ab-install" data-id="${esc(a.id)}" style="min-height:28px;padding:3px 12px;font-size:12px">安装</button></div>`
      : '';
    html += `<div class="ab-card" data-id="${esc(a.id)}" style="border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center">
      <div style="width:32px;height:32px;border-radius:8px;margin:0 auto 6px;background:${esc(a.color || '#888')};display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:600">${esc((a.name || a.id || '?').slice(0, 1))}</div>
      <div style="font-size:12px;font-weight:600;margin-bottom:4px">${esc(a.name || a.id)}</div>
      ${badge}
      <div class="ab-progress" style="font-size:11px;color:var(--text3);margin-top:6px;min-height:14px"></div>
      ${btn}
    </div>`;
  }
  html += '</div>';
  pop.innerHTML = html;

  // 安装按钮：先弹确认（展示要跑的命令 + 警告文案），确认后 POST，进度走 SSE
  pop.querySelectorAll('.ab-install').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.id;
      const a = data.agents[id];
      // pickedCommand 是服务端用 methodToCommand() 拼出的真实命令（和 installAgent 实际执行的完全一致），
      // 前端不再自己拼一遍，避免两边逻辑分叉（比如漏掉 winget 的 flags）
      const cmdHint = a.install.pickedCommand || '(未知)';
      const warn = a.install.warning ? `\n\n注意：${a.install.warning}` : '';
      if (!confirm(`即将安装 ${a.name || id}\n\n将执行：${cmdHint}${warn}\n\n确定继续吗？`)) return;
      b.disabled = true;
      // 一次只能装一个：把所有安装按钮都禁掉，等这次跑完再刷新
      pop.querySelectorAll('.ab-install').forEach((x) => { x.disabled = true; });
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(id)}/install`, { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
        // 兜底：SSE 如果断线重连，装完的终态事件可能丢失，按钮会一直锁死。
        // 给一个比后端 10 分钟安装超时更长的兜底计时器，到点了还没收到终态事件就自己解锁。
        if (installFallbackTimer) clearTimeout(installFallbackTimer);
        installFallbackTimer = setTimeout(() => {
          installFallbackTimer = null;
          document.querySelectorAll('.ab-install').forEach((x) => { x.disabled = false; });
          toast('安装状态未知，可能已完成或失败——请刷新查看');
        }, 11 * 60 * 1000);
      } catch (e) {
        toast('安装请求失败：' + (e.message || '未知错误'));
        pop.querySelectorAll('.ab-install').forEach((x) => { x.disabled = false; });
      }
    };
  });
}
```

整段替换成：

```js
  const agents = Object.values(data.agents || {});
  let html = `<div class="pop-head">应用管理 <span style="opacity:.5;font-weight:400">（命令行/桌面类工具支持一键安装）</span></div>
    <div style="padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:60vh;overflow-y:auto">`;
  for (const a of agents) {
    const badge = a.installed
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#DCFCE7;color:#15803D">已安装${a.version ? ' ' + esc(a.version) : ''}</span>`
      : `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--text3)">未检测到</span>`;
    // 未安装的 cli/gui 类工具、且有至少一种安装方式，才给按钮；
    // 按钮文案区分「能静默装」（picked 有值）和「只能手动下载」（picked 为空）
    const canInstall = !a.installed && (a.tier === 'cli' || a.tier === 'gui') && a.install && (a.install.methods || []).length;
    const btnLabel = a.install && a.install.picked ? '安装' : '下载安装';
    const btn = canInstall
      ? `<div style="margin-top:6px"><button class="btn ab-install" data-id="${esc(a.id)}" style="min-height:28px;padding:3px 12px;font-size:12px">${btnLabel}</button></div>`
      : '';
    html += `<div class="ab-card" data-id="${esc(a.id)}" style="border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center">
      <div style="width:32px;height:32px;border-radius:8px;margin:0 auto 6px;background:${esc(a.color || '#888')};display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:600">${esc((a.name || a.id || '?').slice(0, 1))}</div>
      <div style="font-size:12px;font-weight:600;margin-bottom:4px">${esc(a.name || a.id)}</div>
      ${badge}
      <div class="ab-progress" style="font-size:11px;color:var(--text3);margin-top:6px;min-height:14px"></div>
      ${btn}
    </div>`;
  }
  html += '</div>';
  pop.innerHTML = html;

  // 安装按钮：能静默装的（picked 有值）走「确认 + POST + SSE」；只能手动下载的直接跳转下载页
  pop.querySelectorAll('.ab-install').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.id;
      const a = data.agents[id];

      // 没有能静默执行的方法：找 download 方式直接跳转，不经过后端、不占用安装锁
      if (!a.install.picked) {
        const dl = (a.install.methods || []).find((m) => m.kind === 'download');
        if (dl && dl.url) {
          window.open(dl.url, '_blank');
          toast('已在新标签页打开下载页，按提示完成安装后关闭再重新打开本弹窗可刷新状态');
          return;
        }
        // 理论上不会发生（canInstall 已经要求 methods.length>0）：没有 download 方式时，
        // 不在前端假装成功，落回原来的静默安装流程，让后端 installAgent 报 no-method，
        // SSE 会显示「这个平台没有可用的安装方式」
      }

      // pickedCommand 是服务端用 methodToCommand() 拼出的真实命令（和 installAgent 实际执行的完全一致），
      // 前端不再自己拼一遍，避免两边逻辑分叉（比如漏掉 winget 的 flags）
      const cmdHint = a.install.pickedCommand || '(未知)';
      const warn = a.install.warning ? `\n\n注意：${a.install.warning}` : '';
      if (!confirm(`即将安装 ${a.name || id}\n\n将执行：${cmdHint}${warn}\n\n确定继续吗？`)) return;
      b.disabled = true;
      // 一次只能装一个：把所有安装按钮都禁掉，等这次跑完再刷新
      pop.querySelectorAll('.ab-install').forEach((x) => { x.disabled = true; });
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(id)}/install`, { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
        // 兜底：SSE 如果断线重连，装完的终态事件可能丢失，按钮会一直锁死。
        // 给一个比后端 10 分钟安装超时更长的兜底计时器，到点了还没收到终态事件就自己解锁。
        if (installFallbackTimer) clearTimeout(installFallbackTimer);
        installFallbackTimer = setTimeout(() => {
          installFallbackTimer = null;
          document.querySelectorAll('.ab-install').forEach((x) => { x.disabled = false; });
          toast('安装状态未知，可能已完成或失败——请刷新查看');
        }, 11 * 60 * 1000);
      } catch (e) {
        toast('安装请求失败：' + (e.message || '未知错误'));
        pop.querySelectorAll('.ab-install').forEach((x) => { x.disabled = false; });
      }
    };
  });
}
```

- [ ] **Step 2: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('public/app.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`

- [ ] **Step 3: 提交**

```bash
git add public/app.js
git commit -m "feat: 应用管理弹窗支持 gui 类工具安装（静默装或跳转下载页）"
```

---

### Task 4: 验证（不做真实安装/卸载）

**Files:** 无代码改动，纯验证

**范围说明**：这台机器上 workbuddy / zcode / marvis 目前全部处于"已安装"状态（真实探测结果，不是测试数据），而且 gui 类的探测方式是 registry/path 扫描，不像 cli 类那样有 `~/.agent-board/tool-paths.json` 覆盖机制可以临时伪造"未安装"状态。这意味着**这一轮没有安全的办法在这台机器上真正点开一个 gui 类工具的安装/下载按钮走一遍完整流程**——要做到这一点，唯一的办法是删除某个工具的真实本地数据来伪造"未安装"，这会破坏用户的真实数据，不做。因此这一轮的验证止步于"数据正确 + 代码审查确认接线正确"，不做真实点击验证，如实记录这个限制，不假装做了完整的端到端验证。

- [ ] **Step 1: 跑全部单元测试**

Run: `node --test`
Expected: 全部 PASS，0 失败

- [ ] **Step 2: 重启 server.js 让新代码生效**

`server.js` 是常驻进程（被 `agent-board-watchdog.js` 看护），代码改了不会自动生效，需要结束现有进程、等看门狗在 60-70 秒内自动拉起新的。**只结束 `server.js` 自己的进程，绝对不能碰看门狗进程本身**（找到 `node.exe` 里 `CommandLine` 包含 `agent-board\server.js` 的那一个，通常需要用 PowerShell 工具而不是 Bash 工具的 `cmd.exe`，因为这台机器上 Bash 工具的 `cmd.exe` 会话 PATH 里缺 `WindowsApps`，一些命令解析行为跟正常用户会话不一致）。

用 PowerShell 工具执行：
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent-board\server.js*' } | Select-Object ProcessId
```
记下 ProcessId，然后：
```powershell
Stop-Process -Id <上面记下的PID> -Force -Confirm:$false
```

等待约 70 秒（可以用 `Start-Sleep -Seconds 70`），再确认新进程已经起来且只有一个：
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent-board\server.js*' } | Select-Object ProcessId, CreationDate
```
Expected: 只有一条记录，`CreationDate` 是刚才重启之后的时间

- [ ] **Step 3: curl 验证 workbuddy/zcode 的静默安装数据正确**

```bash
curl -s http://127.0.0.1:4876/api/agents/status | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  for (const id of ['workbuddy','zcode']) {
    const a=j.agents[id];
    console.log(id, 'picked.kind=', a.install.picked && a.install.picked.kind, ' pickedCommand=', a.install.pickedCommand);
  }
});"
```
Expected：
```
workbuddy picked.kind= winget  pickedCommand= winget install --id Tencent.WorkBuddy --accept-package-agreements --accept-source-agreements
zcode picked.kind= winget  pickedCommand= winget install --id ZhipuAI.ZCode --accept-package-agreements --accept-source-agreements
```

- [ ] **Step 4: curl 验证 marvis 的下载数据正确**

```bash
curl -s http://127.0.0.1:4876/api/agents/status | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  const a=j.agents.marvis;
  console.log('picked=', a.install.picked, ' methods=', JSON.stringify(a.install.methods), ' warning=', a.install.warning);
});"
```
Expected：`picked= null`，`methods` 里只有一条 `{"kind":"download","url":"https://marvis.qq.com/"}`，`warning` 是"仅支持手动下载安装，暂无命令行安装方式"

- [ ] **Step 5: 保留历史验证记录（已移除 Agent 不再验证）**

```bash
curl -s http://127.0.0.1:4876/api/agents/status | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  console.log('已移除 Agent methods:', JSON.stringify(j.agents.removed && j.agents.removed.install));
});"
```
Expected: 已移除 Agent 不出现在 `j.agents` 中。

- [ ] **Step 6: curl 确认 /app.js 里新代码确实在服务**

```bash
curl -s http://127.0.0.1:4876/app.js | grep -c "下载安装"
```
Expected: 输出大于 0 的数字

---

## 完成后

这份计划跑完，agent-board 的应用管理弹窗能：
- 给 workbuddy / zcode 显示"安装"按钮，点击后走 winget 静默安装（和 cli 引擎一样的确认 + 进度流程）
- 给 marvis 显示"下载安装"按钮，点击后直接打开 `https://marvis.qq.com/`，不追踪进度，提示用户装完自己刷新弹窗
- 已移除的 Agent 不出现安装按钮

**没做的**（如果以后要做）：
- 真实点击验证（这台机器上 4 个 gui 工具全部已安装，没有安全的伪造未安装状态的办法）
- ~~workbuddy/zcode 的 `network.testUrls` 里仍然是旧的 `codebuddy.cn`~~ —— 2026-08-23 已顺手修正：`workbuddy.js` 的 `testUrls` 改成 `https://www.workbuddy.cn`（zcode 本来就是对的，没改）。核实过 `testUrls` 目前全仓库没有任何地方真正读取消费（只在各 adapter 里声明），纯粹是数据一致性修正，不涉及行为改变。
- 探测结果缓存、瀑布流列联动（沿用上一轮就已经明确延后的范围）
