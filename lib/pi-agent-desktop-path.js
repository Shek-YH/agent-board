'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolvePiAgentDesktopExe({
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const candidates = [
    env.PI_AGENT_DESKTOP_EXE,
    path.join(homedir, 'AppData', 'Local', 'Pi Agent', 'pi-agent-desktop.exe'),
  ].filter(Boolean);

  return candidates.find(file => existsSync(file)) || candidates[candidates.length - 1];
}

module.exports = { resolvePiAgentDesktopExe };
