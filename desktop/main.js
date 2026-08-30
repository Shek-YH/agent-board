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
const {
  loadShortcutSettings,
  saveShortcutSettings,
} = require('./shortcut-settings');
const { createSecureStore } = require('./secure-store');
const { CloudLicenseClient } = require('./cloud-license-client');
const { isLiteBuild, shouldConfigureCloud, resolveCloudConfig } = require('./build-profile');

const packageMetadata = require('../package.json');
const liteMode = isLiteBuild(packageMetadata);

let mainWindow = null;
let tray = null;
let backend = null;
let backendContext = null;
let localUrl = '';
let quitting = false;
let cloudClient = null;
let cloudSetupError = null;
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
    env: process.env,
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
  configureCloudClient();
  const paths = resolveDesktopPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: app.getAppPath(),
    env: process.env,
  });
  if (!fs.existsSync(paths.nodeRuntime)) throw new Error(`未找到内置 Node.js：${paths.nodeRuntime}`);
  if (!fs.existsSync(paths.backendEntry)) throw new Error(`未找到 Agent Board 后端：${paths.backendEntry}`);

  const port = await findAvailablePort({ preferredPort: 4876 });
  backendContext = { paths, port, backendEntry: paths.backendEntry };
  localUrl = `http://127.0.0.1:${port}`;
  await startBackendProcess();
  createMainWindow();
  createTray();
  registerConfiguredShortcut();
}

function configureCloudClient() {
  const cloudConfig = resolveCloudConfig({ metadata: packageMetadata, env: process.env });
  if (!shouldConfigureCloud({ liteMode, baseUrl: cloudConfig.baseUrl })) return;
  try {
    const secureStore = createSecureStore({
      safeStorage,
      filePath: path.join(app.getPath('userData'), 'cloud-auth.bin'),
    });
    cloudClient = new CloudLicenseClient({
      baseUrl: cloudConfig.baseUrl,
      secureStore,
      productId: cloudConfig.productId,
      appVersion: app.getVersion(),
      licensePublicKey: cloudConfig.licensePublicKey,
    });
    cloudSetupError = null;
  } catch (error) {
    cloudClient = null;
    cloudSetupError = error?.code || 'SECURE_STORAGE_UNAVAILABLE';
    writeDesktopLog(`云端授权初始化失败：${error?.message || '未知错误'}`);
  }
}

function cloudError(error) {
  return {
    ok: false,
    code: error?.code || 'CLOUD_REQUEST_FAILED',
    message: error?.message || '云端授权操作失败',
  };
}

function cloudStatusFallback() {
  if (cloudSetupError) {
    return { state: 'unavailable', configured: true, authenticated: false, features: [], errorCode: cloudSetupError };
  }
  return { state: 'unconfigured', configured: false, authenticated: false, features: [] };
}

ipcMain.handle('cloud:status', async () => {
  if (!cloudClient) return cloudStatusFallback();
  try {
    return await cloudClient.getStatus();
  } catch (error) {
    return { state: 'unavailable', configured: true, authenticated: false, features: [], errorCode: error?.code || 'CLOUD_STATUS_FAILED' };
  }
});

ipcMain.handle('cloud:login', async (_event, input = {}) => {
  if (!cloudClient) return cloudError(new Error('Cloud authorization is not configured'));
  try {
    return { ok: true, ...(await cloudClient.login(input.email, input.password)) };
  } catch (error) {
    return cloudError(error);
  }
});

ipcMain.handle('cloud:register', async (_event, input = {}) => {
  if (!cloudClient) return cloudError(new Error('Cloud authorization is not configured'));
  try {
    return { ok: true, ...(await cloudClient.register(input.email, input.password, input.activationCode)) };
  } catch (error) {
    return cloudError(error);
  }
});

ipcMain.handle('cloud:forgot-password', async (_event, input = {}) => {
  if (!cloudClient) return cloudError(new Error('Cloud authorization is not configured'));
  try {
    return { ok: true, ...(await cloudClient.requestPasswordReset(input.email)) };
  } catch (error) {
    return cloudError(error);
  }
});

ipcMain.handle('cloud:logout', async () => {
  if (!cloudClient) return cloudStatusFallback();
  try {
    return await cloudClient.logout();
  } catch (error) {
    return cloudError(error);
  }
});

ipcMain.handle('cloud:redeem', async (_event, input = {}) => {
  if (!cloudClient) return cloudError(new Error('Cloud authorization is not configured'));
  try {
    return { ok: true, ...(await cloudClient.redeem(input.code)) };
  } catch (error) {
    return cloudError(error);
  }
});

ipcMain.handle('cloud:acquire', async () => {
  if (!cloudClient) return cloudError(new Error('Cloud authorization is not configured'));
  try {
    const result = await cloudClient.acquire();
    const heartbeatIntervalSeconds = Number(result.limits?.heartbeatIntervalSeconds);
    cloudClient.startHeartbeat(result.lease, {
      intervalMs: Number.isFinite(heartbeatIntervalSeconds) ? heartbeatIntervalSeconds * 1000 : 60_000,
      onError: (error) => writeDesktopLog(`云端授权心跳失败：${error?.code || error?.message || '未知错误'}`),
    });
    return { ok: true, lease: result.lease || null, clientVersionPolicy: result.clientVersionPolicy || null };
  } catch (error) {
    return cloudError(error);
  }
});

ipcMain.handle('cloud:release', async () => {
  if (!cloudClient) return cloudStatusFallback();
  try {
    await cloudClient.releaseActiveLease();
    return { ok: true };
  } catch (error) {
    return cloudError(error);
  }
});

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

async function quitApplication() {
  if (quitting) return;
  quitting = true;
  if (cloudClient) {
    await Promise.race([
      cloudClient.releaseActiveLease(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  }
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
  app.on('window-all-closed', (event) => event.preventDefault());
  app.whenReady().then(startApplication).catch(showStartupError);
}
