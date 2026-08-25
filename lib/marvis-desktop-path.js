'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

function resolveMarvisLauncher({
  env = process.env,
  existsSync = fs.existsSync,
  readRegistryCommand: readRegistryCommandImpl,
  homedir = os.homedir(),
} = {}) {
  const registryCommand = readRegistryCommandImpl
    ? readRegistryCommandImpl()
    : readRegistryCommand();
  const candidates = [
    env.MARVIS_LAUNCHER_EXE,
    parseMarvisLauncherPath(registryCommand),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Tencent', 'Marvis', 'Application', 'MarvisLauncher.exe'),
    path.join(homedir, 'AppData', 'Local', 'Tencent', 'Marvis', 'MarvisLauncher.exe'),
  ].filter(Boolean);

  return candidates.find(file => existsSync(file)) || candidates[candidates.length - 1];
}

module.exports = { parseMarvisLauncherPath, resolveMarvisLauncher };
