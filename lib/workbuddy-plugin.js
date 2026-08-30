'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_NAME = 'agent-board-workbuddy';
const PLUGIN_KEY = `${PLUGIN_NAME}@agent-board`;

function detectGitBash({ env = process.env, homedir = os.homedir(), platform = process.platform, fsApi = fs } = {}) {
  if (platform !== 'win32') return { required: false, available: true, path: null };
  const candidates = [
    env.CODEBUDDY_CODE_GIT_BASH_PATH,
    env.GIT_BASH_PATH,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(homedir, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => {
    try { return fsApi.existsSync(candidate); } catch { return false; }
  });
  return { required: true, available: Boolean(found), path: found ? path.resolve(found) : null };
}

function readJson(filePath, fsApi) {
  try {
    const value = JSON.parse(fsApi.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readConfig(filePath, fsApi, fallback) {
  if (!fsApi.existsSync(filePath)) return fallback;
  const value = readJson(filePath, fsApi);
  if (!value) throw new Error(`WorkBuddy 配置文件无效：${filePath}`);
  return value;
}

function writeJson(filePath, value, fsApi) {
  fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
  fsApi.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function manifestAt(installPath, fsApi) {
  if (typeof installPath !== 'string' || !installPath.trim()) return null;
  const root = path.resolve(installPath);
  const manifestPath = path.join(root, '.codebuddy-plugin', 'plugin.json');
  const manifest = readJson(manifestPath, fsApi);
  if (!manifest || manifest.name !== PLUGIN_NAME) return null;
  return { root, manifest };
}

function findFilesystemPlugin(root, fsApi, depth = 0) {
  if (depth > 6) return null;
  const direct = manifestAt(root, fsApi);
  if (direct) return direct;
  let entries;
  try { entries = fsApi.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const found = findFilesystemPlugin(path.join(root, entry.name), fsApi, depth + 1);
    if (found) return found;
  }
  return null;
}

function inspectWorkBuddyPlugin({
  homedir = os.homedir(),
  fsApi = fs,
  env = process.env,
  platform = process.platform,
} = {}) {
  const gitBash = detectGitBash({ env, homedir, platform, fsApi });
  const workbuddyDir = path.join(homedir, '.workbuddy');
  const pluginsDir = path.join(workbuddyDir, 'plugins');
  const settings = readJson(path.join(workbuddyDir, 'settings.json'), fsApi) || {};
  const enabledPlugins = settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
    ? settings.enabledPlugins
    : {};
  const installed = readJson(path.join(pluginsDir, 'installed_plugins.json'), fsApi) || {};
  const records = installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : {};
  const candidates = [];
  for (const [key, values] of Object.entries(records)) {
    if (!(key === PLUGIN_NAME || key.startsWith(`${PLUGIN_NAME}@`))) continue;
    for (const value of Array.isArray(values) ? values : [values]) {
      const found = manifestAt(value?.installPath, fsApi);
      if (found) candidates.push({ ...found, version: String(value.version || found.manifest.version || '') || null, key });
    }
  }
  let selected = candidates.sort((left, right) => String(right.version || '').localeCompare(String(left.version || '')))[0] || null;
  if (!selected) {
    selected = findFilesystemPlugin(path.join(pluginsDir, 'cache'), fsApi)
      || findFilesystemPlugin(path.join(pluginsDir, 'marketplaces'), fsApi)
      || findFilesystemPlugin(pluginsDir, fsApi);
  }
  if (!selected) {
    return { installed: false, enabled: false, version: null, installPath: null, source: null, gitBash };
  }
  const enabled = Object.entries(enabledPlugins).some(([key, value]) =>
    value === true && (key === PLUGIN_NAME || key.startsWith(`${PLUGIN_NAME}@`))
  );
  return {
    installed: true,
    enabled,
    version: selected.version || String(selected.manifest.version || '') || null,
    installPath: selected.root,
    source: candidates.includes(selected) ? 'installed_plugins' : 'filesystem',
    gitBash,
  };
}

function installWorkBuddyPlugin({
  sourcePath,
  homedir = os.homedir(),
  fsApi = fs,
  now = () => new Date(),
} = {}) {
  const source = manifestAt(sourcePath, fsApi);
  if (!source) {
    return {
      ok: false,
      installed: false,
      enabled: false,
      error: '插件资源缺失或 manifest 无效',
    };
  }

  const version = String(source.manifest.version || '1.0.0');
  const workbuddyDir = path.join(homedir, '.workbuddy');
  const pluginsDir = path.join(workbuddyDir, 'plugins');
  const installPath = path.join(pluginsDir, 'cache', 'agent-board', PLUGIN_NAME, version);
  fsApi.mkdirSync(path.dirname(installPath), { recursive: true });
  fsApi.cpSync(source.root, installPath, { recursive: true, force: true });

  const installedPath = path.join(pluginsDir, 'installed_plugins.json');
  const installed = readConfig(installedPath, fsApi, { version: 2, plugins: {} });
  installed.version = 2;
  installed.plugins = installed.plugins && typeof installed.plugins === 'object' && !Array.isArray(installed.plugins)
    ? installed.plugins
    : {};
  const previous = Array.isArray(installed.plugins[PLUGIN_KEY]) ? installed.plugins[PLUGIN_KEY] : [];
  const previousRecord = previous.find((record) => record?.installPath === installPath) || {};
  const timestamp = now().toISOString();
  installed.plugins[PLUGIN_KEY] = [{
    ...previousRecord,
    scope: 'user',
    installPath,
    version,
    installedAt: previousRecord.installedAt || timestamp,
    lastUpdated: timestamp,
  }, ...previous.filter((record) => record?.installPath !== installPath)];
  writeJson(installedPath, installed, fsApi);

  const settingsPath = path.join(workbuddyDir, 'settings.json');
  const settings = readConfig(settingsPath, fsApi, {});
  settings.enabledPlugins = settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
    && !Array.isArray(settings.enabledPlugins) ? settings.enabledPlugins : {};
  settings.enabledPlugins[PLUGIN_KEY] = true;
  writeJson(settingsPath, settings, fsApi);

  return {
    ok: true,
    installed: true,
    enabled: true,
    version,
    installPath,
    pluginKey: PLUGIN_KEY,
  };
}

module.exports = { PLUGIN_NAME, PLUGIN_KEY, detectGitBash, inspectWorkBuddyPlugin, installWorkBuddyPlugin };
