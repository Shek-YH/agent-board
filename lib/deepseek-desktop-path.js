'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveDeepSeekDesktopExe({
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const candidates = [
    env.DEEPSEEK_DESKTOP_EXE,
    path.join(homedir, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe'),
  ].filter(Boolean);
  return candidates.find(file => existsSync(file)) || candidates[candidates.length - 1];
}

module.exports = { resolveDeepSeekDesktopExe };
