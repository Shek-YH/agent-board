'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfigDir } = require('./runtime-paths');

function resolveFocusDll({
  env = process.env,
  backendDir,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  if (env.AGENT_BOARD_FOCUS_DLL) return env.AGENT_BOARD_FOCUS_DLL;
  const bundled = path.join(backendDir, 'tools', 'wf.dll');
  return existsSync(bundled) ? bundled : path.join(getConfigDir({ env, homedir }), 'wf.dll');
}

module.exports = { resolveFocusDll };
