# 安装引擎（tier:cli） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent-board 的"应用管理"弹窗里，未安装的 CLI 类 Agent（claude / codex / pi / deepseek）能真正点一下按钮就装上——消费掉上一轮已经写进每个 adapter 但一直没被使用的 `detect.install` / `detect.network` / `detect.afterInstall` 数据。

**Architecture:** 在已有的 `lib/detect.js` 里新增两个纯函数 `pickMethod`（选安装方法）和 `installAgent`（跑安装链路，通过 `onProgress` 回调汇报每一步），命令执行函数可注入以便测试。`server.js` 新增 `POST /api/agents/:id/install`，用一个模块级布尔量保证全局同时只有一个安装任务，进度通过已有的 SSE 通道广播。前端在卡片上加"安装"按钮，`confirm()` 确认后发起请求，监听 SSE 更新卡片状态行。

**范围**：只做 `tier:'cli'` 的 4 个 agent。`tier:'gui'`（workbuddy / zcode / marvis）的安装、瀑布流列联动、探测缓存都不在这轮，别顺手做。

**Tech Stack:** Node.js 原生 `http` / `child_process`（继续零 npm 依赖），测试用 Node 内置 `node:test` + `node:assert`。

---

## 涉及文件一览

| 文件 | 改动 |
|---|---|
| `lib/detect.js` | 新增 `pickMethod`、`installAgent`，加进 `module.exports` |
| `lib/detect.test.js` | 新增 `pickMethod` 和 `installAgent` 的测试 |
| `server.js` | `/api/agents/status` 响应里带上 `install` 数据；新增 `POST /api/agents/:id/install` |
| `public/app.js` | 卡片加"安装"按钮 + 确认流程；SSE 监听 `agent-install-progress` |

**当前基线**（开工前的状态，用来对照）：`lib/detect.test.js` 有 26 个测试（`npm test` 总计 27，含仓库根目录那个老的 `test-idle-check.js`），`lib/detect.js` 有 171 行，`module.exports` 在文件末尾。

---

### Task 1: pickMethod —— 按平台选唯一一个安装方法

**Files:**
- Modify: `lib/detect.js`（在 `probeAll` 函数之后、`module.exports` 之前插入）
- Modify: `lib/detect.test.js`（末尾追加）

- [ ] **Step 1: 写失败的测试**

在 `lib/detect.test.js` 末尾追加：

```js
const { pickMethod } = require('./detect');

test('pickMethod win32 优先选带 win32 的 script', () => {
  const methods = [
    { kind: 'script', posix: 'curl x | sh' },
    { kind: 'script', win32: 'irm x | iex' },
    { kind: 'npm', pkg: 'foo' },
  ];
  const m = pickMethod(methods, 'win32');
  assert.equal(m.kind, 'script');
  assert.equal(m.win32, 'irm x | iex');
});

test('pickMethod win32 上跳过只有 posix 的 script，落到 npm', () => {
  const methods = [
    { kind: 'script', posix: 'curl x | sh' },
    { kind: 'npm', pkg: 'foo' },
  ];
  const m = pickMethod(methods, 'win32');
  assert.equal(m.kind, 'npm');
});

test('pickMethod 非 win32 平台选 posix script', () => {
  const methods = [
    { kind: 'script', posix: 'curl x | sh' },
    { kind: 'npm', pkg: 'foo' },
  ];
  const m = pickMethod(methods, 'darwin');
  assert.equal(m.kind, 'script');
  assert.equal(m.posix, 'curl x | sh');
});

test('pickMethod 非 win32 平台跳过 winget', () => {
  const methods = [
    { kind: 'winget', id: 'Some.App' },
    { kind: 'npm', pkg: 'foo' },
  ];
  const m = pickMethod(methods, 'linux');
  assert.equal(m.kind, 'npm');
});

test('pickMethod 只有 download 时返回 null（本轮不处理 download）', () => {
  const m = pickMethod([{ kind: 'download', url: 'https://x' }], 'win32');
  assert.equal(m, null);
});

test('pickMethod 空数组/undefined 返回 null', () => {
  assert.equal(pickMethod([], 'win32'), null);
  assert.equal(pickMethod(undefined, 'win32'), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test lib/detect.test.js`
Expected: FAIL，报 `pickMethod is not a function`

- [ ] **Step 3: 写最小实现**

在 `lib/detect.js` 里，`probeAll` 函数之后、`module.exports` 之前插入：

```js
// 从 install.methods 里选唯一一个当前平台可用的方法。
// 刻意不做「这个失败自动试下一个」的降级链：四选一的自动降级会让「这次到底跑了哪条命令」
// 变得不确定，出问题不好复现。失败就如实报错，让用户自己决定重试还是换方式。
function pickMethod(methods, platform = process.platform) {
  const list = methods || [];
  // 优先级：平台专属安装器脚本 > winget（仅 win32）> npm（跨平台兜底）——按优先级分轮扫描，
  // 不按数组书写顺序决定（2026-08-22 代码审查发现：codex.js 的 methods 数组是 npm 排在
  // win32 script 前面，如果按数组顺序线性扫描第一个匹配就返回，会错误选中 npm 而不是官方脚本）
  for (const m of list) {
    if (m.kind === 'script') {
      if (platform === 'win32' && m.win32) return m;
      if (platform !== 'win32' && m.posix) return m;
    }
    // kind === 'download' 本轮不处理（tier:cli 的 4 个 agent 都走不到这里）
  }
  if (platform === 'win32') {
    const wg = list.find((m) => m.kind === 'winget');
    if (wg) return wg;
  }
  return list.find((m) => m.kind === 'npm') || null;
}
```

把文件末尾的 `module.exports` 改成：

```js
module.exports = {
  expandPath, probePathList, queryUninstallEntries, probeRegistryApp,
  loadUserOverrides, tryVersion, probeAgent, probeAll, pickMethod,
  USER_OVERRIDES_PATH,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test lib/detect.test.js`
Expected: PASS，32 个测试全绿（基线 26 + 新增 6）

- [ ] **Step 5: 提交**

```bash
git add lib/detect.js lib/detect.test.js
git commit -m "feat: 安装引擎——按平台选唯一安装方法 pickMethod"
```

---

### Task 2: installAgent —— 前置拦截（被墙地区 / Node 版本不够）

**Files:**
- Modify: `lib/detect.js`（在 `pickMethod` 之后、`module.exports` 之前插入）
- Modify: `lib/detect.test.js`（末尾追加）

- [ ] **Step 1: 写失败的测试**

在 `lib/detect.test.js` 末尾追加：

```js
const { installAgent } = require('./detect');

// 收集 onProgress 汇报的每一步，方便断言
function collectSteps() {
  const steps = [];
  const onProgress = (step, detail) => steps.push({ step, detail });
  return { steps, onProgress };
}

test('installAgent 命中 blockedRegions 时直接 blocked，不执行任何命令', () => {
  let ran = false;
  const adapter = {
    ID: 'claude',
    detect: {
      tier: 'cli',
      network: { blockedRegions: { 'zh-CN': '需要代理，没有镜像可用' } },
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, { runCmd: () => { ran = true; return { status: 0 }; } });
  assert.equal(r.ok, false);
  assert.equal(steps[0].step, 'blocked');
  assert.equal(steps[0].detail.message, '需要代理，没有镜像可用');
  assert.equal(ran, false, '被墙拦截时不应该执行任何命令');
});

test('installAgent Node 版本不满足时 deps-missing，不执行任何命令', () => {
  let ran = false;
  const adapter = {
    ID: 'codex',
    detect: {
      tier: 'cli',
      requirements: { node: '>=22' },
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    runCmd: () => { ran = true; return { status: 0 }; },
    nodeVersion: 'v18.20.0',
  });
  assert.equal(r.ok, false);
  assert.equal(steps[0].step, 'deps-missing');
  assert.equal(steps[0].detail.need, '>=22');
  assert.equal(steps[0].detail.have, 'v18.20.0');
  assert.equal(ran, false);
});

test('installAgent Node 版本满足时不拦截（继续往下走到执行阶段）', () => {
  const adapter = {
    ID: 'codex',
    detect: {
      tier: 'cli',
      requirements: { node: '>=22' },
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
      verify: { cmd: 'codex --version' },
    },
  };
  const { steps, onProgress } = collectSteps();
  installAgent(adapter, onProgress, {
    runCmd: () => ({ status: 0, stdout: '' }),
    nodeVersion: 'v24.1.0',
    tryVersionFn: () => 'codex 1.2.3',
  });
  assert.ok(steps.every((s) => s.step !== 'deps-missing'), 'Node 24 满足 >=22，不该报缺依赖');
});

test('installAgent 没有可用方法时报 no-method', () => {
  const adapter = {
    ID: 'x',
    detect: { tier: 'cli', install: { methods: [{ kind: 'download', url: 'https://x' }] } },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, { runCmd: () => ({ status: 0 }), platform: 'win32' });
  assert.equal(r.ok, false);
  assert.equal(steps[0].step, 'no-method');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test lib/detect.test.js`
Expected: FAIL，报 `installAgent is not a function`

- [ ] **Step 3: 写最小实现**

在 `lib/detect.js` 里，`pickMethod` 之后、`module.exports` 之前插入：

```js
// 比较 Node 版本是否满足 ">=X" / ">=X.Y" / ">=X.Y.Z" 形式的要求。
// 只支持 ">=" 这一种写法——现有 4 个 cli adapter 的 requirements.node 全是这个形式，
// 不引入完整的 semver 解析（那会是这个零依赖项目里第一个真正需要外部库的地方）。
function satisfiesNodeVersion(current, requirement) {
  if (!requirement) return true;
  const m = String(requirement).match(/^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return true;                       // 看不懂的写法一律放行，不因为解析不了就挡住用户
  const need = [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
  const cm = String(current).match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!cm) return true;
  const have = [Number(cm[1]), Number(cm[2]), Number(cm[3])];
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return true;
    if (have[i] < need[i]) return false;
  }
  return true;                               // 完全相等也算满足
}

// 执行一条安装命令。和 tryVersion 一样走 cmd.exe /c（Windows 上 npm 全局装的是 .cmd shim）。
// 超时给 10 分钟：装 CLI 工具走 npm 拉包可能很慢，8 秒的 tryVersion 超时在这里完全不够。
function defaultRunCmd(cmd) {
  try {
    return spawnSync('cmd.exe', ['/c', cmd], {
      encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    return { status: -1, error: e };
  }
}

// 把一个 method 描述翻译成真正要跑的命令字符串
function methodToCommand(method, platform = process.platform) {
  if (method.kind === 'script') return platform === 'win32' ? method.win32 : method.posix;
  if (method.kind === 'npm') {
    const flags = (method.flags || []).join(' ');
    return `npm install -g ${flags ? flags + ' ' : ''}${method.pkg}`.replace(/\s+/g, ' ').trim();
  }
  if (method.kind === 'winget') {
    const flags = (method.flags || []).join(' ');
    return `winget install --id ${method.id}${flags ? ' ' + flags : ''}`;
  }
  return null;
}

// 安装一个 tier:'cli' 的 agent。同步执行（内部 spawnSync），通过 onProgress(step, detail) 汇报进度。
// opts 全部可注入，测试时不碰真实系统：runCmd / tryVersionFn / nodeVersion / platform。
function installAgent(adapter, onProgress = () => {}, opts = {}) {
  const def = adapter.detect || {};
  const platform = opts.platform || process.platform;
  const runCmd = opts.runCmd || defaultRunCmd;
  const verifyFn = opts.tryVersionFn || tryVersion;
  const nodeVersion = opts.nodeVersion || process.version;

  // ① 被墙拦截：不做真实地区探测，固定按「中国大陆网络环境」判断（见设计文档）
  const blocked = def.network && def.network.blockedRegions && def.network.blockedRegions['zh-CN'];
  if (blocked) {
    onProgress('blocked', { message: blocked });
    return { ok: false, step: 'blocked' };
  }

  // ② 前置依赖（目前只有 Node 版本这一种）
  const needNode = def.requirements && def.requirements.node;
  if (needNode && !satisfiesNodeVersion(nodeVersion, needNode)) {
    onProgress('deps-missing', { need: needNode, have: nodeVersion });
    return { ok: false, step: 'deps-missing' };
  }

  // ③ 选方法
  const method = pickMethod(def.install && def.install.methods, platform);
  const command = method && methodToCommand(method, platform);
  if (!command) {
    onProgress('no-method', { platform });
    return { ok: false, step: 'no-method' };
  }

  // ④ 执行
  onProgress('installing', { command, method: method.kind });
  const r = runCmd(command);
  if (!r || r.error || r.status !== 0) {
    const stderr = r && (r.stderr || (r.error && r.error.message)) || '';
    onProgress('failed', { command, stderr: String(stderr).slice(0, 2000) });
    return { ok: false, step: 'failed' };
  }

  // ⑤ 校验
  onProgress('verifying', {});
  const version = verifyFn(def.verify && def.verify.cmd);
  if (!version) {
    onProgress('failed', { reason: '安装命令执行成功，但 verify 拿不到版本号（可能装上了但当前进程的 PATH 还没刷新，重启 agent-board 再看看）' });
    return { ok: false, step: 'failed' };
  }

  // ⑥ 完成
  const tellUser = (def.afterInstall && def.afterInstall.tellUser) || [];
  onProgress('done', { version, tellUser });
  return { ok: true, step: 'done', version };
}
```

把文件末尾的 `module.exports` 改成：

```js
module.exports = {
  expandPath, probePathList, queryUninstallEntries, probeRegistryApp,
  loadUserOverrides, tryVersion, probeAgent, probeAll,
  pickMethod, satisfiesNodeVersion, methodToCommand, installAgent,
  USER_OVERRIDES_PATH,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test lib/detect.test.js`
Expected: PASS，36 个测试全绿（上一任务 32 + 新增 4）

- [ ] **Step 5: 提交**

```bash
git add lib/detect.js lib/detect.test.js
git commit -m "feat: 安装引擎——installAgent 前置拦截（被墙地区/Node 版本）"
```

---

### Task 3: installAgent —— 补执行/校验路径的测试覆盖

上一个任务把 `installAgent` 整个写完了（因为链路是一体的，拆两半反而要写一次废弃的中间实现），但测试只覆盖了前置拦截。这个任务补齐后半段的覆盖，以及 `satisfiesNodeVersion` 和 `methodToCommand` 两个辅助函数。

**Files:**
- Modify: `lib/detect.test.js`（末尾追加）

- [ ] **Step 1: 写测试**

在 `lib/detect.test.js` 末尾追加：

```js
const { satisfiesNodeVersion, methodToCommand } = require('./detect');

test('satisfiesNodeVersion 各种边界', () => {
  assert.equal(satisfiesNodeVersion('v24.1.0', '>=22'), true);
  assert.equal(satisfiesNodeVersion('v22.0.0', '>=22'), true);
  assert.equal(satisfiesNodeVersion('v21.9.9', '>=22'), false);
  assert.equal(satisfiesNodeVersion('v22.19.0', '>=22.19.0'), true, '完全相等算满足');
  assert.equal(satisfiesNodeVersion('v22.18.5', '>=22.19.0'), false);
  assert.equal(satisfiesNodeVersion('v22.20.0', '>=22.19.0'), true);
  assert.equal(satisfiesNodeVersion('v18.0.0', undefined), true, '没要求就放行');
  assert.equal(satisfiesNodeVersion('v18.0.0', '^22'), true, '看不懂的写法放行，不误挡用户');
});

test('methodToCommand 拼 npm 命令（带 flags）', () => {
  const cmd = methodToCommand({ kind: 'npm', pkg: '@earendil-works/pi-coding-agent', flags: ['--ignore-scripts'] }, 'win32');
  assert.equal(cmd, 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent');
});

test('methodToCommand 拼 npm 命令（无 flags）', () => {
  assert.equal(methodToCommand({ kind: 'npm', pkg: '@openai/codex' }, 'win32'), 'npm install -g @openai/codex');
});

test('methodToCommand script 按平台取对应字段', () => {
  const m = { kind: 'script', win32: 'irm a | iex', posix: 'curl a | sh' };
  assert.equal(methodToCommand(m, 'win32'), 'irm a | iex');
  assert.equal(methodToCommand(m, 'darwin'), 'curl a | sh');
});

test('methodToCommand 拼 winget 命令', () => {
  const cmd = methodToCommand({ kind: 'winget', id: 'Some.App', flags: ['--accept-package-agreements'] }, 'win32');
  assert.equal(cmd, 'winget install --id Some.App --accept-package-agreements');
});

test('installAgent 成功路径：installing → verifying → done', () => {
  const adapter = {
    ID: 'pi',
    detect: {
      tier: 'cli',
      install: { methods: [{ kind: 'npm', pkg: '@earendil-works/pi-coding-agent', flags: ['--ignore-scripts'] }] },
      verify: { cmd: 'pi --version' },
      afterInstall: { tellUser: ['装完可能要点刷新'] },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    platform: 'win32',
    runCmd: (cmd) => {
      assert.equal(cmd, 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent');
      return { status: 0, stdout: 'added 1 package' };
    },
    tryVersionFn: () => '0.84.2',
  });
  assert.equal(r.ok, true);
  assert.equal(r.version, '0.84.2');
  assert.deepEqual(steps.map((s) => s.step), ['installing', 'verifying', 'done']);
  assert.deepEqual(steps[2].detail.tellUser, ['装完可能要点刷新']);
});

test('installAgent 安装命令失败：failed，且不继续跑 verify', () => {
  let verifyCalled = false;
  const adapter = {
    ID: 'pi',
    detect: {
      tier: 'cli',
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
      verify: { cmd: 'pi --version' },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    platform: 'win32',
    runCmd: () => ({ status: 1, stderr: 'npm ERR! 404 Not Found' }),
    tryVersionFn: () => { verifyCalled = true; return '1.0.0'; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.step, 'failed');
  assert.equal(verifyCalled, false, '安装失败后不该再跑 verify');
  const failed = steps.find((s) => s.step === 'failed');
  assert.match(failed.detail.stderr, /404 Not Found/);
});

test('installAgent 安装成功但 verify 拿不到版本号：failed', () => {
  const adapter = {
    ID: 'pi',
    detect: {
      tier: 'cli',
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
      verify: { cmd: 'pi --version' },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    platform: 'win32',
    runCmd: () => ({ status: 0 }),
    tryVersionFn: () => '',
  });
  assert.equal(r.ok, false);
  assert.equal(r.step, 'failed');
  assert.deepEqual(steps.map((s) => s.step), ['installing', 'verifying', 'failed']);
});

test('installAgent runCmd 抛异常时也走 failed，不把异常抛给调用方', () => {
  const adapter = {
    ID: 'pi',
    detect: { tier: 'cli', install: { methods: [{ kind: 'npm', pkg: 'foo' }] }, verify: { cmd: 'x' } },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    platform: 'win32',
    runCmd: () => ({ status: -1, error: new Error('spawn failed') }),
    tryVersionFn: () => '1.0.0',
  });
  assert.equal(r.ok, false);
  assert.match(steps.find((s) => s.step === 'failed').detail.stderr, /spawn failed/);
});

test('4 个 cli adapter 的真实 detect 数据都能选出可执行命令（win32）', () => {
  const cliAdapters = [
    require('./adapters/claude'),
    require('./adapters/codex'),
    require('./adapters/pi'),
    require('./adapters/deepseek'),
  ];
  for (const a of cliAdapters) {
    assert.equal(a.detect.tier, 'cli', `${a.ID} 应该是 cli tier`);
    const m = pickMethod(a.detect.install.methods, 'win32');
    assert.ok(m, `${a.ID} 在 win32 上应该能选出一个安装方法`);
    const cmd = methodToCommand(m, 'win32');
    assert.ok(cmd && cmd.length > 0 && !cmd.includes('undefined'), `${a.ID} 应该能拼出非空、不含 undefined 的命令，实际: ${cmd}`);
  }
});
```

- [ ] **Step 2: 跑测试确认通过**

（这一步不是 TDD 的红-绿循环：`installAgent` 上个任务已经实现完了，这里是补覆盖。若有测试失败，说明上个任务的实现和这里的预期不一致，需要判断是哪边写错了再修。）

Run: `node --test lib/detect.test.js`
Expected: PASS，46 个测试全绿（上一任务 36 + 新增 10）

- [ ] **Step 3: 提交**

```bash
git add lib/detect.test.js
git commit -m "test: 补 installAgent 执行/校验路径 + 辅助函数覆盖"
```

---

### Task 4: server.js —— status 响应带上 install 数据

**Files:**
- Modify: `server.js`（`/api/agents/status` 路由，第 705-721 行附近）

- [ ] **Step 1: 改路由**

在 `server.js` 里找到这一段：

```js
      const probed = await detect.probeAll(ADAPTERS);
      const agents = {};
      for (const [id, r] of Object.entries(probed)) {
        const meta = AGENT_DEFS[id] || {};
        agents[id] = { ...r, name: meta.name || id, icon: meta.icon || '', color: meta.color || '#888' };
      }
```

改成：

```js
      const probed = await detect.probeAll(ADAPTERS);
      const byId = Object.fromEntries(ADAPTERS.map((a) => [a.ID, a]));
      const agents = {};
      for (const [id, r] of Object.entries(probed)) {
        const meta = AGENT_DEFS[id] || {};
        // install 数据透传给前端：渲染「安装」按钮的确认弹窗要用（要跑什么命令、有什么警告）
        const def = (byId[id] && byId[id].detect) || {};
        agents[id] = {
          ...r,
          name: meta.name || id, icon: meta.icon || '', color: meta.color || '#888',
          install: def.install || null,
        };
      }
```

- [ ] **Step 2: 手动验证**

这台机器上有看门狗（`agent-board-watchdog.js`）常驻跑着 `node server.js`，改完 `server.js` 需要让它重新加载——看门狗会在进程退出后自动拉起，所以直接杀掉当前进程即可：

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agent-board*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
```

等 5 秒让看门狗把它拉起来，然后：

```bash
curl -s http://127.0.0.1:4876/api/agents/status | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('pi.install.methods:', JSON.stringify(j.agents.pi.install.methods))})"
```

Expected: 输出 pi 的 methods 数组，含 `{"kind":"script","posix":"curl -fsSL https://pi.dev/install.sh | sh"}` 和 npm 那一条。

- [ ] **Step 3: 提交**

```bash
git add server.js
git commit -m "feat: /api/agents/status 响应带上 install 数据供前端渲染确认弹窗"
```

---

### Task 5: server.js —— POST /api/agents/:id/install

**Files:**
- Modify: `server.js`（在 `/api/agents/status` 路由之后、"静态文件"块之前插入）

- [ ] **Step 1: 加路由**

在 `server.js` 里找到 `/api/agents/status` 路由块的结尾（`  }` 之后、`  // 静态文件` 之前），插入：

```js
  // 安装某个 agent（只支持 tier:'cli'）。全局同时只允许一个安装任务在跑。
  // 响应立即返回（参考 /api/rescan 的异步模式），真实进度走 SSE 的 agent-install-progress 事件。
  if (pathname.startsWith('/api/agents/') && pathname.endsWith('/install') && req.method === 'POST') {
    const id = pathname.slice('/api/agents/'.length, -'/install'.length);
    const adapter = ADAPTERS.find((a) => a.ID === id);
    if (!adapter || !adapter.detect) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未知 agent: ' + id }));
      return;
    }
    if (adapter.detect.tier !== 'cli') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '这一版只支持命令行类工具的自动安装' }));
      return;
    }
    if (installInProgress) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '已有安装任务在进行，请等它结束' }));
      return;
    }
    installInProgress = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, background: true }));
    // 让响应先发出去再开跑（installAgent 内部是同步 spawnSync，会阻塞事件循环）
    setTimeout(() => {
      try {
        detect.installAgent(adapter, (step, detail) => {
          sseBroadcast('agent-install-progress', { agentId: id, step, ...detail });
        });
      } catch (e) {
        console.error(`[install] ${id} 未预期的异常:`, e.message);
        sseBroadcast('agent-install-progress', { agentId: id, step: 'failed', reason: e.message || '未知错误' });
      } finally {
        installInProgress = false;
      }
    }, 50);
    return;
  }

```

- [ ] **Step 2: 加全局标记**

在 `server.js` 里找到这一行（第 143 行附近）：

```js
const ADAPTERS = [claude, codex, workbuddy, deepseek, marvis, zcode, pi];
```

在它下面加：

```js
// 全局安装锁：同时只允许一个安装任务（installAgent 内部是阻塞的 spawnSync，
// 多个并发跑会互相抢终端输出、也没法在 UI 上清晰呈现进度）。
// 内存态，server 重启自动清零，不会出现「永久卡在进行中」。
let installInProgress = false;
```

- [ ] **Step 3: 手动验证**

重启服务（看门狗会自动拉起）：

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agent-board*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
```

等 5 秒，然后验证三种拒绝路径（都不会真的装东西）：

```bash
curl -s -X POST http://127.0.0.1:4876/api/agents/nonexistent/install
```
Expected: `{"error":"未知 agent: nonexistent"}`

```bash
curl -s -X POST http://127.0.0.1:4876/api/agents/zcode/install
```
Expected: `{"error":"这一版只支持命令行类工具的自动安装"}`（zcode 是 tier:'gui'）

```bash
curl -s -X POST http://127.0.0.1:4876/api/agents/claude/install
```
Expected: `{"ok":true,"background":true}` —— 然后因为 claude 的 `blockedRegions['zh-CN']` 命中，安装会立刻以 `blocked` 结束，不会真的执行任何命令。可以顺便验证 SSE 有没有收到这个事件：

```bash
curl -s -N --max-time 8 http://127.0.0.1:4876/api/events | grep -A1 agent-install-progress
```
（在另一个窗口重新 POST 一次 claude，观察这个 curl 输出里是否出现 `step":"blocked"`。如果 grep 没抓到也不必纠结，前端联调时还会再验一次。）

- [ ] **Step 4: 提交**

```bash
git add server.js
git commit -m "feat: 新增 POST /api/agents/:id/install（全局单任务锁 + SSE 进度）"
```

---

### Task 6: 前端 —— 安装按钮 + 确认 + SSE 进度

**Files:**
- Modify: `public/app.js`（`openAgentManager` 函数，第 946-987 行附近；`connectSSE` 函数，第 989 行附近）

- [ ] **Step 1: 卡片加安装按钮**

在 `public/app.js` 里找到 `openAgentManager` 中的这一段：

```js
  const agents = Object.values(data.agents || {});
  let html = `<div class="pop-head">应用管理 <span style="opacity:.5;font-weight:400">（安装/修复功能下一版加入，这版先看状态）</span></div>
    <div style="padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:60vh;overflow-y:auto">`;
  for (const a of agents) {
    const badge = a.installed
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#DCFCE7;color:#15803D">已安装${a.version ? ' ' + esc(a.version) : ''}</span>`
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
```

整段替换成：

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
      const method = (a.install.methods || [])[0];
      const cmdHint = method
        ? (method.kind === 'npm' ? `npm install -g ${(method.flags || []).join(' ')} ${method.pkg}`.replace(/\s+/g, ' ')
          : method.kind === 'script' ? (method.win32 || method.posix)
          : method.kind === 'winget' ? `winget install --id ${method.id}` : String(method.kind))
        : '(未知)';
      const warn = a.install.warning ? `\n\n注意：${a.install.warning}` : '';
      if (!confirm(`即将安装 ${a.name || id}\n\n将执行：${cmdHint}${warn}\n\n确定继续吗？`)) return;
      b.disabled = true;
      // 一次只能装一个：把所有安装按钮都禁掉，等这次跑完再刷新
      pop.querySelectorAll('.ab-install').forEach((x) => { x.disabled = true; });
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(id)}/install`, { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
      } catch (e) {
        toast('安装请求失败：' + (e.message || '未知错误'));
        pop.querySelectorAll('.ab-install').forEach((x) => { x.disabled = false; });
      }
    };
  });
}
```

- [ ] **Step 2: SSE 监听安装进度**

在 `public/app.js` 里找到 `connectSSE()` 中的这一行：

```js
  es.addEventListener('scan', (ev) => {
```

在它**之前**插入：

```js
  // 安装进度：更新对应卡片的状态行。弹窗关掉了就什么也不做（querySelector 找不到元素）
  es.addEventListener('agent-install-progress', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      const card = document.querySelector(`.ab-card[data-id="${CSS.escape(d.agentId)}"]`);
      const line = card && card.querySelector('.ab-progress');
      const TEXT = {
        blocked: () => '⛔ ' + (d.message || '当前网络环境无法安装'),
        'deps-missing': () => `⛔ 需要 Node ${d.need}，当前 ${d.have}`,
        'no-method': () => '⛔ 这个平台没有可用的安装方式',
        installing: () => '⏳ 安装中…',
        verifying: () => '⏳ 校验中…',
        done: () => '✅ 完成 ' + (d.version || ''),
        failed: () => '❌ ' + (d.reason || d.stderr || '安装失败'),
      };
      if (line) line.textContent = (TEXT[d.step] || (() => d.step))();
      // 终态：解锁按钮 + 刷新弹窗（done 时要展示 tellUser 提示）
      if (d.step === 'done' || d.step === 'failed' || d.step === 'blocked'
          || d.step === 'deps-missing' || d.step === 'no-method') {
        document.querySelectorAll('.ab-install').forEach((x) => { x.disabled = false; });
        if (d.step === 'done') {
          const tips = (d.tellUser || []).join('\n');
          toast('安装完成' + (d.version ? '：' + d.version : ''));
          if (tips) setTimeout(() => alert('安装完成，几点说明：\n\n' + tips), 300);
          // 重新探测，刷新卡片状态
          if (state.popoverFor === 'agents') setTimeout(() => openAgentManager(), 600);
        }
      }
    } catch {}
  });
```

- [ ] **Step 3: 语法检查**

Run: `node -e "new Function(require('fs').readFileSync('public/app.js','utf8')); console.log('SYNTAX OK')"`
Expected: 输出 `SYNTAX OK`

- [ ] **Step 4: 手动验证（不真装东西）**

`public/` 下的静态文件是每次请求现读的，不用重启服务。curl 确认改动已生效：

```bash
curl -s http://127.0.0.1:4876/app.js | grep -c "ab-install"
```
Expected: 输出大于 0 的数字

然后在浏览器打开 `http://127.0.0.1:4876`，点工具栏的"应用管理"按钮。因为这台机器上 7 个 agent 目前全都探测为已安装（`~/.agent-board/tool-paths.json` 里配了覆盖路径），**不会有任何安装按钮出现**——这是正确行为。要看到按钮，先临时把覆盖文件里的 pi 那一行去掉：

```bash
node -e "const fs=require('fs'),p=process.env.USERPROFILE+'/.agent-board/tool-paths.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));delete j.pi;fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('已临时移除 pi 覆盖')"
```

刷新页面重新打开弹窗，pi 卡片应显示"未检测到"+"安装"按钮。**点一下按钮但在 confirm 弹窗上点「取消」**，确认确认框里显示的命令是 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`，然后恢复覆盖文件：

```bash
node -e "const fs=require('fs'),p=process.env.USERPROFILE+'/.agent-board/tool-paths.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.pi=['D:\\\\Program Files\\\\node-v22.14.0-win-x64\\\\node_global\\\\pi.cmd'];fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('已恢复 pi 覆盖')"
```

- [ ] **Step 5: 提交**

```bash
git add public/app.js
git commit -m "feat: 应用管理弹窗加安装按钮（确认 + SSE 进度 + 完成后刷新）"
```

---

### Task 7: 端到端真实验证（真的卸载再装一次 pi）

**Files:** 无代码改动，纯验证

这是整个计划里唯一一次真实执行安装命令。选 pi 是因为它是开源小工具、Windows 上走 npm 安装（不涉及 `irm | iex` 这种更激进的操作）、卸了能立刻装回来，风险最低。

- [ ] **Step 1: 跑全部单元测试**

Run: `npm test`
Expected: 47 个测试全部 PASS（46 个 detect.test.js + 1 个 test-idle-check.js 套件），0 失败

- [ ] **Step 2: 记录当前 pi 版本，然后真实卸载**

```bash
cmd.exe /c "pi --version"
```
记下输出的版本号。然后卸载：

```bash
cmd.exe /c "npm uninstall -g @earendil-works/pi-coding-agent"
```

确认真的卸掉了：

```bash
cmd.exe /c "pi --version" 2>&1 | head -3
```
Expected: 报找不到命令之类的错误（不再输出版本号）

- [ ] **Step 3: 临时移除 pi 的路径覆盖，让探测能反映真实情况**

```bash
node -e "const fs=require('fs'),p=process.env.USERPROFILE+'/.agent-board/tool-paths.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));delete j.pi;fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('已临时移除 pi 覆盖')"
```

```bash
curl -s http://127.0.0.1:4876/api/agents/status | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('pi installed:', j.agents.pi.installed)})"
```
Expected: `pi installed: false`

- [ ] **Step 4: 通过 UI 真实安装一次**

浏览器打开 `http://127.0.0.1:4876`，点"应用管理"，pi 卡片应显示"未检测到"和"安装"按钮。点"安装"，在 confirm 弹窗点**确定**。

观察：
- 卡片状态行依次出现"⏳ 安装中…" → "⏳ 校验中…" → "✅ 完成 x.x.x"
- 弹出安装完成的提示（tellUser 内容）
- 约 0.6 秒后弹窗自动刷新，pi 卡片变成绿色"已安装 x.x.x"徽标，安装按钮消失

如果任何一步卡住或报错，把状态行显示的错误信息记下来——那就是要修的东西。

- [ ] **Step 5: 命令行交叉确认真的装上了**

```bash
cmd.exe /c "pi --version"
```
Expected: 输出版本号（应该和 Step 2 记的一致或更新）

- [ ] **Step 6: 恢复 pi 的路径覆盖**

```bash
node -e "const fs=require('fs'),p=process.env.USERPROFILE+'/.agent-board/tool-paths.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.pi=['D:\\\\Program Files\\\\node-v22.14.0-win-x64\\\\node_global\\\\pi.cmd'];fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('已恢复 pi 覆盖')"
```

```bash
curl -s http://127.0.0.1:4876/api/agents/status | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('全部 7 个 installed:', Object.values(j.agents).every(a=>a.installed))})"
```
Expected: `全部 7 个 installed: true`（恢复到这轮开工前的状态）

- [ ] **Step 7: 验证并发拦截**

在安装还没跑完的时候连发两个请求会 409。这个不好手动掐时机，改用一个必然被拒的请求代替验证锁的存在——直接连发两次 claude（第一个会因被墙立刻结束，但足以观察到第二个请求在锁释放前被拒的可能性）：

```bash
curl -s -X POST http://127.0.0.1:4876/api/agents/claude/install & curl -s -X POST http://127.0.0.1:4876/api/agents/claude/install; wait
```
Expected: 两个响应中至少有一个是 `{"ok":true,"background":true}`；如果另一个是 `{"error":"已有安装任务在进行，请等它结束"}` 说明锁生效了。若两个都是 ok（因为 claude 的 blocked 判定太快，锁已经释放），这不算失败——锁的逻辑在代码审查阶段确认过即可，不必强求这个时序竞态能被手动复现。

---

## 完成后

这份计划跑完，agent-board 能：
- 在应用管理弹窗里给未安装的 CLI 类工具（claude / codex / pi / deepseek）显示"安装"按钮
- 点击后先展示要执行的确切命令让用户确认，再真正执行
- 安装过程中实时显示进度（安装中/校验中/完成/失败原因）
- 被墙的工具（claude）如实告诉用户"需要代理，没有镜像可用"，而不是让用户干等一个必然失败的安装
- 装完自动重新探测刷新状态

**没做的**（下一轮的范围）：`tier:'gui'` 三个工具的安装（winget / 下载页两条分支）、Marvis 的下载地址调研、探测结果缓存、瀑布流列联动。
