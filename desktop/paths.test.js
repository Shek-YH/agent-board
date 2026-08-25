'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { resolveDesktopPaths } = require('./paths');

test('开发态使用仓库里的 server.js 和当前 Node', () => {
  const result = resolveDesktopPaths({
    packaged: false,
    projectRoot: 'C:\\work\\agent-board',
    env: { AGENT_BOARD_NODE_RUNTIME: 'D:\\node.exe' },
    homedir: 'C:\\Users\\test',
  });
  assert.equal(result.backendEntry, path.join('C:\\work\\agent-board', 'server.js'));
  assert.equal(result.nodeRuntime, 'D:\\node.exe');
  assert.equal(result.dataDir, path.join('C:\\Users\\test', 'AppData', 'Local', 'AgentBoard'));
});

test('打包态使用 resources/backend 和 resources/runtime', () => {
  const result = resolveDesktopPaths({
    packaged: true,
    resourcesPath: 'C:\\App\\resources',
    env: { AB_DATA_DIR: 'D:\\AgentBoardData' },
    homedir: 'C:\\Users\\test',
  });
  assert.equal(result.backendEntry, path.join('C:\\App\\resources', 'backend', 'server.js'));
  assert.equal(result.nodeRuntime, path.join('C:\\App\\resources', 'runtime', 'node.exe'));
  assert.equal(result.dataDir, path.resolve('D:\\AgentBoardData'));
});
