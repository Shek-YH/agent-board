'use strict';

const os = require('node:os');
const path = require('node:path');

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getDataDir({ env = process.env, homedir = os.homedir(), platform = process.platform } = {}) {
  const pathApi = platform === 'darwin' ? path.posix : path;
  const defaultRoot = platform === 'win32'
    ? (nonBlank(env.LOCALAPPDATA) || pathApi.join(homedir, 'AppData', 'Local'))
    : platform === 'darwin'
      ? pathApi.join(homedir, 'Library', 'Application Support')
      : (nonBlank(env.XDG_DATA_HOME) || pathApi.join(homedir, '.local', 'share'));
  return pathApi.resolve(nonBlank(env.AB_DATA_DIR) || pathApi.join(defaultRoot, 'AgentBoard'));
}

function getConfigDir({ env = process.env, homedir = os.homedir(), platform = process.platform } = {}) {
  const pathApi = platform === 'darwin' ? path.posix : path;
  const defaultRoot = platform === 'darwin'
    ? pathApi.join(homedir, 'Library', 'Application Support')
    : platform === 'win32'
      ? homedir
      : (nonBlank(env.XDG_CONFIG_HOME) || pathApi.join(homedir, '.config'));
  const defaultDir = platform === 'darwin'
    ? pathApi.join(defaultRoot, 'AgentBoard')
    : platform === 'win32'
      ? pathApi.join(defaultRoot, '.agent-board')
      : pathApi.join(defaultRoot, 'agent-board');
  return pathApi.resolve(nonBlank(env.AB_CONFIG_DIR) || defaultDir);
}

module.exports = { getDataDir, getConfigDir };
