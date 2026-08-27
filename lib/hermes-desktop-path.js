'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveHermesDesktopExe({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const pathApi = platform === 'darwin' ? path.posix : path;
  const candidates = [
    env.HERMES_DESKTOP_EXE,
    ...(platform === 'darwin' ? [
      '/Applications/Hermes.app/Contents/MacOS/Hermes',
      pathApi.join(homedir, 'Applications', 'Hermes.app', 'Contents', 'MacOS', 'Hermes'),
      pathApi.join(homedir, 'Library', 'Application Support', 'hermes', 'Hermes.app', 'Contents', 'MacOS', 'Hermes'),
    ] : []),
    pathApi.join(homedir, 'AppData', 'Local', 'hermes', 'hermes-agent', 'apps', 'desktop', 'release', 'win-unpacked', 'Hermes.exe'),
    pathApi.join(homedir, 'AppData', 'Local', 'Programs', 'hermes-desktop', 'hermes-agent.exe'),
  ].filter(Boolean);

  return candidates.find(file => existsSync(file)) || candidates.find(Boolean) || '';
}

module.exports = { resolveHermesDesktopExe };
