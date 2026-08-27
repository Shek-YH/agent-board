'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const packageJson = require('../package.json');
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

test('开发态从 npm 使用的 Node 启动后端，而不是 Electron 可执行文件', () => {
  const result = resolveDesktopPaths({
    packaged: false,
    projectRoot: 'C:\\work\\agent-board',
    env: { npm_node_execpath: 'D:\\node.exe' },
  });
  assert.equal(result.nodeRuntime, 'D:\\node.exe');
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

test('macOS 开发态使用 Application Support，不拼接 Windows AppData', () => {
  const result = resolveDesktopPaths({
    packaged: false,
    platform: 'darwin',
    projectRoot: '/work/agent-board',
    env: {},
    homedir: '/Users/test',
  });
  assert.equal(result.dataDir, '/Users/test/Library/Application Support/AgentBoard');
});

test('打包后的 desktop paths 不依赖未打进 app.asar 的 backend lib', () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-asar-'));
  const desktopRoot = path.join(packageRoot, 'desktop');
  const sharedLibRoot = path.join(packageRoot, 'lib');
  fs.mkdirSync(desktopRoot, { recursive: true });
  assert.ok(packageJson.build.files.includes('lib/runtime-paths.js'));
  fs.mkdirSync(sharedLibRoot, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'paths.js'), path.join(desktopRoot, 'paths.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'lib', 'runtime-paths.js'), path.join(sharedLibRoot, 'runtime-paths.js'));
  try {
    const packagedPaths = require(path.join(desktopRoot, 'paths.js'));
    const result = packagedPaths.resolveDesktopPaths({
      packaged: true,
      resourcesPath: path.join(packageRoot, 'resources'),
      env: { AB_DATA_DIR: path.join(packageRoot, 'data') },
      homedir: path.join(packageRoot, 'home'),
    });
    assert.equal(result.backendEntry, path.join(packageRoot, 'resources', 'backend', 'server.js'));
    assert.equal(result.dataDir, path.resolve(packageRoot, 'data'));
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});
