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

let mainWindow = null;
let tray = null;
let backend = null;
let backendContext = null;
let localUrl = '';
let quitting = false;
const shortcutController = createGlobalShortcutController({
  globalShortcut,
  onActivate: showMainWindow,
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

function registerConfiguredShortcut() {
  const settings = loadShortcutSettings();
  const result = shortcutController.apply(settings.activateApp);
  if (!result.ok) writeDesktopLog(`全局快捷键注册失败：${result.error}`);
}

ipcMain.handle('shortcut:get', () => {
  const settings = loadShortcutSettings();
  return {
    ok: true,
    shortcut: settings.activateApp,
    activeShortcut: shortcutController.current,
  };
});

ipcMain.handle('shortcut:set', (_event, shortcut) => {
  const previous = shortcutController.current || loadShortcutSettings().activateApp;
  const applied = shortcutController.apply(shortcut);
  if (!applied.ok) return applied;
  try {
    const saved = saveShortcutSettings(applied.accelerator);
    return {
      ok: true,
      shortcut: saved.activateApp,
      activeShortcut: shortcutController.current,
    };
  } catch (error) {
    shortcutController.apply(previous);
    return { ok: false, error: `保存快捷键失败：${error.message || '未知错误'}`, accelerator: previous };
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
  app.on('will-quit', () => shortcutController.dispose());
  app.on('window-all-closed', (event) => event.preventDefault());
  app.whenReady().then(startApplication).catch(showStartupError);
}
