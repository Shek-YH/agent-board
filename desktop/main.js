'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  shell,
  globalShortcut,
  ipcMain,
  safeStorage,
  Notification,
} = require('electron');
const { resolveDesktopPaths } = require('./paths');
const { findAvailablePort } = require('./port');
const {
  buildBackendLaunch,
  startBackend,
  waitForBackend,
  stopBackend,
} = require('./backend-process');
const { createGlobalShortcutController } = require('./global-shortcut');
const { installWorkBuddyPlugin } = require('../lib/workbuddy-plugin');
const {
  loadShortcutSettings,
  saveShortcutSettings,
} = require('./shortcut-settings');
const {
  createSecureStore,
  SUPPORTED_PROVIDERS,
  providerEnvName,
} = require('./secure-store');

let mainWindow = null;
let tray = null;
let backend = null;
let backendContext = null;
let localUrl = '';
let quitting = false;
let providerStore = null;
const LATEST_COMPLETED_JUMP_CHANNEL = 'shortcut:jump-latest-completed';
let pendingLatestCompletedJump = false;
const shortcutController = createGlobalShortcutController({
  globalShortcut,
  onActivate: showMainWindow,
});
const latestCompletedShortcutController = createGlobalShortcutController({
  globalShortcut,
  onActivate: requestLatestCompletedJump,
});

function logPath() {
  return path.join(app.getPath('logs'), 'desktop.log');
}

function writeDesktopLog(message) {
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // Logging must never prevent the app from showing an error or exiting.
  }
}

function getProviderStore() {
  if (!providerStore) {
    providerStore = createSecureStore({
      safeStorage,
      filePath: path.join(app.getPath('userData'), 'provider-keys.json'),
    });
  }
  return providerStore;
}

function getProviderStoreStatus() {
  try {
    return getProviderStore().status();
  } catch (error) {
    return { available: false, configuredProviders: [], activeProvider: null, code: error.code || 'SECURE_STORE_UNAVAILABLE' };
  }
}

function backendEnvironment() {
  const env = { ...process.env };
  try {
    const store = getProviderStore();
    for (const provider of SUPPORTED_PROVIDERS) {
      const apiKey = store.getProviderApiKey(provider);
      if (apiKey) env[providerEnvName(provider)] = apiKey;
    }
    const activeProvider = store.getActiveProvider();
    if (activeProvider && !String(env.AGENT_BOARD_SUPERVISOR_PROVIDER || '').trim()) {
      env.AGENT_BOARD_SUPERVISOR_PROVIDER = activeProvider;
    }
  } catch (error) {
    writeDesktopLog(`Provider 安全存储不可用：${error.code || 'SECURE_STORE_UNAVAILABLE'}`);
  }
  return env;
}

function providerIpcFailure(error) {
  return { ok: false, code: error?.code || 'SECURE_STORE_OPERATION_FAILED', error: 'Provider 安全存储操作失败' };
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notifyLatestCompletedJump() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
  try {
    mainWindow.webContents.send(LATEST_COMPLETED_JUMP_CHANNEL);
    return true;
  } catch (error) {
    writeDesktopLog(`最近完成任务快捷键通知失败：${error.message || '未知错误'}`);
    return false;
  }
}

function requestLatestCompletedJump() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  pendingLatestCompletedJump = !notifyLatestCompletedJump();
}

function isLocalUrl(url) {
  return Boolean(localUrl) && (url === localUrl || url.startsWith(localUrl + '/'));
}

function openExternalSafely(url) {
  Promise.resolve(shell.openExternal(url)).catch((error) => {
    writeDesktopLog(`外部链接打开失败：${url}：${error.message}`);
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocalUrl(url)) openExternalSafely(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalUrl(url)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (!pendingLatestCompletedJump) return;
    pendingLatestCompletedJump = !notifyLatestCompletedJump();
  });
  mainWindow.once('ready-to-show', () => showMainWindow());
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.loadURL(localUrl).catch(showStartupError);
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('Agent Board');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Agent Board', click: showMainWindow },
    { label: '重启后端', click: () => restartBackend().catch(showStartupError) },
    { type: 'separator' },
    { label: '退出', click: () => quitApplication() },
  ]));
  tray.on('double-click', showMainWindow);
}

async function startBackendProcess() {
  const launch = buildBackendLaunch({
    nodeRuntime: backendContext.paths.nodeRuntime,
    backendEntry: backendContext.paths.backendEntry,
    port: backendContext.port,
    dataDir: backendContext.paths.dataDir,
    env: backendEnvironment(),
  });
  backend = startBackend(launch);
  backend.child.stdout.on('data', chunk => writeDesktopLog(chunk.toString()));
  backend.child.stderr.on('data', chunk => writeDesktopLog(chunk.toString()));
  backend.child.once('error', error => writeDesktopLog(`后端进程错误：${error.message}`));
  const ready = await waitForBackend(backendContext.port, {
    timeoutMs: 20000,
    child: backend.child,
    expectedRuntime: {
      serverEntry: path.resolve(backendContext.backendEntry),
      serverRoot: path.dirname(path.resolve(backendContext.backendEntry)),
      port: backendContext.port,
      runtimeMode: 'desktop',
    },
  });
  if (!ready) throw new Error(`Agent Board 后端启动超时：${backendContext.backendEntry}`);
}

async function restartBackend() {
  if (!backendContext) return;
  await stopBackend(backend?.child);
  backend = null;
  await startBackendProcess();
}

async function startApplication() {
  const paths = resolveDesktopPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: app.getAppPath(),
    env: process.env,
  });
  if (!fs.existsSync(paths.nodeRuntime)) throw new Error(`未找到内置 Node.js：${paths.nodeRuntime}`);
  if (!fs.existsSync(paths.backendEntry)) throw new Error(`未找到 Agent Board 后端：${paths.backendEntry}`);
  try {
    const result = installWorkBuddyPlugin({ sourcePath: paths.workbuddyPluginSource });
    if (result.ok) writeDesktopLog(`WorkBuddy 插件已自动初始化：${result.installPath}`);
    else writeDesktopLog(`WorkBuddy 插件自动初始化失败：${result.error}`);
  } catch (error) {
    writeDesktopLog(`WorkBuddy 插件自动初始化异常：${error.message || '未知错误'}`);
  }

  const port = await findAvailablePort({ preferredPort: 4876 });
  backendContext = { paths, port, backendEntry: paths.backendEntry };
  localUrl = `http://127.0.0.1:${port}`;
  await startBackendProcess();
  createMainWindow();
  createTray();
  registerConfiguredShortcut();
}

function registerConfiguredShortcut() {
  const settings = loadShortcutSettings();
  const activateResult = shortcutController.apply(settings.activateApp);
  if (!activateResult.ok) writeDesktopLog(`全局快捷键注册失败：${activateResult.error}`);
  if (settings.jumpToLatestCompleted === settings.activateApp) {
    writeDesktopLog('最近完成任务快捷键注册失败：不能与 Agent Board 激活快捷键相同');
    return;
  }
  const jumpResult = latestCompletedShortcutController.apply(settings.jumpToLatestCompleted);
  if (!jumpResult.ok) writeDesktopLog(`最近完成任务快捷键注册失败：${jumpResult.error}`);
}

ipcMain.handle('shortcut:get', () => {
  const settings = loadShortcutSettings();
  return {
    ok: true,
    shortcut: settings.activateApp,
    activeShortcut: shortcutController.current,
    jumpToLatestCompleted: settings.jumpToLatestCompleted,
    activeJumpToLatestCompleted: latestCompletedShortcutController.current,
  };
});

ipcMain.handle('shortcut:set', (_event, input) => {
  const kind = input && typeof input === 'object' && input.kind === 'jumpToLatestCompleted'
    ? 'jumpToLatestCompleted'
    : 'activateApp';
  const shortcut = typeof input === 'string' ? input : input?.shortcut;
  const settings = loadShortcutSettings();
  const otherKind = kind === 'activateApp' ? 'jumpToLatestCompleted' : 'activateApp';
  const next = typeof shortcut === 'string' ? shortcut.trim() : '';
  if (next && next === (settings[otherKind] || '')) {
    return { ok: false, error: '两个快捷键不能使用同一组合键', accelerator: settings[kind] };
  }
  const controller = kind === 'activateApp' ? shortcutController : latestCompletedShortcutController;
  const previous = controller.current || settings[kind];
  const applied = controller.apply(shortcut);
  if (!applied.ok) return applied;
  try {
    const saved = saveShortcutSettings({ ...settings, [kind]: applied.accelerator });
    return {
      ok: true,
      shortcut: saved.activateApp,
      activeShortcut: shortcutController.current,
      jumpToLatestCompleted: saved.jumpToLatestCompleted,
      activeJumpToLatestCompleted: latestCompletedShortcutController.current,
    };
  } catch (error) {
    controller.apply(previous);
    return { ok: false, error: `保存快捷键失败：${error.message || '未知错误'}`, accelerator: previous };
  }
});

function showWorkBuddyCompletionNotification(input = {}) {
  if (!Notification || (typeof Notification.isSupported === 'function' && !Notification.isSupported())) return false;
  const rawSessionId = typeof input === 'string' ? input : input?.sessionId;
  const sessionId = String(rawSessionId || '').replace(/[\r\n]/g, ' ').slice(0, 80);
  try {
    const notification = new Notification({
      title: 'WorkBuddy 已完成',
      body: sessionId ? `会话 ${sessionId} 已完成` : '有一个 WorkBuddy 会话已完成',
      silent: false,
    });
    notification.on('click', showMainWindow);
    notification.show();
    return true;
  } catch (error) {
    writeDesktopLog(`WorkBuddy 系统通知失败：${error.message || '未知错误'}`);
    return false;
  }
}

ipcMain.handle('notification:completion', (_event, input) => showWorkBuddyCompletionNotification(input));

ipcMain.handle('project:select-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 AutoPilot 项目文件夹',
      properties: ['openDirectory'],
    });
    return result.canceled || !result.filePaths[0]
      ? { ok: false, canceled: true }
      : { ok: true, path: result.filePaths[0] };
  } catch (error) {
    writeDesktopLog(`项目文件夹选择失败：${error.message || '未知错误'}`);
    return { ok: false, code: 'PROJECT_FOLDER_PICKER_FAILED', error: '无法打开项目文件夹选择器' };
  }
});

ipcMain.handle('provider:status', () => ({ ok: true, ...getProviderStoreStatus() }));

ipcMain.handle('provider:set-api-key', async (_event, input) => {
  try {
    const result = getProviderStore().setProviderApiKey(input?.provider, input?.apiKey);
    if (backendContext) {
      try {
        await restartBackend();
      } catch {
        return { ok: false, code: 'BACKEND_RESTART_FAILED', error: 'Provider 已安全保存，但后端重启失败' };
      }
    }
    return { ok: true, ...result };
  } catch (error) {
    return providerIpcFailure(error);
  }
});

ipcMain.handle('provider:clear-api-key', async (_event, input) => {
  try {
    const result = getProviderStore().clearProviderApiKey(input?.provider);
    if (backendContext) {
      try {
        await restartBackend();
      } catch {
        return { ok: false, code: 'BACKEND_RESTART_FAILED', error: 'Provider 已安全清除，但后端重启失败' };
      }
    }
    return { ok: true, ...result };
  } catch (error) {
    return providerIpcFailure(error);
  }
});

async function quitApplication() {
  if (quitting) return;
  quitting = true;
  await stopBackend(backend?.child);
  if (tray) tray.destroy();
  app.quit();
}

async function showStartupError(error) {
  const message = error?.message || String(error);
  writeDesktopLog(message);
  await stopBackend(backend?.child);
  backend = null;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (quitting) return;
  quitting = true;
  dialog.showErrorBox('Agent Board 启动失败', message);
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      quitApplication().catch(showStartupError);
    }
  });
  app.on('will-quit', () => {
    shortcutController.dispose();
    latestCompletedShortcutController.dispose();
  });
  app.on('window-all-closed', (event) => {
    if (!quitting) event.preventDefault();
  });
  app.whenReady().then(startApplication).catch(showStartupError);
}
