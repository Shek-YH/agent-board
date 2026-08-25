# 模型端口设置：自动识别与手动桌面端切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将模型端口设置改成每个 Agent 都能直接点击 CLI/桌面端自动目标，并用勾选框控制高优先级的手动桌面端目标。

**Architecture:** 保留 `launch-overrides.json` 作为机器级配置，但把每个 Agent 的值归一化为 `manualDesktop.enabled/target`，兼容旧的字符串值。新增独立的自动目标解析模块，服务端统一处理探测、优先级和启动；前端只渲染目标描述并提交 `agent + target`，不拼接命令。

**Tech Stack:** Node.js 内置 `http/fs/net/child_process`、原生 JavaScript、Node test runner，无新增依赖。

---

### Task 1: 扩展启动覆盖存储并保持旧配置可读

**Files:**
- Modify: `lib/launch.js`
- Modify: `lib/launch.test.js`

- [ ] **Step 1: 写失败测试，锁定新旧配置格式**

在 `lib/launch.test.js` 中保留端口探测测试，替换旧覆盖测试为以下行为：

```js
const {
  loadLaunchOverrides,
  saveLaunchOverride,
  getManualDesktopOverride,
} = require('./launch');

test('loadLaunchOverrides 把旧字符串归一化为启用的手动桌面端', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, JSON.stringify({ pi: '"C:\\\\Pi\\\\Pi.exe"' }));
  assert.deepEqual(loadLaunchOverrides(p), {
    pi: { manualDesktop: { enabled: true, target: '"C:\\\\Pi\\\\Pi.exe"' } },
  });
});

test('loadLaunchOverrides 读取新对象并过滤坏字段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, JSON.stringify({
    hermes: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
    bad: { manualDesktop: { enabled: 'yes', target: 42 } },
  }));
  assert.deepEqual(loadLaunchOverrides(p), {
    hermes: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
  });
});

test('saveLaunchOverride 取消 enabled 时保留 target，空 target 才清除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  saveLaunchOverride('hermes', { enabled: true, target: 'Hermes.exe' }, p);
  assert.deepEqual(saveLaunchOverride('hermes', { enabled: false, target: 'Hermes.exe' }, p), {
    hermes: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
  });
  assert.deepEqual(saveLaunchOverride('hermes', { enabled: false, target: '' }, p), {});
});

test('getManualDesktopOverride 只在 enabled 且 target 非空时返回优先目标', () => {
  assert.deepEqual(getManualDesktopOverride({
    hermes: { manualDesktop: { enabled: true, target: 'Hermes.exe' } },
  }, 'hermes'), { enabled: true, target: 'Hermes.exe' });
  assert.equal(getManualDesktopOverride({
    hermes: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
  }, 'hermes'), null);
});
```

- [ ] **Step 2: 运行测试，确认当前字符串实现失败**

Run: `node --test lib/launch.test.js`

Expected: 新增的归一化和对象保存测试 FAIL，现有端口探测测试保持 PASS。

- [ ] **Step 3: 实现最小存储 API**

在 `lib/launch.js` 中增加归一化函数，并让 `loadLaunchOverrides` 始终返回以下形状：

```js
{ [agent]: { manualDesktop: { enabled: Boolean, target: String } } }
```

实现规则：

```js
function normalizeOverride(value) {
  if (typeof value === 'string' && value.trim()) {
    return { manualDesktop: { enabled: true, target: value.trim() } };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const manual = value.manualDesktop;
  if (!manual || typeof manual !== 'object' || Array.isArray(manual)) return null;
  const target = typeof manual.target === 'string' ? manual.target.trim() : '';
  if (!target) return null;
  return { manualDesktop: { enabled: manual.enabled === true, target } };
}

function getManualDesktopOverride(overrides, agent) {
  const manual = overrides?.[agent]?.manualDesktop;
  return manual?.enabled === true && manual.target ? { ...manual } : null;
}
```

`saveLaunchOverride(agent, { enabled, target }, filePath)` 要创建父目录、读取当前归一化表、保留其他 Agent；`target` 为空时删除该 Agent，非空时写入对象格式。导出 `normalizeOverride` 和 `getManualDesktopOverride` 供测试/服务端使用。

- [ ] **Step 4: 运行存储测试**

Run: `node --test lib/launch.test.js`

Expected: 全部 PASS。

### Task 2: 新增统一自动启动目标解析模块

**Files:**
- Create: `lib/launch-targets.js`
- Create: `lib/launch-targets.test.js`

- [ ] **Step 1: 写自动目标解析测试**

测试模块导出的 `buildLaunchTargets` 和 `selectLaunchTarget`：

```js
const { buildLaunchTargets, selectLaunchTarget } = require('./launch-targets');

test('buildLaunchTargets 把探测到的 CLI 路径变成可点击目标', () => {
  const result = buildLaunchTargets({
    defs: { pi: { name: 'Pi Agent' } },
    probes: { pi: { installed: true, tier: 'cli', path: 'C:\\tools\\pi.cmd' } },
    desktop: { pi: { kind: 'path', available: true, value: 'C:\\Pi\\Pi.exe', detail: 'Pi.exe' } },
  });
  assert.deepEqual(result.pi.cli, {
    available: true, kind: 'path', value: 'C:\\tools\\pi.cmd', label: 'CLI', detail: 'pi.cmd',
  });
  assert.equal(result.pi.desktop.available, true);
});

test('buildLaunchTargets 对未命中的一端返回不可用目标，不影响另一端', () => {
  const result = buildLaunchTargets({
    defs: { codex: { name: 'Codex' } }, probes: { codex: { installed: false } },
    desktop: { codex: { kind: 'scheme', available: true, value: 'codex://', detail: 'codex:// 协议' } },
  });
  assert.equal(result.codex.cli.available, false);
  assert.equal(result.codex.desktop.available, true);
});

test('selectLaunchTarget 只允许 available 的 cli/desktop 目标', () => {
  const targets = { pi: { cli: { available: true, value: 'pi.cmd' }, desktop: { available: false } } };
  assert.equal(selectLaunchTarget(targets, 'pi', 'cli').value, 'pi.cmd');
  assert.throws(() => selectLaunchTarget(targets, 'pi', 'desktop'), /不可用/);
  assert.throws(() => selectLaunchTarget(targets, 'pi', 'other'), /启动方式/);
});
```

- [ ] **Step 2: 运行测试，确认模块尚不存在**

Run: `node --test lib/launch-targets.test.js`

Expected: FAIL，提示找不到 `./launch-targets`。

- [ ] **Step 3: 实现纯解析模块**

`buildLaunchTargets({ defs, probes, desktop })` 遍历 `defs` 的全部 Agent，始终生成 `cli` 和 `desktop` 两个对象：

- `probes[id].installed && probes[id].path` 时，CLI 为 `{ available:true, kind:'path', value:path, label:'CLI', detail:basename(path) }`；否则为 `{ available:false, kind:'path', label:'CLI', detail:'未找到 CLI' }`。
- `desktop[id]` 存在且 `available !== false` 时按传入值生成；不存在时为 `{ available:false, kind:'path', label:'桌面端', detail:'未找到桌面端' }`。
- 不向前端泄露未处理的 shell 参数；`value` 仅供服务端内部启动。

`selectLaunchTarget(targets, agent, target)` 检查 `target` 只能是 `cli` 或 `desktop`，Agent 存在且目标 `available === true`，否则抛出中文 `Error`。

- [ ] **Step 4: 运行目标解析测试**

Run: `node --test lib/launch-targets.test.js`

Expected: 全部 PASS。

### Task 3: 接入服务端自动目标、手动优先级和接口

**Files:**
- Modify: `server.js`
- Modify: `lib/launch.js`
- Modify: `lib/launch-targets.js`
- Create: `lib/launch-agent.test.js`

- [ ] **Step 1: 为服务端启动分支写优先级测试**

将可测试的 `launchCommand`、`resolveLaunchRequest` 或等价纯函数从 `server.js` 使用的模块导出，并写入：

```js
test('手动桌面端启用时，自动 CLI/桌面请求都被手动目标覆盖', () => {
  const manual = { manualDesktop: { enabled: true, target: 'C:\\Hermes\\Hermes.exe' } };
  assert.deepEqual(resolveLaunchRequest({ manual, requested: 'cli' }), {
    kind: 'manual', target: 'C:\\Hermes\\Hermes.exe',
  });
  assert.deepEqual(resolveLaunchRequest({ manual, requested: 'desktop' }), {
    kind: 'manual', target: 'C:\\Hermes\\Hermes.exe',
  });
});

test('手动关闭时恢复请求的自动目标', () => {
  assert.deepEqual(resolveLaunchRequest({
    manual: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
    requested: 'cli',
  }), { kind: 'automatic', target: 'cli' });
});
```

- [ ] **Step 2: 运行测试确认优先级函数尚未实现**

Run: `node --test lib/launch-agent.test.js`

Expected: FAIL，提示导出的优先级函数不存在。

- [ ] **Step 3: 在服务端声明桌面端自动目标映射**

用现有 `AGENT_DEFS` 和解析器生成 `desktop` 映射，不修改会话深链接：

- Claude Code：`claude://`；Codex：`codex://`；WorkBuddy：`workbuddy://`；
- DeepSeek Harness：复用 `stripQuotes(AGENT_DEFS.deepseek.launchCmd)`，仅当文件存在时标记可用；
- Marvis、ZCode：复用 `AGENT_DEFS[id].launch` 启动脚本，脚本存在时可用；
- Pi Agent：复用 `resolvePiAgentDesktopExe()`；Hermes Agent：复用 `resolveHermesDesktopExe()`；
- Windows 之外沿用现有平台分支，不能把 Windows 路径硬编码为唯一平台方案。

- [ ] **Step 4: 实现 `/api/launch-targets`**

路由调用 `getProbe()` 和 `buildLaunchTargets()`，把 `launchLib.loadLaunchOverrides()` 的 `manualDesktop` 合并到每个 Agent，返回：

```js
res.end(JSON.stringify({ targets }));
```

目标详情可以包含 `value` 供同机前端按钮回显，但不包含用户主目录之外的额外文件内容；手动目标只按存储状态返回。

- [ ] **Step 5: 重构 `launchOrFocus(agent, requestedTarget, cb)`**

启动顺序固定为：

1. 读取当前 Agent 的手动配置；`enabled === true && target` 非空时调用 `launchManualTarget(target)`，忽略 `requestedTarget`。
2. 否则 `requestedTarget` 为 `cli`/`desktop` 时调用 `selectLaunchTarget` 后启动该自动目标。
3. 否则保留现有“焦点窗口 / scheme / 默认 launch”逻辑，保证顶栏和会话卡片跳转不回归。

`launchManualTarget` 和 CLI 文件目标使用 `stdio:'ignore'`、`windowsHide:true`、`detached:true`。已存在的 exe 直接 `spawn(exe, [])`；`.cmd/.bat` 或非文件命令使用 `spawn('cmd.exe', ['/c', target])`。给 child 绑定一次 `error` 回调，把启动失败传回 `cb({ ok:false, error })`，避免无提示失败。

- [ ] **Step 6: 更新服务端 POST 接口**

`/api/launch-agent` 读取可选 `body.target`，只接受空值、`cli`、`desktop`；空值保持原有行为。路由在 `launchOrFocus` 回调中返回实际结果。

`/api/launch-overrides`：

- GET 返回归一化后的对象；
- POST 接收 `{ agent, enabled, target }`，兼容旧 `{ command }`：旧字段存在时转换为 `enabled = Boolean(command.trim())` 和 `target = command`；验证 Agent 后调用 `saveLaunchOverride`。

- [ ] **Step 7: 运行服务端相关测试**

Run: `node --test lib/launch.test.js lib/launch-targets.test.js lib/launch-agent.test.js`

Expected: 全部 PASS。

### Task 4: 改造模型端口设置前端

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Create: `public/launch-target-switcher.test.js`

- [ ] **Step 1: 写前端静态行为测试**

测试直接读取 `public/app.js` 和 `public/index.html`，断言存在：

```js
assert.match(app, /fetch\('\/api\/launch-targets'/);
assert.match(app, /manualDesktop/);
assert.match(app, /切换到 CLI/);
assert.match(app, /切换到桌面端/);
assert.match(app, /保存并切换到桌面端/);
assert.match(app, /target: 'cli'/);
assert.match(app, /target: 'desktop'/);
assert.match(app, /disabled/);
```

- [ ] **Step 2: 实现带 target 的启动请求**

把 `launchAgent(agent)` 改成 `launchAgent(agent, target = '')`，请求体只在 target 非空时增加 `target`，已有顶栏、会话卡片和抽屉调用不传 target，继续使用默认行为。

- [ ] **Step 3: 重写 `openLaunchOverridesManager()`**

加载 `/api/launch-targets`，按 `state.agentsDef` 全量渲染 Agent 卡片。每张卡片必须包含：

- Agent 图标、名称和状态圆点；
- CLI/桌面端自动目标详情；
- 两个自动按钮，未找到的按钮 `disabled`；
- `<input type="checkbox" class="lo-manual-enabled">` 位于“手动指定桌面端”文字前；
- `<input class="lo-input">` 显示手动目标；
- “保存并切换到桌面端”按钮。

勾选框 `change` 事件保存 `{ agent, enabled, target }`；保存成功后调用 `updateLaunchRowState`，勾选时禁用两个方法 1 按钮，取消时恢复。手动按钮在未勾选或目标为空时不可执行；点击时先 POST 保存，再调用 `launchAgent(id, 'desktop')`，服务端仍以手动优先级为最终裁决。

路径示例文案固定为：

```text
例如：C:\Users\Administrator\AppData\Local\Programs\DSH Desktop\DSH Desktop.exe
也可以填写 .cmd/.bat 或命令行
```

保存失败时恢复原 checkbox/input 状态并 toast 错误；GET 失败时显示加载失败，不渲染空表，避免误覆盖已有配置。

- [ ] **Step 4: 增加最小 CSS**

在 `public/index.html` 追加 `.lo-agent-row`、`.lo-target-actions`、`.lo-manual-block`、`.lo-status` 等样式，复用现有 `var(--border)`、`var(--accent)` 和按钮风格；设置面板宽度在窄屏使用 `max-width:calc(100vw - 24px)`，内部列表独立滚动。

- [ ] **Step 5: 运行前端静态测试和语法检查**

Run: `node --test public/launch-target-switcher.test.js`

Run: `node -e "new Function(require('fs').readFileSync('public/app.js','utf8')); console.log('SYNTAX OK')"`

Expected: 测试 PASS，输出 `SYNTAX OK`。

### Task 5: 全量验证与人工验收

**Files:**
- Modify: `public/launch-target-switcher.test.js` only if a concrete assertion fails
- Modify: `lib/*.test.js` only if a concrete regression test needs correction

- [ ] **Step 1: 运行完整测试套件**

Run: `node --test`

Expected: 0 failures。

- [ ] **Step 2: 启动本地 Agent Board 并打开设置**

Run: `node server.js`

打开 `http://127.0.0.1:4876`，进入“设置 → 模型端口设置”，确认 8 个 Agent 都出现，自动目标详情来自后端而不是硬编码到输入框。

- [ ] **Step 3: 验证方法 1**

在未勾选手动方式时，点击一个可用 CLI 和一个可用桌面端，确认请求体分别包含 `target: 'cli'` 和 `target: 'desktop'`；不可用按钮不可点击；只有一端可用的 Agent 不会伪造另一端。

- [ ] **Step 4: 验证方法 2 优先级**

以 Hermes Agent 为例，勾选“手动指定桌面端”，填入可验证的本机程序路径，点击“保存并切换到桌面端”，确认只执行手动目标；点击方法 1 按钮应保持禁用。

- [ ] **Step 5: 验证取消后恢复自动方式**

取消勾选，确认手动目标仍回显但方法 1 按钮恢复可用；再次点击自动按钮，确认执行自动目标；清空目标并保存，确认该 Agent 恢复空手动配置。

- [ ] **Step 6: 检查工作区并交付**

Run: `git status --short`

确认只报告本次相关文件和用户原有未提交修改；不执行 reset、push、部署或删除用户配置。
