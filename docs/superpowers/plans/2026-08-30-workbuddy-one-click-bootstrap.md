# WorkBuddy One-Click Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户安装并启动 Agent Board EXE 后，自动把内置的 WorkBuddy 监控插件安装、登记并启用到当前用户配置，不要求用户手动安装插件或配置 HTTP Hook。

**Architecture:** 复用现有 `lib/workbuddy-plugin.js` 的检测逻辑，增加一个幂等的本地 bootstrap：从打包资源复制插件到 `%USERPROFILE%\\.workbuddy\\plugins\\cache\\agent-board\\agent-board-workbuddy\\<version>`，安全合并 `installed_plugins.json` 和 `settings.json`，保留其它 WorkBuddy 配置。桌面端在启动后端前执行 bootstrap，失败只记录诊断并继续启动，以免监控插件问题阻断 Agent Board 主程序；后端已有的 loopback HTTP Hook 配置继续由后端启动时生成。

**Tech Stack:** Electron 44, Node.js filesystem APIs, electron-builder `extraResources`, Node built-in test runner.

---

### Task 1: 实现幂等的 WorkBuddy 插件 bootstrap

**Files:**
- Modify: `lib/workbuddy-plugin.js`
- Test: `lib/workbuddy-plugin.test.js`

- [x] **Step 1: 写失败测试**

在 `lib/workbuddy-plugin.test.js` 新增测试，验证临时用户目录中：插件目录被复制、`installed_plugins.json` 登记 `agent-board-workbuddy@agent-board`、`settings.json` 启用该插件且保留既有字段；再次执行不重复登记。

```js
test('bootstrap 自动安装并启用插件且保留用户配置', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-bootstrap-'));
  const source = path.join(home, 'source-plugin');
  try {
    fs.mkdirSync(path.join(source, '.codebuddy-plugin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(source, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({
      name: 'agent-board-workbuddy', version: '1.0.0', hooks: './hooks/hooks.json',
    }));
    fs.writeFileSync(path.join(source, 'scripts', 'status-hook.mjs'), 'updated');
    fs.mkdirSync(path.join(home, '.workbuddy', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.workbuddy', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'existing@plugin': true }, customSetting: 'keep',
    }));

    const result = installWorkBuddyPlugin({ sourcePath: source, homedir: home });
    assert.equal(result.ok, true);
    assert.equal(result.enabled, true);
    assert.equal(fs.readFileSync(path.join(result.installPath, 'scripts', 'status-hook.mjs'), 'utf8'), 'updated');
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'settings.json'), 'utf8'));
    assert.equal(settings.customSetting, 'keep');
    assert.equal(settings.enabledPlugins['existing@plugin'], true);
    assert.equal(settings.enabledPlugins['agent-board-workbuddy@agent-board'], true);
    const registry = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'plugins', 'installed_plugins.json'), 'utf8'));
    assert.equal(registry.plugins['agent-board-workbuddy@agent-board'].length, 1);

    installWorkBuddyPlugin({ sourcePath: source, homedir: home });
    const secondRegistry = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'plugins', 'installed_plugins.json'), 'utf8'));
    assert.equal(secondRegistry.plugins['agent-board-workbuddy@agent-board'].length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: 运行测试确认按预期失败**

运行：`node --test lib/workbuddy-plugin.test.js`

预期：失败，提示 `installWorkBuddyPlugin is not defined` 或导出缺失。

- [x] **Step 3: 实现最小 bootstrap**

在 `lib/workbuddy-plugin.js` 增加：

```js
const PLUGIN_KEY = `${PLUGIN_NAME}@agent-board`;

function installWorkBuddyPlugin({ sourcePath, homedir = os.homedir(), fsApi = fs, now = () => new Date() } = {}) {
  const manifest = manifestAt(sourcePath, fsApi);
  if (!manifest) return { ok: false, installed: false, enabled: false, error: '插件资源缺失或 manifest 无效' };
  const version = String(manifest.manifest.version || '1.0.0');
  const workbuddyDir = path.join(homedir, '.workbuddy');
  const pluginsDir = path.join(workbuddyDir, 'plugins');
  const installPath = path.join(pluginsDir, 'cache', 'agent-board', PLUGIN_NAME, version);
  fsApi.mkdirSync(path.dirname(installPath), { recursive: true });
  fsApi.cpSync(sourcePath, installPath, { recursive: true, force: true });

  const installedPath = path.join(pluginsDir, 'installed_plugins.json');
  const installed = readJson(installedPath, fsApi) || { version: 2, plugins: {} };
  installed.version = 2;
  installed.plugins = installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : {};
  const previous = Array.isArray(installed.plugins[PLUGIN_KEY]) ? installed.plugins[PLUGIN_KEY] : [];
  const previousRecord = previous.find((record) => record?.installPath === installPath) || {};
  installed.plugins[PLUGIN_KEY] = [{
    ...previousRecord,
    scope: 'user', installPath, version,
    installedAt: previousRecord.installedAt || now().toISOString(),
    lastUpdated: now().toISOString(),
  }, ...previous.filter((record) => record?.installPath !== installPath)];
  fsApi.writeFileSync(installedPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');

  const settingsPath = path.join(workbuddyDir, 'settings.json');
  const settings = readJson(settingsPath, fsApi) || {};
  settings.enabledPlugins = settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
    ? settings.enabledPlugins : {};
  settings.enabledPlugins[PLUGIN_KEY] = true;
  fsApi.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { ok: true, installed: true, enabled: true, version, installPath, pluginKey: PLUGIN_KEY };
}
```

实现时保留既有检测逻辑，并对不存在的配置目录创建目录；配置中的其它插件和字段不能丢失。

- [x] **Step 4: 运行测试确认通过**

运行：`node --test lib/workbuddy-plugin.test.js`

预期：该文件全部 PASS。

### Task 2: 将插件资源放入安装包并接入桌面启动

**Files:**
- Modify: `desktop/paths.js`
- Test: `desktop/paths.test.js`
- Modify: `package.json`
- Modify: `desktop/main.js`

- [x] **Step 1: 写失败测试**

在 `desktop/paths.test.js` 增加打包路径断言：打包态返回 `resources/integrations/agent-board-workbuddy`，开发态返回仓库 integrations 目录。

```js
test('解析 WorkBuddy 插件资源路径', () => {
  const packaged = resolveDesktopPaths({ packaged: true, resourcesPath: 'C:\\App\\resources', homedir: 'C:\\Users\\test' });
  assert.equal(packaged.workbuddyPluginSource, path.join('C:\\App\\resources', 'integrations', 'agent-board-workbuddy'));
  const development = resolveDesktopPaths({ packaged: false, projectRoot: 'C:\\work\\agent-board', homedir: 'C:\\Users\\test' });
  assert.equal(development.workbuddyPluginSource, path.join('C:\\work\\agent-board', 'integrations', 'agent-board-workbuddy'));
});
```

- [x] **Step 2: 运行测试确认按预期失败**

运行：`node --test desktop/paths.test.js`

预期：失败，`workbuddyPluginSource` 为 `undefined`。

- [x] **Step 3: 实现资源路径、打包资源和启动 bootstrap**

在 `desktop/paths.js` 返回 `workbuddyPluginSource`；在 `package.json` 的 `build.files` 加入 `lib/workbuddy-plugin.js`，在 `extraResources` 加入：

```json
{ "from": "integrations/agent-board-workbuddy", "to": "integrations/agent-board-workbuddy" }
```

在 `desktop/main.js` 启动时调用：

```js
const { installWorkBuddyPlugin } = require('../lib/workbuddy-plugin');

function bootstrapWorkBuddyPlugin(paths) {
  const result = installWorkBuddyPlugin({ sourcePath: paths.workbuddyPluginSource });
  if (!result.ok) writeDesktopLog(`WorkBuddy 插件自动初始化失败：${result.error}`);
  else writeDesktopLog(`WorkBuddy 插件已自动初始化：${result.installPath}`);
}
```

调用位置放在检查资源存在之后、后端启动之前；bootstrap 失败只记录日志，不阻断 Agent Board 启动。

- [x] **Step 4: 运行路径和插件契约测试**

运行：`node --test desktop/paths.test.js lib/workbuddy-plugin.test.js integrations/agent-board-workbuddy/plugin-contract.test.mjs`

预期：全部 PASS。

### Task 3: 完整验证并重新打包 main EXE

**Files:**
- Modify: `tools/verify-package.js`
- Test: `tools/verify-package.test.js`

- [x] **Step 1: 写失败测试**

扩展打包验证，要求解包目录存在 `resources/integrations/agent-board-workbuddy/.codebuddy-plugin/plugin.json` 和 `scripts/status-hook.mjs`。

- [x] **Step 2: 运行验证确认缺少资源时失败**

运行：`node --test tools/verify-package.test.js`

预期：新增断言在旧包或未打包资源时失败。

- [x] **Step 3: 实现打包验证**

在 `tools/verify-package.js` 的 required 列表中加入上述两个插件文件，并保持现有机器路径泄漏检查。

- [x] **Step 4: 运行全量测试和打包**

运行：`npm test`

预期：全部测试通过。

然后运行：`npm run desktop:dist -- --config.directories.output=dist-one-click-<timestamp>`（使用实际时间戳目录）以及 `npm run desktop:verify -- dist-one-click-<timestamp>/win-unpacked`。

预期：electron-builder 退出码为 0，打包验证通过，安装包内包含插件资源；在隔离临时用户目录中直接调用 bootstrap 测试安装、登记和启用流程。

备注：全量 `npm test` 共 819 项中通过 816 项、跳过 1 项；2 项既有 AI 路由前端契约测试因工作区原有未提交路由改动失败，与本次 WorkBuddy bootstrap 改动无关。变更相关定向测试 17/17 通过。
