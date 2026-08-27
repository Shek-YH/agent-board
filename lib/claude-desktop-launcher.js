'use strict';

const { spawn } = require('child_process');

function launchClaudeDeepLink(deepLink, options = {}) {
  if (typeof deepLink !== 'string' || !deepLink.startsWith('claude://')) {
    throw new TypeError('无效的 Claude Deep Link');
  }
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawn || spawn;
  let child;
  if (platform === 'win32') {
    // URL 通过任务专用环境变量传给 PowerShell，避免 cmd.exe/PowerShell
    // 把 URL 中的 & 当作命令语法解析。
    child = spawnImpl('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath $env:AGENT_BOARD_CLAUDE_DEEPLINK',
    ], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...(options.env || process.env), AGENT_BOARD_CLAUDE_DEEPLINK: deepLink },
    });
  } else if (platform === 'darwin') {
    child = spawnImpl('open', [deepLink], { detached: true, stdio: 'ignore' });
  } else {
    child = spawnImpl('xdg-open', [deepLink], { detached: true, stdio: 'ignore' });
  }
  if (child && typeof child.unref === 'function') child.unref();
  return Promise.resolve();
}

module.exports = { launchClaudeDeepLink };
