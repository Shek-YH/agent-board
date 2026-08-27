'use strict';

const os = require('node:os');
const path = require('node:path');
const { getDataDir } = require('../lib/runtime-paths');

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveDesktopPaths({
  packaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.resolve(__dirname, '..'),
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
} = {}) {
  const pathApi = platform === 'darwin' ? path.posix : path;
  const backendRoot = packaged
    ? path.join(resourcesPath, 'backend')
    : pathApi.resolve(projectRoot);
  const dataDir = getDataDir({ env, homedir, platform });
  return {
    backendRoot,
    backendEntry: path.join(backendRoot, 'server.js'),
    nodeRuntime: packaged
      ? path.join(resourcesPath, 'runtime', platform === 'win32' ? 'node.exe' : 'node')
      : (nonBlank(env.AGENT_BOARD_NODE_RUNTIME)
        || nonBlank(env.npm_node_execpath)
        || process.execPath),
    dataDir,
  };
}

module.exports = { resolveDesktopPaths };
