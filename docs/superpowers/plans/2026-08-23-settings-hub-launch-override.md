# 集中设置面板 + 模型端口设置 + pi 跳转 bug 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工具栏"瀑布流设置"图标改造成通用设置入口（点开是分类面板）；修复 pi 跳转按钮会弹出残留 `findstr.exe` 窗口的 bug（根因：批处理管道 + `windowsHide` 组合触发 Windows 给子进程分配新控制台）；新增"模型端口设置"，允许用户给任意 agent 配置自定义跳转启动命令，覆盖内置默认方式。

**Architecture:** 新建 `lib/launch.js`（启动覆盖表读写 + TCP 端口探测，和 `lib/detect.js` 的 `loadUserOverrides` 是同一套"机器级配置、容错读写"思路，但功能不同、故意不合并）。`server.js` 的 `launchOrFocus()` 加一层"有覆盖配置就直接跑覆盖命令"的前置分支，pi 的默认路径从依赖 `pi-launch.bat` 改成 Node 原生端口探测+启动。顶栏/会话卡片/抽屉三个"跳转"入口都走同一个 `launchOrFocus()`，改一处三处生效。

**Tech Stack:** Node.js 内置 `net`/`child_process`/`fs`，无第三方依赖；前端原生 JS。

设计文档：[2026-08-23-settings-hub-launch-override-design.md](../specs/2026-08-23-settings-hub-launch-override-design.md)

---

### Task 1: `lib/launch.js` —— 启动覆盖表读写

**Files:**
- Create: `lib/launch.js`
- Test: Create `lib/launch.test.js`

- [ ] **Step 1: 写失败测试**

创建 `lib/launch.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLaunchOverrides, saveLaunchOverride } = require('./launch');

test('loadLaunchOverrides 文件不存在返回空对象', () => {
  const p = path.join(os.tmpdir(), 'ab-launch-missing-' + Date.now() + '.json');
  assert.deepEqual(loadLaunchOverrides(p), {});
});

test('loadLaunchOverrides 坏 JSON 不崩溃，返回空对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.deepEqual(loadLaunchOverrides(p), {});
});

test('loadLaunchOverrides 顶层是 JSON 数组时返回空对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, JSON.stringify(['x', 'y']));
  assert.deepEqual(loadLaunchOverrides(p), {});
});

test('loadLaunchOverrides 过滤掉非字符串/空字符串的值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, JSON.stringify({ pi: 'real-cmd', codex: 123, claude: '   ', workbuddy: null }));
  assert.deepEqual(loadLaunchOverrides(p), { pi: 'real-cmd' });
});

test('saveLaunchOverride 写入新 key，目录不存在会自动创建', () => {
  const dir = path.join(os.tmpdir(), 'ab-launch-new-' + Date.now());
  const p = path.join(dir, 'sub', 'launch-overrides.json');
  const out = saveLaunchOverride('pi', 'my-launcher.exe', p);
  assert.deepEqual(out, { pi: 'my-launcher.exe' });
  assert.deepEqual(loadLaunchOverrides(p), { pi: 'my-launcher.exe' });
});

test('saveLaunchOverride 空字符串清除已有 key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  saveLaunchOverride('pi', 'cmd-a', p);
  const out = saveLaunchOverride('pi', '', p);
  assert.deepEqual(out, {});
  assert.deepEqual(loadLaunchOverrides(p), {});
});

test('saveLaunchOverride 保留其他 agent 的已有配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  saveLaunchOverride('pi', 'cmd-a', p);
  saveLaunchOverride('codex', 'cmd-b', p);
  assert.deepEqual(loadLaunchOverrides(p), { pi: 'cmd-a', codex: 'cmd-b' });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test lib/launch.test.js`
Expected: 报错（`Cannot find module './launch'`），因为 `lib/launch.js` 还不存在

- [ ] **Step 3: 写最小实现**

创建 `lib/launch.js`：

```js
'use strict';
// 启动覆盖 + 端口探测：模型端口设置功能用（~/.agent-board/launch-overrides.json）。
// 和 lib/detect.js 的 loadUserOverrides（tool-paths.json）是同一套"机器级配置、容错读写"
// 思路，但两个文件功能不同（一个覆盖探测路径、一个覆盖启动命令），故意不合并成一个文件。
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const LAUNCH_OVERRIDES_PATH = path.join(os.homedir(), '.agent-board', 'launch-overrides.json');

// 读取启动覆盖表：文件不存在/JSON 解析失败/字段类型不对，一律降级成空对象，绝不能让跳转流程崩溃
function loadLaunchOverrides(filePath = LAUNCH_OVERRIDES_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// 保存一个 agent 的启动覆盖；command 为空/空白字符串 = 清除该 agent 的覆盖。返回保存后的完整表。
function saveLaunchOverride(agent, command, filePath = LAUNCH_OVERRIDES_PATH) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cur = loadLaunchOverrides(filePath);
  if (command && command.trim()) cur[agent] = command.trim();
  else delete cur[agent];
  fs.writeFileSync(filePath, JSON.stringify(cur, null, 2));
  return cur;
}

module.exports = { LAUNCH_OVERRIDES_PATH, loadLaunchOverrides, saveLaunchOverride };
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test lib/launch.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 跑一遍完整测试套件**

Run: `node --test`
Expected: 全部 PASS，0 失败（57 + 新增的 7 个）

- [ ] **Step 6: 提交**

```bash
git add lib/launch.js lib/launch.test.js
git commit -m "feat: 新增 lib/launch.js —— 启动命令覆盖表读写（模型端口设置的存储层）"
```

---

### Task 2: `lib/launch.js` —— TCP 端口探测

**Files:**
- Modify: `lib/launch.js`
- Test: Modify `lib/launch.test.js`（追加）

- [ ] **Step 1: 写失败测试**

在 `lib/launch.test.js` 文件末尾追加：

```js
const { probePort, waitForPort } = require('./launch');

test('probePort 探测到真实监听中的端口返回 true', async () => {
  const net = require('net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await probePort(port), true);
  } finally {
    server.close();
  }
});

test('probePort 探测未监听的端口返回 false', async () => {
  // 55555 端口：随便挑一个这台测试机极不可能被占用的高位端口
  assert.equal(await probePort(55555), false);
});

test('waitForPort 端口已经监听时立即返回 true（不用等）', async () => {
  const ok = await waitForPort(1234, '127.0.0.1', { intervalMs: 10, timeoutMs: 200, probeFn: async () => true });
  assert.equal(ok, true);
});

test('waitForPort 轮询几次后探测到监听，返回 true', async () => {
  let calls = 0;
  const probeFn = async () => { calls++; return calls >= 3; };
  const ok = await waitForPort(1234, '127.0.0.1', { intervalMs: 10, timeoutMs: 500, probeFn });
  assert.equal(ok, true);
  assert.ok(calls >= 3);
});

test('waitForPort 一直探测不到，超时后返回 false', async () => {
  const ok = await waitForPort(1234, '127.0.0.1', { intervalMs: 10, timeoutMs: 50, probeFn: async () => false });
  assert.equal(ok, false);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test lib/launch.test.js`
Expected: 新增的 5 个测试报错（`probePort`/`waitForPort` 不是函数），因为还没实现

- [ ] **Step 3: 写最小实现**

在 `lib/launch.js` 里，`saveLaunchOverride` 函数后面（`module.exports` 之前）加：

```js
// TCP 探测某端口是否已经有服务在监听。timeoutMs 内探测不到（连接超时/被拒绝）都算「没监听」，
// 不抛异常——探测失败本身就是一个正常、常见的结果，不是错误。
function probePort(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// 轮询探测端口，直到监听到或超时。opts.probeFn 可注入（测试用，同 lib/detect.js 的依赖注入模式），
// 默认是真实的 probePort。
function waitForPort(port, host = '127.0.0.1', opts = {}) {
  const intervalMs = opts.intervalMs || 500;
  const timeoutMs = opts.timeoutMs || 8000;
  const probe = opts.probeFn || probePort;
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      if (await probe(port, host)) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
```

并把 `module.exports` 改成：

```js
module.exports = { LAUNCH_OVERRIDES_PATH, loadLaunchOverrides, saveLaunchOverride, probePort, waitForPort };
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test lib/launch.test.js`
Expected: 全部 PASS（12 个）

- [ ] **Step 5: 跑一遍完整测试套件**

Run: `node --test`
Expected: 全部 PASS，0 失败

- [ ] **Step 6: 提交**

```bash
git add lib/launch.js lib/launch.test.js
git commit -m "feat: lib/launch.js 加 TCP 端口探测（probePort/waitForPort），给 pi 跳转 bug 修复用"
```

---

### Task 3: server.js —— 接入启动覆盖 + 修复 pi 跳转的默认路径

**Files:**
- Modify: `server.js`（`require` 区，约第 9 行；`AGENT_DEFS.pi`，约第 37-38 行；`launchOrFocus`，约第 49-80 行）
- Delete: `pi-launch.bat`

- [ ] **Step 1: 引入 lib/launch**

找到：

```js
const detect = require('./lib/detect');
```

在它后面加一行：

```js
const detect = require('./lib/detect');
const launchLib = require('./lib/launch');
```

（只加这一行，`detect` 这行本身不动，这里贴出来是为了标注插入位置）

- [ ] **Step 2: 修改 AGENT_DEFS 里 pi 的配置**

找到：

```js
  pi:        { name: 'Pi Agent',         color: '#01BEBF', icon: 'pi.png',        proc: 'pi',        scheme: null,            launch: null,
    launchCmd: '"C:\\Users\\Administrator\\WorkBuddy\\2026-08-20-03-52-10\\agent-board\\pi-launch.bat"' },
```

改成：

```js
  pi:        { name: 'Pi Agent',         color: '#01BEBF', icon: 'pi.png',        proc: 'pi',        scheme: null,            launch: null,
    webUi: { url: 'http://127.0.0.1:3210', port: 3210, startCmd: '"D:\\Program Files\\node-v22.14.0-win-x64\\node_global\\pi-web-ui.cmd"' } },
```

- [ ] **Step 3: 修改 launchOrFocus，加覆盖分支 + pi 的 webUi 分支**

找到：

```js
// 窗口激活：未运行 -> 按 scheme/launch 启动；运行中 -> 激活到前台
function launchOrFocus(agent, cb) {
  const def = AGENT_DEFS[agent];
  if (!def) { cb({ ok: false, error: '未知 agent' }); return; }
  // launchCmd 用于浏览器/Web 类应用：直接调用外部启动脚本（含自启动+开浏览器逻辑），不再走窗口句柄激活
  if (def.launchCmd) {
    const p = stripQuotes(def.launchCmd);
    spawn('cmd.exe', ['/c', p], { windowsHide: true, detached: true }).unref();
    cb({ ok: true, action: 'launch', agent });
    return;
  }
  focusAppCall(def.proc, (result) => {
```

改成：

```js
// 窗口激活：未运行 -> 按 scheme/launch 启动；运行中 -> 激活到前台
function launchOrFocus(agent, cb) {
  const def = AGENT_DEFS[agent];
  if (!def) { cb({ ok: false, error: '未知 agent' }); return; }

  // 模型端口设置：用户配置了自定义启动命令，直接跑这条命令，不走下面任何默认逻辑。
  // 不做"是否已运行"检测——覆盖命令是用户自己指定的任意程序，没法通用地判断它是否已经在跑，
  // 交给用户自己选的程序/脚本自己处理，这里只负责"跑一下"。
  const override = launchLib.loadLaunchOverrides()[agent];
  if (override) {
    spawn('cmd.exe', ['/c', override], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    cb({ ok: true, action: 'launch-override', agent });
    return;
  }

  // pi 的 Web UI：TCP 探测端口 → 没监听就拉起 → 轮询等它起来 → 开浏览器。
  // stdio 显式设成 'ignore'（不走管道）是修掉 Windows 给子进程分配残留控制台窗口的关键——
  // 原来 pi-launch.bat 用 netstat|findstr 管道检测端口时，windowsHide+管道 stdio 的组合会
  // 触发 Windows 给 netstat/findstr 这些子进程各自分配一个新控制台窗口（就是用户截图里那两个
  // 残留的 findstr.exe 窗口），这里改成 Node 原生探测，不再有管道，就不会再触发这个问题。
  if (def.webUi) {
    const { url, port, startCmd } = def.webUi;
    (async () => {
      let up = await launchLib.probePort(port);
      if (!up) {
        spawn('cmd.exe', ['/c', startCmd], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
        up = await launchLib.waitForPort(port);
      }
      spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      cb({ ok: true, action: up ? 'launch' : 'launch-timeout', agent });
    })();
    return;
  }

  // launchCmd 用于浏览器/Web 类应用：直接调用外部启动脚本（含自启动+开浏览器逻辑），不再走窗口句柄激活
  if (def.launchCmd) {
    const p = stripQuotes(def.launchCmd);
    spawn('cmd.exe', ['/c', p], { windowsHide: true, detached: true }).unref();
    cb({ ok: true, action: 'launch', agent });
    return;
  }
  focusAppCall(def.proc, (result) => {
```

（`focusAppCall(def.proc, (result) => {` 这一行和它后面的代码完全不动，只是作为定位锚点贴出来）

- [ ] **Step 4: 删除不再被引用的 pi-launch.bat**

```bash
git rm pi-launch.bat
```

- [ ] **Step 5: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('server.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`

- [ ] **Step 6: 跑一遍完整测试套件**

Run: `node --test`
Expected: 全部 PASS，0 失败

- [ ] **Step 7: 提交**

```bash
git add server.js
git commit -m "fix: pi 默认跳转改用 Node 原生端口探测+启动，修掉 findstr 残留窗口的 bug；接入模型端口覆盖"
```

（`pi-launch.bat` 的删除已经在 Step 4 里 `git rm` 暂存过，这次提交会一起带上）

---

### Task 4: server.js —— 模型端口设置的读写 API

**Files:**
- Modify: `server.js`（`POST /api/launch-agent` 路由后面，约第 446 行）

- [ ] **Step 1: 新增两个路由**

找到：

```js
  // 顶栏/跳转：未运行则启动，运行中则激活窗口
  if (pathname === '/api/launch-agent' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agent = String(body.agent || '');
      if (!AGENT_DEFS[agent]) throw new Error('未知 agent: ' + agent);
      launchOrFocus(agent, (r) => {
        console.log(`[launch-agent] ${agent} ->`, JSON.stringify(r));
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
```

在它后面（下一个路由之前）插入：

```js

  // 模型端口设置：读取当前的启动命令覆盖表
  if (pathname === '/api/launch-overrides' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ overrides: launchLib.loadLaunchOverrides() }));
    return;
  }

  // 模型端口设置：保存/清除某个 agent 的启动命令覆盖
  if (pathname === '/api/launch-overrides' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agent = String(body.agent || '');
      if (!AGENT_DEFS[agent]) throw new Error('未知 agent: ' + agent);
      const overrides = launchLib.saveLaunchOverride(agent, body.command || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, overrides }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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
git commit -m "feat: 新增 GET/POST /api/launch-overrides —— 模型端口设置的读写接口"
```

---

### Task 5: 前端 —— 设置入口改造 + 分类面板

**Files:**
- Modify: `public/index.html`（`btn-cols` 按钮，约第 325-327 行）
- Modify: `public/app.js`（`#btn-cols` 相关的两处引用；新增 `openSettingsHub()`）

- [ ] **Step 1: index.html 里的图标+id 改造**

找到：

```html
    <button class="icon-btn" id="btn-cols" title="管理瀑布流列（显示/隐藏/排序）">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
    </button>
```

改成：

```html
    <button class="icon-btn" id="btn-settings-hub" title="设置">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
```

- [ ] **Step 2: app.js 里更新两处 `#btn-cols` 引用**

找到（全局点击外部关闭弹窗的排除列表）：

```js
  if (state.popoverFor && !e.target.closest('.popover') && !e.target.closest('.s-more') && !e.target.closest('#btn-hidden') && !e.target.closest('#btn-cols') && !e.target.closest('#btn-agents')) closePopover();
```

改成：

```js
  if (state.popoverFor && !e.target.closest('.popover') && !e.target.closest('.s-more') && !e.target.closest('#btn-hidden') && !e.target.closest('#btn-settings-hub') && !e.target.closest('#btn-agents')) closePopover();
```

找到：

```js
$('btn-cols').onclick = openColManager;
```

改成：

```js
$('btn-settings-hub').onclick = openSettingsHub;
```

- [ ] **Step 3: 新增 `openSettingsHub()`**

在 `openColManager` 函数定义之前（`/* ---------- 瀑布流列管理 ---------- */` 这行注释之前）插入：

```js
/* ---------- 设置面板（集中入口） ---------- */
function openSettingsHub() {
  closePopover();
  state.popoverFor = 'settings';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '200px';
  document.body.appendChild(pop);
  pop.innerHTML = `<div class="pop-head">设置</div>
    <div style="padding:6px 8px;display:flex;flex-direction:column;gap:6px">
      <button class="pop-item" id="settings-cols">瀑布流设置</button>
      <button class="pop-item" id="settings-sound">提示音设置</button>
      <button class="pop-item" id="settings-skin">皮肤设置</button>
      <button class="pop-item" id="settings-launch">模型端口设置</button>
    </div>`;
  pop.querySelector('#settings-cols').onclick = openColManager;
  // 提示音设置这轮先占位，下一轮（完成会话提示音功能）会把这行换成真实的 openSoundSettings
  pop.querySelector('#settings-sound').onclick = () => toast('敬请期待');
  pop.querySelector('#settings-skin').onclick = () => toast('敬请期待');
  pop.querySelector('#settings-launch').onclick = openLaunchOverridesManager;
}

```

- [ ] **Step 4: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('public/app.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`（这一步会因为 `openColManager`/`openLaunchOverridesManager` 引用还没实现而在语法层面没问题——JS 函数引用只在真正调用时才需要存在，`openLaunchOverridesManager` 要等 Task 6 才定义，这里只是语法检查，不是运行时调用，不会报错）

- [ ] **Step 5: 跑一遍完整测试套件**

Run: `node --test`
Expected: 全部 PASS，0 失败（这个任务不涉及 `lib/` 下任何文件）

- [ ] **Step 6: 提交**

```bash
git add public/index.html public/app.js
git commit -m "feat: 设置入口改造——瀑布流设置图标换成通用设置面板，含分类入口"
```

---

### Task 6: 前端 —— 模型端口设置弹窗

**Files:**
- Modify: `public/app.js`（在 `openSettingsHub()` 后面新增 `openLaunchOverridesManager()`）

- [ ] **Step 1: 新增模型端口设置弹窗**

在 Task 5 新增的 `openSettingsHub()` 函数后面（紧接着，`/* ---------- 瀑布流列管理 ---------- */` 这行注释之前）插入：

```js
// 每个 agent 默认走什么跳转方式的说明文字，纯展示用，不需要精确到底层字段名
const LAUNCH_DEFAULT_HINT = {
  claude: '默认：claude:// 协议跳转', codex: '默认：codex:// 协议跳转',
  workbuddy: '默认：workbuddy:// 协议跳转', deepseek: '默认：命令行工具直接跳转',
  marvis: '默认：启动脚本拉起',
  zcode: '默认：启动脚本拉起', pi: '默认：命令行工具直接跳转',
};

/* ---------- 模型端口设置（自定义跳转启动命令） ---------- */
async function openLaunchOverridesManager() {
  closePopover();
  state.popoverFor = 'launch-overrides';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '420px';
  pop.style.maxWidth = '520px';
  document.body.appendChild(pop);
  pop.innerHTML = '<div class="pop-head">模型端口设置</div><div style="padding:16px;color:var(--text3);font-size:13px">加载中…</div>';

  let overrides = {};
  try {
    const r = await fetch('/api/launch-overrides');
    const d = await r.json();
    overrides = d.overrides || {};
  } catch { /* 拿不到就当空表，用户依然能填新的 */ }

  const defs = state.agentsDef || {};
  let html = `<div class="pop-head">模型端口设置 <span style="opacity:.5;font-weight:400">（自定义跳转启动命令，留空用默认）</span></div>
    <div style="padding:10px;max-height:60vh;overflow-y:auto">`;
  for (const id of Object.keys(defs)) {
    const meta = defs[id];
    html += `<div class="lo-row" data-id="${esc(id)}" style="margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;margin-bottom:2px">${esc(meta.name || id)}</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:4px">${esc(LAUNCH_DEFAULT_HINT[id] || '默认：内置方式')}</div>
      <input class="lo-input" type="text" placeholder="留空使用默认，填了则改用这条命令跳转" value="${esc(overrides[id] || '')}"
        style="width:100%;box-sizing:border-box;padding:6px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px">
    </div>`;
  }
  html += '</div>';
  pop.innerHTML = html;

  pop.querySelectorAll('.lo-input').forEach((input) => {
    input.addEventListener('blur', async () => {
      const id = input.closest('.lo-row').dataset.id;
      const command = input.value;
      try {
        const r = await fetch('/api/launch-overrides', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: id, command }),
        });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
        toast(command ? '已保存自定义启动命令' : '已恢复默认');
      } catch (e) {
        toast('保存失败：' + (e.message || '未知错误'));
      }
    });
  });
}

```

- [ ] **Step 2: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('public/app.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`

- [ ] **Step 3: 提交**

```bash
git add public/app.js
git commit -m "feat: 模型端口设置弹窗——每个 agent 可填自定义跳转启动命令，失焦自动保存"
```

---

### Task 7: 人工验证（真实点击测试，不做假设）

**Files:** 无代码改动，纯验证

- [ ] **Step 1: 跑全部单元测试**

Run: `node --test`
Expected: 全部 PASS，0 失败

- [ ] **Step 2: 重启 server.js 让新代码生效**

用 PowerShell 工具（不要用 Bash 工具的 `cmd.exe`，PATH 缺 `WindowsApps`）：
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent-board\server.js*' } | Select-Object ProcessId
```
只结束这一个（绝对不能碰看门狗进程）：
```powershell
Stop-Process -Id <上面记下的PID> -Force -Confirm:$false
```
等待约 70 秒，确认新进程已经起来且只有一个：
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent-board\server.js*' } | Select-Object ProcessId, CreationDate
```

- [ ] **Step 3: 真实验证 pi 跳转 bug 已修复**

浏览器打开 `http://127.0.0.1:4876`，点顶栏 pi 的快捷图标（或任意一张 pi 会话卡片的"跳转"按钮）。

Expected：
- **不再弹出任何 `findstr.exe`/`netstat.exe` 控制台窗口**（这是这次要修的核心问题）
- 浏览器打开或切换到 `http://127.0.0.1:3210`，显示 pi 的 Web UI 界面（不是空白页/连接失败）

如果这台机器上 pi 的 Web UI 服务本来就没在跑，第一次点击预期会有几秒延迟（等 `pi-web-ui.cmd` 启动+轮询探测），这是正常现象，不是 bug；第二次点击（服务已经在跑）应该几乎瞬间跳转。

- [ ] **Step 4: 验证新设置入口和面板正确显示**

点工具栏原来"瀑布流设置"位置的图标（现在应该是齿轮图标，`title` 是"设置"），确认：
- 弹出的面板有四个按钮：瀑布流设置、提示音设置、皮肤设置、模型端口设置
- 点"瀑布流设置" → 正确打开原来熟悉的那个列管理弹窗，功能和之前完全一样
- 点"皮肤设置"或"提示音设置" → 弹出"敬请期待"提示，不报错、不白屏
- 点"模型端口设置" → 打开设置弹窗，能看到 7 个 agent 各一行，每行有默认方式说明文字 + 一个空的输入框

- [ ] **Step 5: 真实验证模型端口覆盖生效**

在"模型端口设置"弹窗里，随便挑一个 agent（比如 marvis，用它的默认方式不太会被日常使用打断），输入框填一个能明确验证"确实被执行"的命令，比如：

```
notepad.exe
```

输入完点击输入框外任意位置（触发 `blur` 保存），确认弹出"已保存自定义启动命令"的 toast。然后点顶栏该 agent 的快捷图标（或该 agent 任意一张会话卡片的"跳转"按钮）。

Expected：真的弹出一个记事本窗口（证明覆盖命令被执行了，不是走的默认启动方式）。验证完毕后，回到模型端口设置弹窗，把这个输入框清空、触发 blur 保存，确认恢复默认（不留一个"点跳转会弹记事本"的坑给以后的自己或用户）。

- [ ] **Step 6: 确认没有留下垃圾进程**

```powershell
Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force
```
（Step 5 测试打开的记事本进程，关掉，不留驻留）

---

## 完成后

这份计划跑完，agent-board 能：
- 工具栏"瀑布流设置"图标变成通用"设置"入口，打开分类面板（瀑布流设置/提示音设置[占位]/皮肤设置[占位]/模型端口设置）
- pi 的默认跳转不再弹出残留的 `findstr.exe` 控制台窗口，正确打开 pi 的 Web UI
- 用户可以在"模型端口设置"里给任意一个 agent 配置自定义跳转启动命令，覆盖内置默认方式，顶栏图标/会话卡片跳转/抽屉跳转三个入口自动同步生效

**没做的**（下一轮："完成会话提示音"独立计划会补上）：
- "提示音设置"目前只是点了弹"敬请期待"的占位符，真实功能是下一份计划的范围
- "皮肤设置"这轮明确不做真实功能，只做占位符

