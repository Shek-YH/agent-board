'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadUserOverrides, getOverridePaths } = require('./detect');

const MARVIS_PROTOCOL_COMMAND_KEY = 'HKCR\\marvis\\shell\\open\\command';

function readRegistryCommand(spawnSyncImpl = spawnSync) {
  if (process.platform !== 'win32') return '';
  try {
    const result = spawnSyncImpl('reg.exe', ['query', MARVIS_PROTOCOL_COMMAND_KEY, '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result && result.status === 0 ? String(result.stdout || '') : '';
  } catch {
    return '';
  }
}

function parseMarvisLauncherPath(command) {
  if (typeof command !== 'string') return '';
  const quoted = command.match(/"([^"\r\n]*MarvisLauncher\.exe)"/i);
  if (quoted) return quoted[1];
  const unquoted = command.match(/([A-Za-z]:[^"\r\n]*MarvisLauncher\.exe)/i);
  return unquoted ? unquoted[1].trim() : '';
}

function uniquePaths(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    if (!value) continue;
    const key = String(value).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(String(value));
  }
  return out;
}

function marvisRoots({ env = process.env, homedir = os.homedir(), launcher = '', platform = process.platform } = {}) {
  if (platform !== 'win32') return env.MARVIS_INSTALL_ROOT ? [env.MARVIS_INSTALL_ROOT] : [];
  const launcherRoot = launcher
    ? path.resolve(path.dirname(launcher), '..')
    : '';
  return uniquePaths([
    env.MARVIS_INSTALL_ROOT,
    launcherRoot,
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Tencent', 'Marvis'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Marvis'),
    env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'Tencent', 'Marvis') : '',
    env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'Marvis') : '',
    path.join(homedir, 'AppData', 'Local', 'Tencent', 'Marvis'),
    // 某些电脑把 Program Files 迁移到非系统盘；这是受控的应用目录候选，
    // 不是扫描整个 D 盘，命中前仍必须通过 existsSync 验证。
    'D:\\Program Files\\Tencent\\Marvis',
  ]);
}

function resolveMarvisMain({
  env = process.env,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  readRegistryCommand: readRegistryCommandImpl,
  homedir = os.homedir(),
  platform = process.platform,
  userOverrides,
} = {}) {
  if (platform !== 'win32') return env.MARVIS_MAIN_EXE || '';
  const launcher = resolveMarvisLauncher({ env, existsSync, readRegistryCommand: readRegistryCommandImpl, homedir, platform });
  const directCandidates = [
    ...getOverridePaths(userOverrides || loadUserOverrides(), 'marvis', 'desktop'),
    env.MARVIS_MAIN_EXE,
    launcher ? path.join(path.dirname(launcher), 'Marvis.exe') : '',
  ];
  for (const root of marvisRoots({ env, homedir, launcher, platform })) {
    directCandidates.push(
      path.join(root, 'Application', 'Marvis.exe'),
      path.join(root, 'Marvis.exe'),
    );
    let versions = [];
    try { versions = readdirSync(path.join(root, 'Application'), { withFileTypes: true }); } catch { /* optional install root */ }
    for (const entry of versions) {
      if (entry.isDirectory && entry.isDirectory()) {
        directCandidates.push(path.join(root, 'Application', entry.name, 'Marvis.exe'));
      }
    }
  }
  return uniquePaths(directCandidates).find((file) => existsSync(file)) || uniquePaths(directCandidates)[0] || '';
}

function resolveMarvisLauncher({
  env = process.env,
  existsSync = fs.existsSync,
  readRegistryCommand: readRegistryCommandImpl,
  homedir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return env.MARVIS_LAUNCHER_EXE || '';
  const registryCommand = readRegistryCommandImpl
    ? readRegistryCommandImpl()
    : readRegistryCommand();
  const candidates = [
    env.MARVIS_LAUNCHER_EXE,
    parseMarvisLauncherPath(registryCommand),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Tencent', 'Marvis', 'Application', 'MarvisLauncher.exe'),
    env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'Tencent', 'Marvis', 'Application', 'MarvisLauncher.exe') : '',
    path.join(homedir, 'AppData', 'Local', 'Tencent', 'Marvis', 'MarvisLauncher.exe'),
    'D:\\Program Files\\Tencent\\Marvis\\Application\\MarvisLauncher.exe',
  ].filter(Boolean);

  return candidates.find(file => existsSync(file)) || candidates[candidates.length - 1];
}

module.exports = { parseMarvisLauncherPath, resolveMarvisLauncher, resolveMarvisMain, marvisRoots };
