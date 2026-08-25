'use strict';

const os = require('node:os');
const path = require('node:path');

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getDataDir({ env = process.env, homedir = os.homedir() } = {}) {
  return path.resolve(nonBlank(env.AB_DATA_DIR) || path.join(homedir, 'AppData', 'Local', 'AgentBoard'));
}

function getConfigDir({ env = process.env, homedir = os.homedir() } = {}) {
  return path.resolve(nonBlank(env.AB_CONFIG_DIR) || path.join(homedir, '.agent-board'));
}

module.exports = { getDataDir, getConfigDir };
