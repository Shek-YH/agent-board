'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolvePiAgentDesktopExe({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const pathApi = platform === 'darwin' ? path.posix : path;
  const candidates = [
    env.PI_AGENT_DESKTOP_EXE,
    ...(platform === 'darwin' ? [
      '/Applications/Pi Agent.app/Contents/MacOS/Pi Agent',
      pathApi.join(homedir, 'Applications', 'Pi Agent.app', 'Contents', 'MacOS', 'Pi Agent'),
    ] : []),
    pathApi.join(homedir, 'AppData', 'Local', 'Pi Agent', 'pi-agent-desktop.exe'),
  ].filter(Boolean);

  return candidates.find(file => existsSync(file)) || candidates.find(Boolean) || '';
}

module.exports = { resolvePiAgentDesktopExe };
