'use strict';

const os = require('node:os');
const path = require('node:path');

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveDesktopPaths({
  packaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.resolve(__dirname, '..'),
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  const backendRoot = packaged
    ? path.join(resourcesPath, 'backend')
    : path.resolve(projectRoot);
  const dataDir = path.resolve(nonBlank(env.AB_DATA_DIR) || path.join(homedir, 'AppData', 'Local', 'AgentBoard'));
  return {
    backendRoot,
    backendEntry: path.join(backendRoot, 'server.js'),
    nodeRuntime: packaged
      ? path.join(resourcesPath, 'runtime', 'node.exe')
      : (nonBlank(env.AGENT_BOARD_NODE_RUNTIME)
        || nonBlank(env.npm_node_execpath)
        || process.execPath),
    dataDir,
  };
}

module.exports = { resolveDesktopPaths };
