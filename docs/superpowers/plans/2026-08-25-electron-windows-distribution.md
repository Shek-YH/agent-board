# Windows Electron 分发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax '- [ ]' for tracking.

**Goal:** 将 Agent Board 打包为 Windows 单用户 Electron 安装包，安装包自带 Node.js，后端以独立子进程运行，普通用户无需预装 Node/Python 即可启动看板。

**Architecture:** Electron 主进程负责单实例、窗口、托盘和后端生命周期；后端继续使用现有 server.js，由安装包内的固定 node.exe 作为独立子进程启动。后端和用户数据放在 Electron 资源目录与 %LOCALAPPDATA%\AgentBoard 两个分离位置，前端继续通过本地 HTTP/SSE 服务运行。

**Tech Stack:** Node.js 22.22.2（后端运行时）、Electron 44.0.0、electron-builder 26.15.3、Windows NSIS、Node 内置 node:test、Node 内置 zstd 解压。

---

## 文件结构与职责

本计划涉及的新增/修改文件如下：

| 文件 | 职责 |
|---|---|
| lib/runtime-paths.js | 统一解析本地数据目录和用户配置目录 |
| lib/runtime-paths.test.js | 验证环境变量覆盖和默认路径 |
| lib/focus-dll-path.js | 解析预编译窗口激活 DLL 的路径 |
| lib/focus-dll-path.test.js | 验证打包资源、环境变量和开发回退路径 |
| lib/deepseek-desktop-path.js | 解析 DeepSeek Desktop 可执行文件 |
| lib/deepseek-desktop-path.test.js | 验证 DeepSeek Desktop 路径候选顺序 |
| desktop/paths.js | 区分开发态和打包态资源路径 |
| desktop/paths.test.js | 验证后端入口和内置 Node 路径 |
| desktop/port.js | 选择 4876 或备用回环端口 |
| desktop/port.test.js | 验证端口选择和回退 |
| desktop/backend-process.js | 构造和管理后端 Node 子进程 |
| desktop/backend-process.test.js | 验证子进程命令、环境变量和停止行为 |
| desktop/main.js | Electron 主进程：单实例、窗口、托盘和退出 |
| desktop/icon.png | 复用现有 Agent Board 图标作为 Electron/NSIS 图标 |
| tools/build-focus-dll.ps1 | 构建发布态预编译 wf.dll |
| tools/verify-package.js | 检查打包输出资源和开发机路径泄漏 |
| tools/prepare-runtime.ps1 | 从固定 Node 发行目录准备 runtime/node.exe |
| runtime/node.exe | 构建输入，不提交到 Git，由准备脚本生成 |
| package.json | Electron 开发命令、依赖和 electron-builder 配置 |
| server.js | 使用动态资源路径、焦点 DLL 和 Agent 启动路径 |
| lib/store.js | 使用统一数据目录解析 |
| lib/launch.js | 使用统一用户配置目录解析 |
| lib/detect.js | 使用统一用户配置目录解析 |
| lib/adapters/deepseek.js | 使用 Node 内置 zstd，移除 Python 运行时依赖 |
| README.md | 增加桌面开发、构建和用户安装说明 |

现有 .gitignore、public/sounds/sound-settings.json 的用户修改不能被本计划覆盖或提交。

### Task 1: 统一本地数据和配置路径

**Files:**
- Create: lib/runtime-paths.test.js
- Create: lib/runtime-paths.js
- Modify: lib/store.js:5-12
- Modify: lib/launch.js:5-13
- Modify: lib/detect.js:5-12

- [ ] **Step 1: Write the failing path tests**

~~~
'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getDataDir, getConfigDir } = require('./runtime-paths');

test('getDataDir 默认使用用户 LocalAppData 目录', () => {
  assert.equal(
    getDataDir({ env: {}, homedir: 'C:\\Users\\test' }),
    path.join('C:\\Users\\test', 'AppData', 'Local', 'AgentBoard'),
  );
});

test('getDataDir 使用 AB_DATA_DIR 覆盖默认目录', () => {
  assert.equal(
    getDataDir({ env: { AB_DATA_DIR: 'D:\\AgentBoardData' }, homedir: 'C:\\Users\\test' }),
    path.resolve('D:\\AgentBoardData'),
  );
});

test('getConfigDir 默认使用用户 .agent-board 目录', () => {
  assert.equal(
    getConfigDir({ env: {}, homedir: 'C:\\Users\\test' }),
    path.join('C:\\Users\\test', '.agent-board'),
  );
});

test('getConfigDir 使用 AB_CONFIG_DIR 覆盖默认目录', () => {
  assert.equal(
    getConfigDir({ env: { AB_CONFIG_DIR: 'D:\\AgentBoardConfig' }, homedir: 'C:\\Users\\test' }),
    path.resolve('D:\\AgentBoardConfig'),
  );
});

test('空白环境变量不会覆盖默认目录', () => {
  assert.equal(
    getDataDir({ env: { AB_DATA_DIR: '   ' }, homedir: os.homedir() }),
    path.join(os.homedir(), 'AppData', 'Local', 'AgentBoard'),
  );
});
~~~

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: node --test lib/runtime-paths.test.js

Expected: FAIL with Cannot find module './runtime-paths'.

- [ ] **Step 3: Implement the shared path module**

~~~
'use strict';

const os = require('node:os');
const path = require('node:path');

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getDataDir({ env = process.env, homedir = os.homedir() } = {}) {
  return path.resolve(nonBlank(env.AB_DATA_DIR) || path.join(homedir, 'AppData', 'Local', 'AgentBoard'));
}

function getConfigDir({ env = process.env, homedir = os.homedir() } = {}) {
  return path.resolve(nonBlank(env.AB_CONFIG_DIR) || path.join(homedir, '.agent-board'));
}

module.exports = { getDataDir, getConfigDir };
~~~

- [ ] **Step 4: Replace the duplicated path constants**

In lib/store.js, replace the os-based DATA_DIR declaration with:

~~~
const { getDataDir } = require('./runtime-paths');
const DATA_DIR = getDataDir();
const DATA_PATH = path.join(DATA_DIR, 'data.json');
~~~

In lib/launch.js and lib/detect.js, use getConfigDir() for launch-overrides.json and tool-paths.json respectively. Keep their optional explicit path arguments unchanged so existing tests remain isolated.

- [ ] **Step 5: Run the focused and regression tests**

Run: node --test lib/runtime-paths.test.js lib/launch.test.js lib/detect.test.js

Expected: PASS. The default data path remains %USERPROFILE%\AppData\Local\AgentBoard; explicit test paths still work.

- [ ] **Step 6: Commit the path boundary**

~~~
git add lib/runtime-paths.js lib/runtime-paths.test.js lib/store.js lib/launch.js lib/detect.js
git commit -m "refactor: 统一 Agent Board 用户目录解析"
~~~

### Task 2: Remove the DeepSeek Python runtime dependency

**Files:**
- Create: lib/adapters/deepseek.test.js
- Modify: lib/adapters/deepseek.js:4-24,44-61,272

- [ ] **Step 1: Write a real zstd round-trip test**

~~~
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const test = require('node:test');
const deepseek = require('./deepseek');

test('DeepSeek tailRead 使用 Node 内置 zstd 解压，不依赖 Python', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-deepseek-'));
  const file = path.join(dir, 'session.jsonl.zstd');
  const source = [
    JSON.stringify({ type: 'session', id: 'session-test', cwd: 'D:\\work' }),
    JSON.stringify({ type: 'message', id: 'msg-1', role: 'user', content: 'hello' }),
    '',
  ].join('\n');
  fs.writeFileSync(file, zstdCompressSync(Buffer.from(source, 'utf8')));

  const result = deepseek.tailRead(file, 0);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].id, 'session-test');
  assert.equal(result.lines[1].content, 'hello');
});
~~~

- [ ] **Step 2: Run the test and verify the current implementation fails**

Run: node --test lib/adapters/deepseek.test.js

Expected: FAIL because the current adapter tries to execute the current user's WorkBuddy Python path and returns no lines in an environment without that interpreter.

- [ ] **Step 3: Replace Python decompression with Node zstd**

In lib/adapters/deepseek.js:

~~~
const { zstdDecompressSync } = require('node:zlib');
~~~

Replace PYTHON, DECOMPRESSOR and the spawnSync implementation with:

~~~
function decompress(file) {
  try {
    return zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
  } catch (e) {
    console.error('[' + ID + '] decompress failed for ' + file + ':', e.message);
    return '';
  }
}
~~~

Update the scan comments to say that zstd is decoded by the Node runtime, not Python. Keep tailRead and all parsing behavior unchanged.

- [ ] **Step 4: Run the adapter and complete test suite**

Run: node --test lib/adapters/deepseek.test.js

Expected: PASS.

Run: node --test

Expected: PASS with no new failures.

- [ ] **Step 5: Commit the self-contained decoder**

~~~
git add lib/adapters/deepseek.js lib/adapters/deepseek.test.js
git commit -m "fix: 用 Node 内置 zstd 解压 DeepSeek 会话"
~~~

### Task 3: Remove current-machine executable paths

**Files:**
- Create: lib/deepseek-desktop-path.js
- Create: lib/deepseek-desktop-path.test.js
- Create: lib/focus-dll-path.js
- Create: lib/focus-dll-path.test.js
- Modify: server.js:14-23,40-51,139-160,735-747

- [ ] **Step 1: Write path resolver tests**

Use the existing pi-agent-desktop-path.test.js pattern for DeepSeek:

~~~
const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveDeepSeekDesktopExe } = require('./deepseek-desktop-path');

test('DeepSeek Desktop 优先使用环境变量路径', () => {
  const result = resolveDeepSeekDesktopExe({
    env: { DEEPSEEK_DESKTOP_EXE: 'D:\\Apps\\DSH Desktop.exe' },
    homedir: 'C:\\Users\\test',
    existsSync: file => file === 'D:\\Apps\\DSH Desktop.exe',
  });
  assert.equal(result, 'D:\\Apps\\DSH Desktop.exe');
});

test('DeepSeek Desktop 回退到用户默认安装路径', () => {
  const home = 'C:\\Users\\test';
  const result = resolveDeepSeekDesktopExe({
    env: {},
    homedir: home,
    existsSync: file => file.endsWith('DSH Desktop\\DSH Desktop.exe'),
  });
  assert.equal(result, home + '\\AppData\\Local\\Programs\\DSH Desktop\\DSH Desktop.exe');
});
~~~

For focus-dll-path.test.js, cover three cases: AGENT_BOARD_FOCUS_DLL, an existing bundled tools/wf.dll, and the user config fallback when neither exists.

- [ ] **Step 2: Run the new tests and verify missing-module failures**

Run: node --test lib/deepseek-desktop-path.test.js lib/focus-dll-path.test.js

Expected: FAIL with missing module errors.

- [ ] **Step 3: Implement the resolvers**

lib/deepseek-desktop-path.js:

~~~
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveDeepSeekDesktopExe({ env = process.env, homedir = os.homedir(), existsSync = fs.existsSync } = {}) {
  const candidates = [
    env.DEEPSEEK_DESKTOP_EXE,
    path.join(homedir, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe'),
  ].filter(Boolean);
  return candidates.find(file => existsSync(file)) || candidates[candidates.length - 1];
}

module.exports = { resolveDeepSeekDesktopExe };
~~~

lib/focus-dll-path.js:

~~~
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getConfigDir } = require('./runtime-paths');

function resolveFocusDll({ env = process.env, backendDir, existsSync = fs.existsSync } = {}) {
  if (env.AGENT_BOARD_FOCUS_DLL) return env.AGENT_BOARD_FOCUS_DLL;
  const bundled = path.join(backendDir, 'tools', 'wf.dll');
  return existsSync(bundled) ? bundled : path.join(getConfigDir({ env }), 'wf.dll');
}

module.exports = { resolveFocusDll };
~~~

- [ ] **Step 4: Wire the resolvers into server.js**

Make these exact changes:

1. Import resolveDeepSeekDesktopExe, resolveFocusDll and getConfigDir.
2. Change DeepSeek's launchCmd from the current absolute string to null, then add a DeepSeek branch that calls resolveDeepSeekDesktopExe() and starts the returned executable.
3. Change Marvis and ZCode launch values to path.join(__dirname, 'marvis-launch.bat') and path.join(__dirname, 'zcode-launch.bat').
4. Replace FOCUS_DLL with resolveFocusDll({ backendDir: __dirname }).
5. In the dynamic fallback PowerShell command, use path.dirname(FOCUS_DLL) rather than embedding $env:USERPROFILE\\.agent-board; create the directory before Add-Type when the bundled DLL is absent.
6. Replace the DeepSeek session-opening absolute path with resolveDeepSeekDesktopExe().

The normal Windows built-ins cmd.exe, powershell.exe, reg.exe and tasklist.exe remain allowed runtime dependencies; they are part of the Windows target and are not external application installs.

- [ ] **Step 5: Run resolver and server regression tests**

Run: node --test lib/deepseek-desktop-path.test.js lib/focus-dll-path.test.js server-account.test.js server-sound-security.test.js

Expected: PASS. Use rg -n "C:\\\\Users\\\\Administrator\\\\WorkBuddy|C:\\\\Users\\\\Administrator\\\\AppData" server.js lib to confirm no current-machine absolute executable path remains in runtime code.

- [ ] **Step 6: Commit the path cleanup**

~~~
git add server.js lib/deepseek-desktop-path.js lib/deepseek-desktop-path.test.js lib/focus-dll-path.js lib/focus-dll-path.test.js
git commit -m "fix: 移除 Agent Board 发布路径硬编码"
~~~

### Task 4: Add tested Electron resource and backend-process helpers

**Files:**
- Create: desktop/paths.js
- Create: desktop/paths.test.js
- Create: desktop/backend-process.js
- Create: desktop/backend-process.test.js

- [ ] **Step 1: Write resource path tests**

~~~
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { resolveDesktopPaths } = require('./paths');

test('开发态使用仓库里的 server.js 和当前 Node', () => {
  const result = resolveDesktopPaths({
    packaged: false,
    projectRoot: 'C:\\work\\agent-board',
    env: { AGENT_BOARD_NODE_RUNTIME: 'D:\\node.exe' },
    homedir: 'C:\\Users\\test',
  });
  assert.equal(result.backendEntry, path.join('C:\\work\\agent-board', 'server.js'));
  assert.equal(result.nodeRuntime, 'D:\\node.exe');
  assert.equal(result.dataDir, path.join('C:\\Users\\test', 'AppData', 'Local', 'AgentBoard'));
});

test('打包态使用 resources/backend 和 resources/runtime', () => {
  const result = resolveDesktopPaths({
    packaged: true,
    resourcesPath: 'C:\\App\\resources',
    env: { AB_DATA_DIR: 'D:\\AgentBoardData' },
    homedir: 'C:\\Users\\test',
  });
  assert.equal(result.backendEntry, path.join('C:\\App\\resources', 'backend', 'server.js'));
  assert.equal(result.nodeRuntime, path.join('C:\\App\\resources', 'runtime', 'node.exe'));
  assert.equal(result.dataDir, path.resolve('D:\\AgentBoardData'));
});
~~~

- [ ] **Step 2: Write backend command tests**

~~~
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { buildBackendLaunch } = require('./backend-process');

test('buildBackendLaunch 传递端口、数据目录和 desktop 标记', () => {
  const result = buildBackendLaunch({
    nodeRuntime: 'C:\\App\\resources\\runtime\\node.exe',
    backendEntry: 'C:\\App\\resources\\backend\\server.js',
    port: 49123,
    dataDir: 'D:\\AgentBoardData',
    env: { PATH: 'test-path' },
  });
  assert.equal(result.command, 'C:\\App\\resources\\runtime\\node.exe');
  assert.deepEqual(result.args, ['C:\\App\\resources\\backend\\server.js']);
  assert.equal(result.options.cwd, path.dirname(result.args[0]));
  assert.equal(result.options.windowsHide, true);
  assert.equal(result.options.env.AB_PORT, '49123');
  assert.equal(result.options.env.AB_DATA_DIR, 'D:\\AgentBoardData');
  assert.equal(result.options.env.AB_RUNTIME, 'desktop');
});
~~~

- [ ] **Step 3: Run focused tests and verify missing-module failures**

Run: node --test desktop/paths.test.js desktop/backend-process.test.js

Expected: FAIL with missing module errors.

- [ ] **Step 4: Implement resource resolution and command construction**

desktop/paths.js must expose resolveDesktopPaths({ packaged, resourcesPath, projectRoot, env, homedir }), returning { backendEntry, nodeRuntime, backendRoot, dataDir }. In development, nodeRuntime is env.AGENT_BOARD_NODE_RUNTIME || process.execPath; in packaged mode it is always path.join(resourcesPath, 'runtime', 'node.exe'). dataDir is env.AB_DATA_DIR when non-blank, otherwise path.join(homedir, 'AppData', 'Local', 'AgentBoard').

desktop/backend-process.js must expose:

~~~
function buildBackendLaunch({ nodeRuntime, backendEntry, port, dataDir, env = process.env }) {
  return {
    command: nodeRuntime,
    args: [backendEntry],
    options: {
      cwd: path.dirname(backendEntry),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, AB_PORT: String(port), AB_DATA_DIR: dataDir, AB_RUNTIME: 'desktop' },
    },
  };
}
~~~

Also expose startBackend(options, spawnImpl = spawn), waitForBackend(port, options) and stopBackend(child, { timeoutMs = 2000 }). waitForBackend polls GET /api/state on 127.0.0.1 until it receives HTTP 200 or the timeout expires. stopBackend sends SIGTERM, resolves on exit, and sends SIGKILL after the timeout if the child remains alive. This keeps desktop/main.js independent from backend-only modules under lib/.

- [ ] **Step 5: Run the helper tests**

Run: node --test desktop/paths.test.js desktop/backend-process.test.js

Expected: PASS.

- [ ] **Step 6: Commit the tested desktop helpers**

~~~
git add desktop/paths.js desktop/paths.test.js desktop/backend-process.js desktop/backend-process.test.js
git commit -m "feat: 增加 Electron 后端进程管理基础模块"
~~~

### Task 5: Implement the Electron main process

**Files:**
- Create: desktop/main.js
- Create: desktop/icon.png by copying logo/Square_app_icon__rounded_corne_2026-08-20T17-52-06.png

- [ ] **Step 1: Keep main-process side effects behind tested helpers**

Use resolveDesktopPaths, buildBackendLaunch, startBackend, waitForBackend and stopBackend. The main file must not duplicate path or command construction and must not require backend-only modules from lib/.

- [ ] **Step 2: Implement single-instance startup**

The beginning of desktop/main.js must follow this behavior:

~~~
const { app, BrowserWindow, Menu, Tray, dialog, shell } = require('electron');
const path = require('node:path');
const { resolveDesktopPaths } = require('./paths');
const { buildBackendLaunch, startBackend, waitForBackend, stopBackend } = require('./backend-process');
const { findAvailablePort } = require('./port');

let mainWindow = null;
let tray = null;
let backend = null;
let quitting = false;
let localUrl = '';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.whenReady().then(startApplication).catch(error => showStartupError(error));
}
~~~

Add desktop/port.js and desktop/port.test.js in this task. findAvailablePort must try 4876 first and then bind port 0 on 127.0.0.1, returning the actual port after closing the probe socket.

startApplication must select a port, start the backend child, wait up to 20 seconds for /api/state, create the window and then create the tray.

The core startup sequence is:

~~~
async function startApplication() {
  const paths = resolveDesktopPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: app.getAppPath(),
    env: process.env,
  });
  const port = await findAvailablePort({ preferredPort: 4876 });
  const launch = buildBackendLaunch({
    nodeRuntime: paths.nodeRuntime,
    backendEntry: paths.backendEntry,
    port,
    dataDir: paths.dataDir,
    env: process.env,
  });
  backend = startBackend(launch);
  backend.child.stdout.on('data', chunk => writeDesktopLog(chunk.toString()));
  backend.child.stderr.on('data', chunk => writeDesktopLog(chunk.toString()));
  if (!(await waitForBackend(port, { timeoutMs: 20000 }))) {
    throw new Error('Agent Board 后端启动超时：' + paths.backendEntry);
  }
  localUrl = 'http://127.0.0.1:' + port;
  createMainWindow();
  createTray();
}
~~~

- [ ] **Step 3: Implement the secure BrowserWindow**

Create the window with:

~~~
mainWindow = new BrowserWindow({
  width: 1440,
  height: 960,
  minWidth: 1000,
  minHeight: 680,
  show: false,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
});
~~~

Load only localUrl. Use setWindowOpenHandler and will-navigate to send non-local URLs to shell.openExternal and deny in-app navigation. On ready-to-show, call show().

- [ ] **Step 4: Implement tray and close behavior**

The tray menu must contain:

- “打开 Agent Board”：show and focus the window;
- “重启后端”：stop the current child and start it again on the same local URL contract;
- “退出”：set quitting = true, stop the child, destroy the tray and quit Electron.

When mainWindow emits close and quitting is false, call event.preventDefault() and mainWindow.hide().

- [ ] **Step 5: Implement startup failure handling**

If the Node runtime, backend entry, child process, health check or window creation fails, show a native dialog with the path and error message, write the same message to desktop.log under app.getPath('logs'), stop any partially started child and quit. Do not silently start a second backend.

- [ ] **Step 6: Run the development smoke test**

Run: npm run desktop:dev

Expected: one Electron window opens to the current board, no console window appears, closing the window hides it and the tray menu restores it.

- [ ] **Step 7: Commit the Electron shell**

~~~
git add desktop/main.js desktop/port.js desktop/port.test.js desktop/icon.png
git commit -m "feat: 增加 Agent Board Electron 桌面壳"
~~~

### Task 6: Configure the single-user NSIS build and runtime assets

**Files:**
- Modify: package.json
- Create: tools/prepare-runtime.ps1
- Create: tools/build-focus-dll.ps1
- Create: tools/verify-package.js
- Create: runtime/node.exe as a local build artifact only
- Modify: .gitignore only if needed to ignore runtime/node.exe; preserve existing user additions

- [ ] **Step 1: Add Electron scripts and pinned build dependencies**

Update package.json to keep the existing server commands and add:

~~~
{
  "main": "desktop/main.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test",
    "desktop:dev": "electron .",
    "desktop:dist": "electron-builder --win nsis",
    "desktop:verify": "node tools/verify-package.js dist/win-unpacked"
  },
  "devDependencies": {
    "electron": "44.0.0",
    "electron-builder": "26.15.3"
  }
}
~~~

Keep dependencies empty because the backend must remain Node built-in-only.

- [ ] **Step 2: Add electron-builder resource allowlists**

Add this build configuration to package.json:

~~~
{
  "build": {
    "appId": "com.agentboard.desktop",
    "productName": "Agent Board",
    "directories": { "output": "dist", "buildResources": "desktop" },
    "files": ["desktop/**/*", "package.json", "LICENSE"],
    "extraResources": [
      { "from": "server.js", "to": "backend/server.js" },
      { "from": "lib", "to": "backend/lib", "filter": ["**/*.js", "!**/*.test.js"] },
      { "from": "public", "to": "backend/public", "filter": ["**/*", "!**/*.test.js"] },
      { "from": "marvis-launch.bat", "to": "backend/marvis-launch.bat" },
      { "from": "zcode-launch.bat", "to": "backend/zcode-launch.bat" },
      { "from": "tools/wf.dll", "to": "backend/tools/wf.dll" },
      { "from": "runtime/node.exe", "to": "runtime/node.exe" }
    ],
    "win": { "target": [{ "target": "nsis", "arch": ["x64"] }], "icon": "desktop/icon.png" },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "runAfterFinish": true
    }
  }
}
~~~

The backend allowlist must include runtime sound assets and uploaded sound configuration while excluding all *.test.js, docs and backup files.

- [ ] **Step 3: Prepare the fixed Node runtime**

tools/prepare-runtime.ps1 must copy the pinned runtime and fail clearly when the source is absent:

~~~
param(
  [string]$Source = "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2\node.exe",
  [string]$Destination = "$PSScriptRoot\..\runtime\node.exe"
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "Node 22.22.2 runtime not found: $Source"
}
$destinationDir = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
Copy-Item -LiteralPath $Source -Destination $Destination -Force
Write-Output "Prepared $Destination"
~~~

Run before packaging:

~~~
powershell -NoProfile -ExecutionPolicy Bypass -File tools/prepare-runtime.ps1
~~~

The generated runtime/node.exe remains ignored and is not committed.

- [ ] **Step 4: Build the precompiled focus DLL**

tools/build-focus-dll.ps1 must compile the existing FOCUS_CS Win32 interop source to tools/wf.dll with PowerShell Add-Type, and fail when compilation fails. Use this exact script body so the release DLL has the same API as the current server-side focus code:

~~~powershell
$ErrorActionPreference = 'Stop'
$output = Join-Path $PSScriptRoot 'wf.dll'
$source = @'
using System;
using System.Runtime.InteropServices;
public class WF {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte s, uint f, UIntPtr e);
}
'@
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
Add-Type -TypeDefinition $source -OutputAssembly $output
if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw "wf.dll was not generated: $output" }
Write-Output "Built $output"
~~~

The script writes only the generated DLL and never runs during the installed application.

Run:

~~~
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-focus-dll.ps1
~~~

- [ ] **Step 5: Install build dependencies and run development smoke**

Run: npm install

Expected: electron and electron-builder are installed as dev dependencies; the backend dependencies section remains empty.

Run: npm run desktop:dev

Expected: the Electron smoke test from Task 5 succeeds.

- [ ] **Step 6: Build the unsigned installer**

Run:

~~~
powershell -NoProfile -ExecutionPolicy Bypass -File tools/prepare-runtime.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-focus-dll.ps1
npm run desktop:dist
~~~

Expected: dist/Agent Board Setup 0.2.0.exe and dist/win-unpacked/ are created without requiring administrator privileges.

- [ ] **Step 7: Commit packaging configuration without binaries**

~~~
git add package.json package-lock.json tools/prepare-runtime.ps1 tools/build-focus-dll.ps1 tools/verify-package.js
git commit -m "build: 配置 Windows Electron 单用户安装包"
~~~

Do not stage runtime/node.exe, tools/wf.dll, dist/ or any user-modified file.

### Task 7: Add packaging verification and update documentation

**Files:**
- Create: tools/verify-package.js
- Modify: README.md

- [ ] **Step 1: Implement package verification**

tools/verify-package.js accepts the unpacked directory and checks:

~~~
const required = [
  'resources/backend/server.js',
  'resources/backend/lib/store.js',
  'resources/backend/public/index.html',
  'resources/backend/tools/wf.dll',
  'resources/runtime/node.exe',
];
~~~

It must also recursively scan resources/backend text files and fail if any file contains either C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10 or C:\Users\Administrator\AppData. It must fail if resources/backend contains *.test.js, docs, *.bak or node_modules.

- [ ] **Step 2: Run the verifier against the unpacked build**

Run: npm run desktop:verify

Expected: output package verification passed and exit code 0.

- [ ] **Step 3: Update README**

Add three sections to README.md:

1. “开发态运行”：npm install、npm run desktop:dev；
2. “构建 Windows 安装包”：prepare runtime、build DLL、npm run desktop:dist；
3. “普通用户安装”：下载安装包、双击安装、从桌面/开始菜单启动，说明数据目录为 %LOCALAPPDATA%\AgentBoard，卸载默认保留数据。

Keep the existing node server.js and start.bat instructions as开发者回退方式，并明确首版自动更新尚未启用。

- [ ] **Step 4: Run the full unit suite and static checks**

Run: node --test

Expected: PASS.

Run: git diff --check

Expected: no whitespace errors.

- [ ] **Step 5: Commit documentation and verifier**

~~~
git add tools/verify-package.js README.md
git commit -m "docs: 增加 Windows 桌面版构建与安装说明"
~~~

### Task 8: Validate the installed application and data preservation

**Files:**
- Test artifact: dist/Agent Board Setup 0.2.0.exe
- Test data: a temporary %TEMP%\agent-board-install-test-* directory
- Do not modify or delete the real %LOCALAPPDATA%\AgentBoard data during this task.

- [ ] **Step 1: Run a backend-only packaged smoke test**

Start the unpacked backend with an isolated port and data directory:

~~~
$testData = Join-Path $env:TEMP ('agent-board-install-test-' + [guid]::NewGuid())
$node = (Resolve-Path 'dist/win-unpacked/resources/runtime/node.exe').Path
$server = (Resolve-Path 'dist/win-unpacked/resources/backend/server.js').Path
$env:AB_PORT = '49876'
$env:AB_DATA_DIR = $testData
Start-Process -FilePath $node -ArgumentList @($server) -WindowStyle Hidden
Invoke-WebRequest 'http://127.0.0.1:49876/api/state' -UseBasicParsing
~~~

Expected: HTTP 200 and a JSON state response. Stop only the process whose command line contains the unpacked test server.js path.

- [ ] **Step 2: Install the NSIS package per user**

Run the generated installer as the current user with the default installation directory. Do not use elevated administrator mode.

Expected: desktop shortcut, start-menu shortcut, and installed resources/backend and resources/runtime exist.

- [ ] **Step 3: Verify first launch**

Double-click the desktop shortcut.

Expected:

- one Agent Board Electron window appears;
- no command window appears;
- Agent detection and local session scan work;
- clicking an external download link opens the system browser;
- closing the window hides it to the tray;
- clicking the tray item restores the same window.

- [ ] **Step 4: Verify single instance and clean exit**

Double-click the shortcut twice and inspect the process list.

Expected: one Electron instance and one backend node.exe child. The second launch only focuses the existing window. Choosing tray “退出” ends both processes.

- [ ] **Step 5: Verify data preservation**

Before installation, place a copied fixture data.json in a temporary data directory and launch with AB_DATA_DIR pointing to it. Confirm the sessions render. Uninstall the test installation and confirm the data directory still exists.

Do not run uninstall against the real user installation until the test package passes all earlier checks.

- [ ] **Step 6: Record release blockers**

Document that the internal installer is unsigned and that automatic updates are not included. Before public distribution, add code signing and a separate update design; do not silently claim either capability in the UI or README.

- [ ] **Step 7: Final verification and handoff**

Run:

~~~
node --test
git status --short
~~~

Expected: all tests pass; only the intentionally preserved user modifications remain, and generated dist/, runtime/node.exe and tools/wf.dll are ignored.
