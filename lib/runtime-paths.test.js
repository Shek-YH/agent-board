'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getDataDir, getConfigDir } = require('./runtime-paths');

test('getDataDir 默认使用用户 LocalAppData 目录', () => {
  assert.equal(
    getDataDir({ env: {}, homedir: 'C:\\Users\\test' }),
    path.join('C:\\Users\\test', 'AppData', 'Local', 'AgentBoard'),
  );
});

test('getDataDir 使用 AB_DATA_DIR 覆盖默认目录', () => {
  assert.equal(
    getDataDir({ env: { AB_DATA_DIR: 'D:\\AgentBoardData' }, homedir: 'C:\\Users\\test' }),
    path.resolve('D:\\AgentBoardData'),
  );
});

test('macOS 默认使用 Application Support，而不是 Windows AppData', () => {
  assert.equal(
    getDataDir({ env: {}, homedir: '/Users/test', platform: 'darwin' }),
    '/Users/test/Library/Application Support/AgentBoard',
  );
  assert.equal(
    getConfigDir({ env: {}, homedir: '/Users/test', platform: 'darwin' }),
    '/Users/test/Library/Application Support/AgentBoard',
  );
});

test('getConfigDir 默认使用用户 .agent-board 目录', () => {
  assert.equal(
    getConfigDir({ env: {}, homedir: 'C:\\Users\\test' }),
    path.join('C:\\Users\\test', '.agent-board'),
  );
});

test('getConfigDir 使用 AB_CONFIG_DIR 覆盖默认目录', () => {
  assert.equal(
    getConfigDir({ env: { AB_CONFIG_DIR: 'D:\\AgentBoardConfig' }, homedir: 'C:\\Users\\test' }),
    path.resolve('D:\\AgentBoardConfig'),
  );
});

test('空白环境变量不会覆盖默认目录', () => {
  assert.equal(
    getDataDir({ env: { AB_DATA_DIR: '   ' }, homedir: os.homedir() }),
    path.join(os.homedir(), 'AppData', 'Local', 'AgentBoard'),
  );
});
