'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveHermesDesktopExe({
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const candidates = [
    env.HERMES_DESKTOP_EXE,
    path.join(homedir, 'AppData', 'Local', 'hermes', 'hermes-agent', 'apps', 'desktop', 'release', 'win-unpacked', 'Hermes.exe'),
    path.join(homedir, 'AppData', 'Local', 'Programs', 'hermes-desktop', 'hermes-agent.exe'),
  ].filter(Boolean);

  return candidates.find(file => existsSync(file)) || candidates[candidates.length - 1];
}

module.exports = { resolveHermesDesktopExe };
