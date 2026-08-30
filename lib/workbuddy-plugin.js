'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_NAME = 'agent-board-workbuddy';

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
    const value = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
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

module.exports = { PLUGIN_NAME, detectGitBash, inspectWorkBuddyPlugin };
