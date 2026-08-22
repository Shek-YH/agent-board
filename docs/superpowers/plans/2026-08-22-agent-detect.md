# Agent 探测引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent-board 能自动判断这台机器上装没装某个 AI Agent（Claude Code / Codex / Pi / DeepSeek Harness / WorkBuddy / ZCode / 豆包 / Marvis）、装在哪、版本号是多少，并在界面上一个新的"应用管理"入口里展示出来，替换掉现在硬编码在这台机器上的绝对路径。

**Architecture:** 新增 `lib/detect.js` 作为通用探测引擎（路径列表探测 / Windows 卸载注册表探测 / 用户自定义路径覆盖 / 版本号读取），不认识任何具体 agent，只消费每个 `lib/adapters/*.js` 里新增的 `detect` 静态配置对象。`server.js` 新增一个只读接口把探测结果吐给前端，`public/` 新增一个复用现有"列设置"弹窗视觉风格的"应用管理"弹窗展示状态。

**范围说明（重要）**：本计划只做**探测**，不做"点击安装"。对应设计文档 [2026-08-22-agent-detect-install-design.md](../specs/2026-08-22-agent-detect-install-design.md) 里 `detect` 配置的 `probe` 部分 + 展示层；`install`/`network`/`afterInstall` 三块数据本计划里会跟着 `probe` 一起写进每个 adapter（反正是静态数据，一次改完 8 个文件，不用两轮都碰），但**消费**这些数据的安装引擎、POST 安装接口、SSE 安装进度、卡片上的"安装"按钮，是下一份独立计划的范围，不在这里实现。跑完这份计划，用户能打开 agent-board、点一个新按钮，看到 8 个 agent 各自的真实安装状态——这本身就是可独立验证、有价值的成果。

**已发现的一处设计调整**：spec 撰写时假设"设置页"是一个已有页面，实地看代码后发现 agent-board 目前**没有独立设置页**，只有挂在工具栏上的弹窗（`btn-cols` 开瀑布流列设置、`btn-hidden` 开隐藏会话管理）。本计划遵循现有约定，新增一个同风格的工具栏按钮 `btn-agents` 打开"应用管理"弹窗，而不是新建一个页面级路由——视觉上仍然是 spec 里定的卡片网格布局，只是容器换成弹窗。

**Tech Stack:** Node.js 原生 `http`/`fs`/`child_process`（继续零 npm 依赖），测试用 Node 内置的 `node:test` + `node:assert`（Node 18+ 自带，不引入任何新依赖）。

---

## 涉及文件一览

| 文件 | 改动 |
|---|---|
| `package.json` | 新增 `test` 脚本 |
| `lib/detect.js` | 新建：探测引擎 |
| `lib/detect.test.js` | 新建：探测引擎的单元测试 |
| `lib/adapters/claude.js` | 新增 `detect` 导出 |
| `lib/adapters/codex.js` | 新增 `detect` 导出 |
| `lib/adapters/pi.js` | 新增 `detect` 导出 |
| `lib/adapters/deepseek.js` | 新增 `detect` 导出 |
| `lib/adapters/workbuddy.js` | 新增 `detect` 导出 |
| `lib/adapters/zcode.js` | 新增 `detect` 导出 |
| `lib/adapters/doubao.js` | 新增 `detect` 导出 |
| `lib/adapters/marvis.js` | 新增 `detect` 导出 |
| `server.js` | 新增 `GET /api/agents/status` 路由 |
| `public/index.html` | 新增 `btn-agents` 工具栏按钮 |
| `public/app.js` | 新增 `openAgentManager()` 弹窗 |

---

### Task 1: package.json 加 test 脚本

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 加 test 脚本**

把：
```json
  "scripts": {
    "start": "node server.js"
  },
```
改成：
```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test lib/"
  },
```

- [ ] **Step 2: 提交**

```bash
git add package.json
git commit -m "chore: 加 node --test 测试脚本（零依赖，Node 内置）"
```

---

### Task 2: detect.js —— 路径展开与路径列表探测

**Files:**
- Create: `lib/detect.js`
- Create: `lib/detect.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `lib/detect.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandPath, probePathList } = require('./detect');

test('expandPath 展开 %ENV_VAR%', () => {
  const out = expandPath('%FOO%\\bar.exe', { env: { FOO: 'C:\\Test' } });
  assert.equal(out, 'C:\\Test\\bar.exe');
});

test('expandPath 未定义的变量原样保留', () => {
  const out = expandPath('%NOT_SET%\\bar.exe', { env: {} });
  assert.equal(out, '%NOT_SET%\\bar.exe');
});

test('expandPath 展开开头的 ~', () => {
  const out = expandPath('~\\.foo\\bar.exe', { home: 'C:\\Users\\test' });
  assert.equal(out, path.join('C:\\Users\\test', '.foo', 'bar.exe'));
});

test('probePathList 返回第一个真实存在的路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const real = path.join(dir, 'real.exe');
  fs.writeFileSync(real, '');
  const hit = probePathList([path.join(dir, 'missing.exe'), real], {});
  assert.equal(hit, real);
});

test('probePathList 全不存在返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const hit = probePathList([path.join(dir, 'missing.exe')], {});
  assert.equal(hit, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test lib/detect.test.js`
Expected: FAIL（`Cannot find module './detect'`，因为 `lib/detect.js` 还不存在）

- [ ] **Step 3: 写最小实现**

创建 `lib/detect.js`：

```js
'use strict';
// Agent 探测引擎：判断某个 AI Agent 是否已安装、装在哪、版本号是多少。
// 只依赖 Node 内置模块，继续保持零 npm 依赖。
// 这轮只实现 Windows（win32）探测逻辑；probe.darwin/probe.linux 数据已经带上，留给以后跨平台用。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const USER_OVERRIDES_PATH = path.join(os.homedir(), '.agent-board', 'tool-paths.json');

// 展开路径模板里的 %ENV_VAR% 和开头的 ~
function expandPath(template, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  let s = String(template).replace(/%([^%]+)%/g, (m, name) => {
    const v = env[name];
    return v != null ? v : m;
  });
  if (s === '~') s = home;
  else if (s.startsWith('~\\') || s.startsWith('~/')) s = path.join(home, s.slice(2));
  return s;
}

// 给一批候选路径模板，返回第一个真实存在的（展开后）；都不存在返回 null
function probePathList(templates, opts = {}) {
  for (const t of templates || []) {
    const p = expandPath(t, opts);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = {
  expandPath, probePathList,
  USER_OVERRIDES_PATH,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test lib/detect.test.js`
Expected: PASS，5 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add lib/detect.js lib/detect.test.js
git commit -m "feat: 探测引擎——路径模板展开 + 路径列表探测"
```

---

### Task 3: detect.js —— Windows 卸载注册表探测

**Files:**
- Modify: `lib/detect.js`
- Modify: `lib/detect.test.js`

- [ ] **Step 1: 写失败的测试**

在 `lib/detect.test.js` 末尾追加：

```js
const { queryUninstallEntries, probeRegistryApp } = require('./detect');

test('queryUninstallEntries 解析 reg query /s 输出', () => {
  const fakeStdout = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCode',
    '    DisplayName    REG_SZ    ZCode',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other',
    '    DisplayName    REG_SZ    Some Other App',
    '',
  ].join('\r\n');
  const fakeRunReg = () => ({ status: 0, stdout: fakeStdout });
  const entries = queryUninstallEntries('HKCU\\...', fakeRunReg);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].displayName, 'ZCode');
  assert.equal(entries[1].displayName, 'Some Other App');
});

test('probeRegistryApp 按前缀匹配命中', () => {
  const fakeStdout = [
    'HKEY_CURRENT_USER\\...\\Uninstall\\ZCode',
    '    DisplayName    REG_SZ    ZCode',
    '',
  ].join('\r\n');
  const fakeRunReg = () => ({ status: 0, stdout: fakeStdout });
  const r = probeRegistryApp(['ZCode'], fakeRunReg);
  assert.equal(r.found, true);
  assert.equal(r.displayName, 'ZCode');
});

test('probeRegistryApp 查不到返回 found:false', () => {
  const fakeRunReg = () => ({ status: 0, stdout: '' });
  const r = probeRegistryApp(['NotInstalledApp'], fakeRunReg);
  assert.equal(r.found, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test lib/detect.test.js`
Expected: FAIL（`queryUninstallEntries is not a function`）

- [ ] **Step 3: 写最小实现**

在 `lib/detect.js` 里，`probePathList` 函数后面加：

```js
function defaultRunReg(args) {
  try {
    return spawnSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const UNINSTALL_HIVES = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// 一次 `reg query <hive> /s /v DisplayName` 拿到该 hive 下所有子键的 DisplayName，
// 避免对每个子键单独 spawn reg.exe（几十上百个子键逐个查会很慢）
function queryUninstallEntries(hive, runReg = defaultRunReg) {
  const r = runReg(['query', hive, '/s', '/v', 'DisplayName']);
  if (!r || r.status !== 0) return [];
  const entries = [];
  let currentKey = '';
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) { currentKey = line.trim(); continue; }
    const m = line.match(/^\s+DisplayName\s+REG_SZ\s+(.+)$/);
    if (m && currentKey) entries.push({ key: currentKey, displayName: m[1].trim() });
  }
  return entries;
}

// 在 Windows 卸载注册表里查找 DisplayName 以给定前缀开头的应用（用户级 + 系统级 + 32 位兼容位置都查）
function probeRegistryApp(displayNamePrefixes, runReg = defaultRunReg) {
  for (const hive of UNINSTALL_HIVES) {
    for (const e of queryUninstallEntries(hive, runReg)) {
      if ((displayNamePrefixes || []).some((p) => e.displayName.startsWith(p))) {
        return { found: true, displayName: e.displayName, key: e.key };
      }
    }
  }
  return { found: false };
}
```

再把文件末尾的 `module.exports` 改成：

```js
module.exports = {
  expandPath, probePathList, queryUninstallEntries, probeRegistryApp,
  USER_OVERRIDES_PATH,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test lib/detect.test.js`
Expected: PASS，8 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add lib/detect.js lib/detect.test.js
git commit -m "feat: 探测引擎——Windows 卸载注册表探测（GUI 应用用）"
```

---

### Task 4: detect.js —— 用户自定义路径覆盖

**Files:**
- Modify: `lib/detect.js`
- Modify: `lib/detect.test.js`

- [ ] **Step 1: 写失败的测试**

在 `lib/detect.test.js` 末尾追加：

```js
const { loadUserOverrides } = require('./detect');

test('loadUserOverrides 文件不存在返回空对象', () => {
  const p = path.join(os.tmpdir(), 'ab-detect-missing-' + Date.now() + '.json');
  assert.deepEqual(loadUserOverrides(p), {});
});

test('loadUserOverrides 解析数组和单字符串两种写法', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const p = path.join(dir, 'tool-paths.json');
  fs.writeFileSync(p, JSON.stringify({ pi: ['D:\\Tools\\pi.exe'], codex: 'D:\\Tools\\codex.exe' }));
  const out = loadUserOverrides(p);
  assert.deepEqual(out.pi, ['D:\\Tools\\pi.exe']);
  assert.deepEqual(out.codex, ['D:\\Tools\\codex.exe']);
});

test('loadUserOverrides 坏 JSON 不崩溃，返回空对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const p = path.join(dir, 'tool-paths.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.deepEqual(loadUserOverrides(p), {});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test lib/detect.test.js`
Expected: FAIL（`loadUserOverrides is not a function`）

- [ ] **Step 3: 写最小实现**

在 `lib/detect.js` 里 `probeRegistryApp` 函数后面加：

```js
// 读用户自定义路径覆盖：~/.agent-board/tool-paths.json。容错——文件不存在/JSON 解析失败/
// 字段类型不对，一律降级成空对象，绝不能让探测流程崩溃
function loadUserOverrides(filePath = USER_OVERRIDES_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[id] = [v];
      else if (Array.isArray(v)) out[id] = v.filter((x) => typeof x === 'string');
    }
    return out;
  } catch {
    return {};
  }
}
```

再把 `module.exports` 改成：

```js
module.exports = {
  expandPath, probePathList, queryUninstallEntries, probeRegistryApp,
  loadUserOverrides, USER_OVERRIDES_PATH,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test lib/detect.test.js`
Expected: PASS，11 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add lib/detect.js lib/detect.test.js
git commit -m "feat: 探测引擎——用户自定义路径覆盖 ~/.agent-board/tool-paths.json"
```

---

### Task 5: detect.js —— probeAgent / probeAll（整合探测 + 版本号）

**Files:**
- Modify: `lib/detect.js`
- Modify: `lib/detect.test.js`

- [ ] **Step 1: 写失败的测试**

在 `lib/detect.test.js` 末尾追加：

```js
const { probeAgent, probeAll } = require('./detect');

test('probeAgent 命中用户覆盖路径时 source=override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const overridePath = path.join(dir, 'pi.exe');
  fs.writeFileSync(overridePath, '');
  const adapter = { ID: 'pi', detect: { tier: 'cli', probe: { kind: 'path', win32: [] } } };
  const result = probeAgent(adapter, { userOverrides: { pi: [overridePath] } });
  assert.equal(result.installed, true);
  assert.equal(result.source, 'override');
  assert.equal(result.path, overridePath);
});

test('probeAgent 无覆盖、命中内置路径时 source=builtin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const builtinPath = path.join(dir, 'claude.exe');
  fs.writeFileSync(builtinPath, '');
  const adapter = { ID: 'claude', detect: { tier: 'cli', probe: { kind: 'path', win32: [builtinPath] } } };
  const result = probeAgent(adapter, { userOverrides: {} });
  assert.equal(result.installed, true);
  assert.equal(result.source, 'builtin');
});

test('probeAgent 都探测不到时 installed=false', () => {
  const adapter = { ID: 'claude', detect: { tier: 'cli', probe: { kind: 'path', win32: ['C:\\definitely\\not\\exist.exe'] } } };
  const result = probeAgent(adapter, { userOverrides: {} });
  assert.equal(result.installed, false);
});

test('probeAgent 没有 detect 配置时返回 tier:unknown', () => {
  const adapter = { ID: 'nodetect' };
  const result = probeAgent(adapter, {});
  assert.equal(result.tier, 'unknown');
  assert.equal(result.installed, false);
});

test('probeAgent registry 命中时也算已安装', () => {
  const fakeRunReg = () => ({ status: 0, stdout: 'HKEY_CURRENT_USER\\...\\ZCode\r\n    DisplayName    REG_SZ    ZCode\r\n' });
  const adapter = {
    ID: 'zcode',
    detect: {
      tier: 'gui',
      probe: { kind: 'registry', win32: ['C:\\not\\exist.exe'], registryHints: { displayNamePrefixes: ['ZCode'] } },
    },
  };
  const result = probeAgent(adapter, { userOverrides: {}, runReg: fakeRunReg });
  assert.equal(result.installed, true);
  assert.equal(result.registryName, 'ZCode');
});

test('probeAll 对多个 adapter 各自探测，按 ID 建 map', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const p1 = path.join(dir, 'a.exe'); fs.writeFileSync(p1, '');
  const adapters = [
    { ID: 'a', detect: { tier: 'cli', probe: { kind: 'path', win32: [p1] } } },
    { ID: 'b', detect: { tier: 'cli', probe: { kind: 'path', win32: ['C:\\not\\exist.exe'] } } },
  ];
  const result = await probeAll(adapters, { userOverrides: {} });
  assert.equal(result.a.installed, true);
  assert.equal(result.b.installed, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test lib/detect.test.js`
Expected: FAIL（`probeAgent is not a function`）

- [ ] **Step 3: 写最小实现**

在 `lib/detect.js` 里 `loadUserOverrides` 函数后面加：

```js
// 装了之后想拿版本号：跑 verify.cmd（如 "pi --version"），取第一行输出。
// 走 cmd.exe /c 而不是直接 spawnSync(bin, args)：npm 全局安装的 CLI 在 Windows 上很多是
// .cmd shim，直接 spawn 不经过 cmd.exe 解释会找不到（跟 server.js 里 launchOrFocus 的做法一致）。
function tryVersion(cmd) {
  if (!cmd) return '';
  try {
    const r = spawnSync('cmd.exe', ['/c', cmd], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (r.error || r.status !== 0) return '';
    return String(r.stdout || r.stderr || '').split('\n')[0].trim();
  } catch {
    return '';
  }
}

// 探测单个 agent：adapter 必须有 ID 和 detect 两个字段（detect 结构见 lib/adapters/*.js）
function probeAgent(adapter, opts = {}) {
  const def = adapter.detect;
  const id = adapter.ID;
  if (!def) return { id, installed: false, tier: 'unknown', reason: 'no detect config' };

  const overrides = opts.userOverrides || loadUserOverrides();
  const runReg = opts.runReg || defaultRunReg;
  const verifyCmd = def.verify && def.verify.cmd;

  // 1. 用户自定义路径覆盖优先于内置探测
  const overridePaths = overrides[id];
  if (overridePaths && overridePaths.length) {
    const hit = probePathList(overridePaths, opts);
    if (hit) {
      return { id, tier: def.tier, installed: true, path: hit, source: 'override', version: tryVersion(verifyCmd) };
    }
  }

  // 2. 内置路径列表（这轮只实现 win32）
  const platformPaths = (def.probe && def.probe.win32) || [];
  const pathHit = probePathList(platformPaths, opts);

  // 3. registry 探测（只有 kind:'registry' 且带 registryHints 才做）
  let regHit = null;
  if (def.probe && def.probe.kind === 'registry' && def.probe.registryHints) {
    const prefixes = def.probe.registryHints.displayNamePrefixes || [];
    if (prefixes.length) {
      const r = probeRegistryApp(prefixes, runReg);
      if (r.found) regHit = r;
    }
  }

  if (pathHit || regHit) {
    return {
      id, tier: def.tier, installed: true,
      path: pathHit || null,
      registryName: regHit ? regHit.displayName : null,
      source: 'builtin',
      version: tryVersion(verifyCmd),
    };
  }

  return { id, tier: def.tier, installed: false };
}

// 依次探测一批 adapter，返回按 ID 建的 map。probeAgent 内部是同步 spawnSync，这里包一层
// async 只是为了配合 server.js 路由的 await 写法，8 个 agent 量级下顺序执行完全够用。
async function probeAll(adapters, opts = {}) {
  const overrides = opts.userOverrides || loadUserOverrides();
  const out = {};
  for (const a of adapters) {
    if (!a.detect) continue;
    out[a.ID] = probeAgent(a, { ...opts, userOverrides: overrides });
  }
  return out;
}
```

再把 `module.exports` 改成：

```js
module.exports = {
  expandPath, probePathList, queryUninstallEntries, probeRegistryApp,
  loadUserOverrides, tryVersion, probeAgent, probeAll,
  USER_OVERRIDES_PATH,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test lib/detect.test.js`
Expected: PASS，17 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add lib/detect.js lib/detect.test.js
git commit -m "feat: 探测引擎——probeAgent/probeAll 整合探测与版本号读取"
```

---

### Task 6: claude.js 加 detect 配置

**Files:**
- Modify: `lib/adapters/claude.js:83` （`module.exports = {` 那一行前面插入）

- [ ] **Step 1: 加 detect 导出**

在 `lib/adapters/claude.js` 的 `module.exports = {` 那一行（第 83 行）之前插入：

```js
// 探测/安装配置（agent-board 设置页"应用管理"用）。命令取自 EchoBird 官方安装定义
// docs/api/tools/install/claudecode.json，路径列表取自其 tools/claudecode/paths.json。
const detect = {
  tier: 'cli',
  identityGuard: {
    description: 'Claude Code 是 Anthropic 官方的命令行 coding agent',
    notToConfuseWith: ['Claude Desktop（图形界面版）', 'Claude.ai 网页版'],
  },
  requirements: {},
  probe: {
    kind: 'path',
    win32: [
      '%USERPROFILE%\\.local\\bin\\claude.exe',
      '%APPDATA%\\npm\\claude.cmd',
      '%USERPROFILE%\\.bun\\bin\\claude.exe',
      '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\claude.exe',
      '%LOCALAPPDATA%\\pnpm\\claude.exe',
    ],
    darwin: [
      '/usr/local/bin/claude', '/opt/homebrew/bin/claude', '~/.local/bin/claude',
      '~/.bun/bin/claude', '~/.npm-global/bin/claude', '~/Library/pnpm/claude',
    ],
    linux: [
      '/usr/local/bin/claude', '/usr/bin/claude', '~/.local/bin/claude',
      '~/.bun/bin/claude', '~/.npm-global/bin/claude', '~/.local/share/pnpm/claude',
    ],
  },
  install: {
    methods: [
      { kind: 'script', posix: 'curl -fsSL https://claude.ai/install.sh | bash' },
      { kind: 'script', win32: 'irm https://claude.ai/install.ps1 | iex' },
      { kind: 'winget', id: 'Anthropic.ClaudeCode' },
      { kind: 'npm', pkg: '@anthropic-ai/claude-code' },
    ],
    warning: '官方原生安装器（curl/winget/powershell）优先于 npm：能自动更新，装的是期望的构建版本',
  },
  network: {
    testUrls: ['https://claude.ai', 'https://github.com/anthropics/claude-code'],
    mirrors: {},
    blockedRegions: {
      'zh-CN': 'Claude Code 需要直连 claude.ai，中国大陆访问被墙，没有镜像替代方案，没有代理/VPN 基本无法安装成功',
    },
  },
  verify: { cmd: 'claude --version' },
  afterInstall: {
    tellUser: ['用的是哪种安装方式（原生安装器/winget/npm）', '首次使用需要在终端里自己完成登录/onboarding，agent-board 不会替你自动跳过'],
  },
};

```

然后把原来的：
```js
module.exports = {
  ID, ROOT, isSessionFile, parseLines, fileToSessionId,
```
改成：
```js
module.exports = {
  ID, ROOT, isSessionFile, parseLines, fileToSessionId, detect,
```

- [ ] **Step 2: 用 Node 直接加载确认没有语法错误**

Run: `node -e "console.log(require('./lib/adapters/claude').detect.tier)"`
Expected: 输出 `cli`

- [ ] **Step 3: 提交**

```bash
git add lib/adapters/claude.js
git commit -m "feat(claude): 新增 detect 探测/安装配置"
```

---

### Task 7: codex.js 加 detect 配置

**Files:**
- Modify: `lib/adapters/codex.js:117` （`module.exports = {` 那一行前面插入）

- [ ] **Step 1: 加 detect 导出**

在 `lib/adapters/codex.js` 的 `module.exports = {` 那一行（第 117 行）之前插入：

```js
// 探测/安装配置。命令取自 EchoBird 官方安装定义 docs/api/tools/install/codex.json，
// 路径列表取自其 tools/codex/paths.json。
const detect = {
  tier: 'cli',
  identityGuard: {
    description: 'Codex CLI 是 OpenAI 官方的命令行 coding agent',
    notToConfuseWith: ['Claude Code（Anthropic，@anthropic-ai/claude-code）', 'OpenCode（Charm/Anomaly，opencode-ai）', 'GitHub Copilot（VS Code 插件）'],
  },
  requirements: { node: '>=22' },
  probe: {
    kind: 'path',
    win32: [
      '%APPDATA%\\npm\\codex.cmd',
      '%USERPROFILE%\\scoop\\shims\\codex.exe',
      '%USERPROFILE%\\.bun\\bin\\codex.exe',
      '%USERPROFILE%\\.local\\bin\\codex.exe',
      '%LOCALAPPDATA%\\pnpm\\codex.exe',
    ],
    darwin: [
      '/usr/local/bin/codex', '/opt/homebrew/bin/codex', '~/.bun/bin/codex',
      '~/.local/bin/codex', '~/.npm-global/bin/codex', '~/Library/pnpm/codex',
    ],
    linux: [
      '/usr/local/bin/codex', '/usr/bin/codex', '~/.bun/bin/codex',
      '~/.local/bin/codex', '~/.npm-global/bin/codex', '~/.local/share/pnpm/codex',
    ],
  },
  install: {
    methods: [
      { kind: 'npm', pkg: '@openai/codex' },
      { kind: 'script', posix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
      { kind: 'script', win32: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"' },
    ],
    warning: "npm 包名必须精确是 '@openai/codex'，不要单独装 'codex'（是另一个不相关的包）",
  },
  network: {
    testUrls: ['https://registry.npmjs.org/@openai/codex', 'https://github.com/openai/codex'],
    mirrors: { npm: 'https://registry.npmmirror.com' },
    blockedRegions: {},
  },
  verify: { cmd: 'codex --version' },
  afterInstall: {
    tellUser: ['Node.js 版本要求 >=22', 'Windows 上直接用 PowerShell 运行，不要通过 WSL'],
  },
};

```

然后把原来的：
```js
module.exports = {
  ID, ROOT, isSessionFile, parseLines, fileToSessionId: sessionIdFromPath,
```
改成：
```js
module.exports = {
  ID, ROOT, isSessionFile, parseLines, fileToSessionId: sessionIdFromPath, detect,
```

- [ ] **Step 2: 用 Node 直接加载确认没有语法错误**

Run: `node -e "console.log(require('./lib/adapters/codex').detect.tier)"`
Expected: 输出 `cli`

- [ ] **Step 3: 提交**

```bash
git add lib/adapters/codex.js
git commit -m "feat(codex): 新增 detect 探测/安装配置"
```

---

### Task 8: pi.js 加 detect 配置

**Files:**
- Modify: `lib/adapters/pi.js:73` （`module.exports = {` 那一行前面插入）

- [ ] **Step 1: 加 detect 导出**

在 `lib/adapters/pi.js` 的 `module.exports = {` 那一行（第 73 行）之前插入：

```js
// 探测/安装配置。命令取自 EchoBird 官方安装定义 docs/api/tools/install/pi.json，
// 路径列表取自其 tools/pi/paths.json。
const detect = {
  tier: 'cli',
  identityGuard: {
    description: 'Pi 指 Earendil Works 开发的开源 CLI coding agent（pi.dev）',
    notToConfuseWith: ['Pi Network（加密货币 App）', 'Inflection AI 的 Pi 助手', 'Raspberry Pi 相关工具'],
  },
  requirements: { node: '>=18' },
  probe: {
    kind: 'path',
    win32: [
      '%APPDATA%\\npm\\pi.cmd',
      '%USERPROFILE%\\.local\\bin\\pi.exe',
      '%USERPROFILE%\\.bun\\bin\\pi.exe',
      '%USERPROFILE%\\.hermes\\node\\bin\\pi.exe',
      '%USERPROFILE%\\.hermes\\node\\bin\\pi.cmd',
      '%LOCALAPPDATA%\\pnpm\\pi.exe',
    ],
    darwin: [
      '/usr/local/bin/pi', '/opt/homebrew/bin/pi', '~/.hermes/node/bin/pi',
      '~/.bun/bin/pi', '~/.local/bin/pi', '~/.npm-global/bin/pi', '~/Library/pnpm/pi',
    ],
    linux: [
      '/usr/local/bin/pi', '/usr/bin/pi', '~/.local/bin/pi', '~/.hermes/node/bin/pi',
      '~/.bun/bin/pi', '~/.npm-global/bin/pi', '~/.local/share/pnpm/pi',
    ],
  },
  install: {
    methods: [
      { kind: 'script', posix: 'curl -fsSL https://pi.dev/install.sh | sh' },
      { kind: 'npm', pkg: '@earendil-works/pi-coding-agent', flags: ['--ignore-scripts'] },
    ],
    warning: "npm 包名必须精确是 '@earendil-works/pi-coding-agent'，不要单独装 'pi'（那是个无关的 Python 工具包）",
  },
  network: {
    testUrls: ['https://pi.dev', 'https://registry.npmjs.org/@earendil-works/pi-coding-agent'],
    mirrors: { npm: 'https://registry.npmmirror.com' },
    blockedRegions: {},
  },
  verify: { cmd: 'pi --version' },
  afterInstall: {
    tellUser: ['用的是 curl 安装器还是 npm（Windows 走 npm，需要先有 Node.js ≥18）', '装完可能要点"刷新"或重启 agent-board 才能识别到新装的 pi'],
  },
};

```

然后把原来的：
```js
module.exports = {
  ID, ROOT, isSessionFile, parseLines, fileToSessionId,
```
改成：
```js
module.exports = {
  ID, ROOT, isSessionFile, parseLines, fileToSessionId, detect,
```

- [ ] **Step 2: 用 Node 直接加载确认没有语法错误**

Run: `node -e "console.log(require('./lib/adapters/pi').detect.tier)"`
Expected: 输出 `cli`

- [ ] **Step 3: 提交**

```bash
git add lib/adapters/pi.js
git commit -m "feat(pi): 新增 detect 探测/安装配置"
```

---

### Task 9: deepseek.js 加 detect 配置

**Files:**
- Modify: `lib/adapters/deepseek.js:159` （`module.exports = {` 那一行前面插入）

- [ ] **Step 1: 加 detect 导出**

在 `lib/adapters/deepseek.js` 的 `module.exports = {` 那一行（第 159 行）之前插入：

```js
// 探测/安装配置。命令取自 EchoBird 官方安装定义 docs/api/tools/install/dsh.json，
// 路径列表取自其 tools/dsh/paths.json。注意：这里的 agent id 是 'deepseek'（历史命名，
// 沿用现有 ADAPTERS 里的用法），但 CLI 命令和 npm 包名都是 dsh / @deepseek-ai/dsh。
const detect = {
  tier: 'cli',
  identityGuard: {
    description: 'DeepSeek Harness（命令 dsh）是 DeepSeek 官方开源的 agent runtime，developer preview 阶段',
    notToConfuseWith: [],
  },
  requirements: { node: '>=22.19' },
  probe: {
    kind: 'path',
    win32: ['%APPDATA%\\npm\\dsh.cmd', '%APPDATA%\\npm\\dsh'],
    darwin: ['/usr/local/bin/dsh', '/opt/homebrew/bin/dsh', '~/.npm-global/bin/dsh'],
    linux: ['/usr/local/bin/dsh', '/usr/bin/dsh', '~/.npm-global/bin/dsh', '~/.local/bin/dsh'],
  },
  install: {
    methods: [{ kind: 'npm', pkg: '@deepseek-ai/dsh' }],
    warning: 'developer preview，0.1.0-rc.x，可能有破坏性变更',
  },
  network: {
    testUrls: ['https://www.deepseek.com', 'https://github.com/deepseek-ai/deepseek-harness', 'https://registry.npmjs.org'],
    mirrors: {},
    blockedRegions: {},
  },
  verify: { cmd: 'dsh --version' },
  afterInstall: {
    tellUser: ['装完用 `dsh web` 启动本地服务，监听 127.0.0.1:3080，不会自动开浏览器', '只支持本地回环，暂不支持 --host 0.0.0.0'],
  },
};

```

然后把原来的：
```js
module.exports = {
  ID, ROOT, isSessionFile, fileToSessionId, parseLines, tailRead,
  readFile: tailRead,
```
改成：
```js
module.exports = {
  ID, ROOT, isSessionFile, fileToSessionId, parseLines, tailRead, detect,
  readFile: tailRead,
```

- [ ] **Step 2: 用 Node 直接加载确认没有语法错误**

Run: `node -e "console.log(require('./lib/adapters/deepseek').detect.tier)"`
Expected: 输出 `cli`

- [ ] **Step 3: 提交**

```bash
git add lib/adapters/deepseek.js
git commit -m "feat(deepseek): 新增 detect 探测/安装配置"
```

---

### Task 10: workbuddy.js 加 detect 配置

**Files:**
- Modify: `lib/adapters/workbuddy.js:212` （`module.exports = {` 那一行前面插入）

- [ ] **Step 1: 加 detect 导出**

在 `lib/adapters/workbuddy.js` 的 `module.exports = {` 那一行（第 212 行）之前插入：

```js
// 探测/安装配置。命令取自 EchoBird 官方安装定义 docs/api/tools/install/workbuddy.json，
// 路径与注册表匹配取自其 tools/workbuddy/paths.json。
const detect = {
  tier: 'gui',
  identityGuard: {
    description: 'WorkBuddy 是腾讯 CodeBuddy 的"办公版"桌面 Agent',
    notToConfuseWith: ['CodeBuddy 编程 IDE（配置目录是 ~/.codebuddy，完全分开）'],
  },
  requirements: {},
  probe: {
    kind: 'registry',
    win32: ['%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe'],
    darwin: ['/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy'],
    linux: [],
    registryHints: { displayNamePrefixes: ['WorkBuddy'] },
  },
  install: {
    methods: [
      { kind: 'winget', id: 'Tencent.WorkBuddy', flags: ['--accept-package-agreements', '--accept-source-agreements'] },
      { kind: 'download', url: 'https://www.codebuddy.cn/work/' },
    ],
    warning: 'Linux 不支持',
  },
  network: { testUrls: ['https://www.codebuddy.cn'], mirrors: {}, blockedRegions: {} },
  afterInstall: {
    tellUser: ['优先用 winget 静默安装；winget 不可用时会打开下载页，需要自己点完安装向导'],
  },
};

```

然后把原来的：
```js
module.exports = {
  ID, ROOT, isSessionFile, parseLines, scanHeartbeats, checkDesktopIdle, fileToSessionId,
```
改成：
```js
module.exports = {
  ID, ROOT, isSessionFile, parseLines, scanHeartbeats, checkDesktopIdle, fileToSessionId, detect,
```

- [ ] **Step 2: 用 Node 直接加载确认没有语法错误**

Run: `node -e "console.log(require('./lib/adapters/workbuddy').detect.tier)"`
Expected: 输出 `gui`

- [ ] **Step 3: 提交**

```bash
git add lib/adapters/workbuddy.js
git commit -m "feat(workbuddy): 新增 detect 探测/安装配置（含 winget id）"
```

---

### Task 11: zcode.js 加 detect 配置

**Files:**
- Modify: `lib/adapters/zcode.js:167` （`module.exports = {` 那一行前面插入）

- [ ] **Step 1: 加 detect 导出**

在 `lib/adapters/zcode.js` 的 `module.exports = {` 那一行（第 167 行）之前插入：

```js
// 探测/安装配置。命令取自 EchoBird 官方安装定义 docs/api/tools/install/zcode.json，
// 路径与注册表匹配取自其 tools/zcode/paths.json。
const detect = {
  tier: 'gui',
  identityGuard: {
    description: 'ZCode 是 Z.AI(智谱) 基于 OpenCode 做的桌面版 coding agent',
    notToConfuseWith: ['OpenCode CLI', 'OpenCode Desktop'],
  },
  requirements: {},
  probe: {
    kind: 'registry',
    win32: ['%LOCALAPPDATA%\\Programs\\ZCode\\ZCode.exe'],
    darwin: ['/Applications/ZCode.app/Contents/MacOS/ZCode'],
    linux: ['/opt/ZCode/zcode', '~/.local/bin/zcode'],
    registryHints: { displayNamePrefixes: ['ZCode'] },
  },
  install: {
    methods: [{ kind: 'download', url: 'https://zcode.z.ai/cn#all-downloads' }],
    warning: '没有 winget/命令行安装方式，只能下载安装包交给用户点完向导',
  },
  network: { testUrls: ['https://zcode.z.ai'], mirrors: {}, blockedRegions: {} },
  afterInstall: {
    tellUser: ['下载文件的完整路径', '安装向导已打开，需要自己点完，程序不会替你点'],
  },
};

```

然后把原来的：
```js
module.exports = {
  ID, ROOT,
  scanAll(store) {
```
改成：
```js
module.exports = {
  ID, ROOT, detect,
  scanAll(store) {
```

- [ ] **Step 2: 用 Node 直接加载确认没有语法错误**

Run: `node -e "console.log(require('./lib/adapters/zcode').detect.tier)"`
Expected: 输出 `gui`

- [ ] **Step 3: 提交**

```bash
git add lib/adapters/zcode.js
git commit -m "feat(zcode): 新增 detect 探测/安装配置"
```

---

### Task 12: doubao.js 加 detect 配置

**Files:**
- Modify: `lib/adapters/doubao.js:66` （`module.exports = {` 那一行前面插入）

- [ ] **Step 1: 加 detect 导出**

在 `lib/adapters/doubao.js` 的 `module.exports = {` 那一行（第 66 行）之前插入：

```js
// 探测配置：豆包不在 EchoBird 支持范围内，官方下载地址还没查到（见设计 spec「落地前必须
// 先确认的事项」），这轮 install.methods 留空——设置页会显示"未检测到"但不出现安装按钮。
// probe 复用上面已有的 ROOT 常量：这不是"安装目录"探测，而是"本机是否有豆包会话数据"信号，
// 是目前唯一能确认的真实探测依据。
const detect = {
  tier: 'gui',
  identityGuard: { description: '豆包（字节跳动）桌面客户端', notToConfuseWith: [] },
  requirements: {},
  probe: { kind: 'path', win32: [ROOT], darwin: [], linux: [] },
  install: { methods: [], warning: '官方下载地址待确认，这轮只做探测' },
  network: { testUrls: [], mirrors: {}, blockedRegions: {} },
};

```

然后把原来的：
```js
module.exports = {
  ID, ROOT,
  scanAll(store) { return scanOrPoll(store); },
```
改成：
```js
module.exports = {
  ID, ROOT, detect,
  scanAll(store) { return scanOrPoll(store); },
```

- [ ] **Step 2: 用 Node 直接加载确认没有语法错误**

Run: `node -e "console.log(require('./lib/adapters/doubao').detect.tier)"`
Expected: 输出 `gui`

- [ ] **Step 3: 提交**

```bash
git add lib/adapters/doubao.js
git commit -m "feat(doubao): 新增 detect 探测配置（安装方式待确认，先只做探测）"
```

---

### Task 13: marvis.js 加 detect 配置

**Files:**
- Modify: `lib/adapters/marvis.js:156` （`module.exports = {` 那一行前面插入）

- [ ] **Step 1: 加 detect 导出**

在 `lib/adapters/marvis.js` 的 `module.exports = {` 那一行（第 156 行）之前插入：

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

然后把原来的：
```js
module.exports = {
  ID, ROOT,
  scanAll(store) {
    const db = pickUserDb();
```
改成：
```js
module.exports = {
  ID, ROOT, detect,
  scanAll(store) {
    const db = pickUserDb();
```

- [ ] **Step 2: 用 Node 直接加载确认没有语法错误**

Run: `node -e "console.log(require('./lib/adapters/marvis').detect.tier)"`
Expected: 输出 `gui`

- [ ] **Step 3: 提交**

```bash
git add lib/adapters/marvis.js
git commit -m "feat(marvis): 新增 detect 探测配置（安装方式待确认，先只做探测）"
```

---

### Task 14: 8 个 adapter 的 detect 配置一致性测试

**Files:**
- Modify: `lib/detect.test.js`

- [ ] **Step 1: 写测试**

在 `lib/detect.test.js` 末尾追加：

```js
test('8 个 adapter 的 detect 配置符合基本 schema', () => {
  const adapters = [
    require('./adapters/claude'),
    require('./adapters/codex'),
    require('./adapters/pi'),
    require('./adapters/deepseek'),
    require('./adapters/workbuddy'),
    require('./adapters/zcode'),
    require('./adapters/doubao'),
    require('./adapters/marvis'),
  ];
  assert.equal(adapters.length, 8);
  for (const a of adapters) {
    assert.ok(a.detect, `${a.ID} 缺少 detect 导出`);
    assert.ok(['cli', 'gui'].includes(a.detect.tier), `${a.ID}.detect.tier 必须是 cli 或 gui`);
    assert.ok(a.detect.probe && Array.isArray(a.detect.probe.win32), `${a.ID}.detect.probe.win32 必须是数组`);
    assert.ok(a.detect.identityGuard && typeof a.detect.identityGuard.description === 'string' && a.detect.identityGuard.description, `${a.ID}.detect.identityGuard.description 缺失`);
    assert.ok(Array.isArray(a.detect.install && a.detect.install.methods), `${a.ID}.detect.install.methods 必须是数组（可以为空）`);
  }
});
```

- [ ] **Step 2: 跑测试确认通过**（这一步不是 TDD 的"先失败"——Task 6-13 已经把 8 个 adapter 都改完了，这里是补一道回归测试防止以后有人改漏字段）

Run: `node --test lib/detect.test.js`
Expected: PASS，18 个测试全绿

- [ ] **Step 3: 提交**

```bash
git add lib/detect.test.js
git commit -m "test: 8 个 adapter 的 detect 配置 schema 一致性测试"
```

---

### Task 15: server.js 接入 GET /api/agents/status

**Files:**
- Modify: `server.js:8`（import 处）
- Modify: `server.js:704` 附近（新路由插入点，在 `/api/rescan` 块之后、"静态文件" 块之前）

- [ ] **Step 1: 加 import**

在 `server.js` 第 8 行 `const store = require('./lib/store');` 后面加一行：

```js
const detect = require('./lib/detect');
```

- [ ] **Step 2: 加路由**

在 `server.js` 里找到这一段（大约第 704 行开始）：

```js
  // 静态文件
  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }
```

在它前面插入：

```js
  // 应用探测：返回每个 agent 的安装/探测状态（设置页"应用管理"用）
  if (pathname === '/api/agents/status') {
    try {
      const probed = await detect.probeAll(ADAPTERS);
      const agents = {};
      for (const [id, r] of Object.entries(probed)) {
        const meta = AGENT_DEFS[id] || {};
        agents[id] = { ...r, name: meta.name || id, icon: meta.icon || '', color: meta.color || '#888' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'probe failed' }));
    }
    return;
  }

```

- [ ] **Step 3: 手动验证**

启动服务：

```bash
node server.js
```

新开一个终端跑：

```bash
curl http://127.0.0.1:4876/api/agents/status
```

Expected: 返回形如 `{"agents":{"claude":{...,"installed":true,...},"codex":{...},...}}` 的 JSON，8 个 agent 都有条目；由于这台机器装了 Claude Code，`claude.installed` 应该是 `true`。跑完 `Ctrl+C` 停掉 server。

- [ ] **Step 4: 提交**

```bash
git add server.js
git commit -m "feat: 新增 GET /api/agents/status 探测接口"
```

---

### Task 16: 前端"应用管理"弹窗（只读展示）

**Files:**
- Modify: `public/index.html:325-327`（工具栏按钮）
- Modify: `public/app.js:944`（`$('btn-cols').onclick = openColManager;` 那一行后面）

- [ ] **Step 1: 加工具栏按钮**

在 `public/index.html` 里找到（第 325-327 行）：

```html
    <button class="icon-btn" id="btn-cols" title="管理瀑布流列（显示/隐藏/排序）">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
    </button>
```

在它后面插入：

```html
    <button class="icon-btn" id="btn-agents" title="应用管理（查看各 AI Agent 安装状态）">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
    </button>
```

- [ ] **Step 2: 加弹窗逻辑**

在 `public/app.js` 里找到（第 944 行）：

```js
$('btn-cols').onclick = openColManager;
```

在它后面插入：

```js

/* ---------- 应用管理（探测各 AI Agent 安装状态，只读） ---------- */
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
  } catch {
    pop.innerHTML = '<div class="pop-head">应用管理</div><div style="padding:16px;color:var(--text3);font-size:13px">检测失败，请稍后重试</div>';
    return;
  }

  const agents = Object.values(data.agents || {});
  let html = `<div class="pop-head">应用管理 <span style="opacity:.5;font-weight:400">（安装/修复功能下一版加入，这版先看状态）</span></div>
    <div style="padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:60vh;overflow-y:auto">`;
  for (const a of agents) {
    const badge = a.installed
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#1e3a2e;color:#4ade80">已安装${a.version ? ' ' + esc(a.version) : ''}</span>`
      : `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--text3)">未检测到</span>`;
    html += `<div style="border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center">
      <div style="width:32px;height:32px;border-radius:8px;margin:0 auto 6px;background:${esc(a.color || '#888')};display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:600">${esc((a.name || a.id || '?').slice(0, 1))}</div>
      <div style="font-size:12px;font-weight:600;margin-bottom:4px">${esc(a.name || a.id)}</div>
      ${badge}
    </div>`;
  }
  html += '</div>';
  pop.innerHTML = html;
}
$('btn-agents').onclick = openAgentManager;
```

- [ ] **Step 3: 手动验证**

```bash
node server.js
```

浏览器打开 `http://127.0.0.1:4876`，点工具栏新出现的"应用管理"图标（方框+十字那个）。

Expected：弹出一个 2 列卡片网格，8 个 agent 各一张卡片，装了的（这台机器上至少 Claude Code）显示绿色"已安装 vX.X.X"徽标，没装的显示灰色"未检测到"。关闭弹窗（点其他地方，跟"列设置"弹窗关闭逻辑一致）。跑完 `Ctrl+C` 停掉 server。

- [ ] **Step 4: 提交**

```bash
git add public/index.html public/app.js
git commit -m "feat: 新增「应用管理」弹窗，展示各 Agent 探测状态（只读）"
```

---

### Task 17: 端到端人工验证

**Files:** 无代码改动，纯验证

- [ ] **Step 1: 跑全部单元测试**

```bash
npm test
```

Expected: 18 个测试全部 PASS，0 失败

- [ ] **Step 2: 启动真实服务，交叉核对探测结果**

```bash
node server.js
```

浏览器打开应用管理弹窗，把 8 个 agent 的探测结果和这台机器的真实情况逐一核对：
- Claude Code：应显示"已安装"（当前就在用它）
- 其余 7 个：按这台机器实际有没有装，人工核实是否与卡片显示一致

如果某个探测结果和实际不符，回到对应 adapter 的 `detect.probe.win32` 路径列表核查（多半是路径确实和这台机器的实际安装位置不一致，属于预期内——探测路径来自 EchoBird 的通用清单，不是针对这台机器定制的）。

- [ ] **Step 3: 验证用户路径覆盖生效**

创建 `~/.agent-board/tool-paths.json`（把 `~` 换成实际的 `C:\Users\<你的用户名>`），内容：

```json
{
  "pi": ["C:\\Windows\\System32\\notepad.exe"]
}
```

（用 notepad.exe 只是为了有个必然存在的文件，验证"覆盖路径存在就命中"这条逻辑，不代表真的把 notepad 当 pi 用）

刷新应用管理弹窗，Expected：pi 卡片变成"已安装"（因为覆盖路径 notepad.exe 确实存在）。验证完删掉这个测试文件，避免污染真实配置：

```bash
rm ~/.agent-board/tool-paths.json
```

- [ ] **Step 4: 验证坏 JSON 不崩溃**

```bash
mkdir -p ~/.agent-board
echo '{ not valid json' > ~/.agent-board/tool-paths.json
```

刷新应用管理弹窗，Expected：不报错，正常显示（忽略这份坏覆盖，走内置探测）。验证完清理：

```bash
rm ~/.agent-board/tool-paths.json
```

---

## 完成后

这份计划跑完，agent-board 能：
- 准确判断 8 个 AI Agent 装没装、装在哪、什么版本，不再依赖这台机器专属的硬编码路径
- 在新的"应用管理"弹窗里展示这些状态
- 支持用户自定义路径覆盖，兼容非标准安装位置

**没做的**（下一份计划的范围）：点击安装、SSE 安装进度、`~/.agent-board/tool-paths.json` 的写入 UI（这轮只支持手动编辑这个文件）、探测结果对瀑布流默认显隐的联动。
