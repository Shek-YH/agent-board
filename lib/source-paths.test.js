'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  getSourcePathsConfigPath,
  loadSourcePathOverrides,
  resolveSourcePaths,
} = require('./source-paths');

test('Windows 默认数据源跟随当前用户和 APPDATA 环境，而不是固定本机目录', () => {
  const paths = resolveSourcePaths({
    platform: 'win32',
    homedir: 'C:\\Users\\fallback',
    env: {
      USERPROFILE: 'D:\\Users\\alice',
      APPDATA: 'E:\\Profiles\\alice\\Roaming',
      LOCALAPPDATA: 'F:\\Profiles\\alice\\Local',
    },
  });

  assert.equal(paths.claude, path.win32.resolve('D:\\Users\\alice\\.claude\\projects'));
  assert.equal(paths.codex, path.win32.resolve('D:\\Users\\alice\\.codex\\sessions'));
  assert.equal(paths.marvis, path.win32.resolve('E:\\Profiles\\alice\\Roaming\\Tencent\\Marvis\\User'));
  assert.equal(paths.hermes, path.win32.resolve('F:\\Profiles\\alice\\Local\\hermes'));
});

test('macOS 默认数据源使用当前用户的 Application Support', () => {
  const paths = resolveSourcePaths({ platform: 'darwin', homedir: '/Users/alice', env: {} });
  assert.equal(paths.marvis, '/Users/alice/Library/Application Support/Tencent/Marvis/User');
  assert.equal(paths.hermes, '/Users/alice/Library/Application Support/hermes');
  assert.equal(paths.codex, '/Users/alice/.codex/sessions');
});

test('用户级 source-paths.json 可覆盖非标准数据源位置', () => {
  const configPath = 'D:\\Users\\alice\\.agent-board\\source-paths.json';
  const overrides = {
    claude: 'G:\\AgentData\\claude-projects',
    codex: {
      root: 'G:\\AgentData\\codex-sessions',
      sessionIndex: 'G:\\AgentData\\codex-index.jsonl',
    },
    workbuddy: {
      root: 'G:\\AgentData\\workbuddy-projects',
      heartbeatDir: 'G:\\AgentData\\workbuddy-heartbeats',
      db: 'G:\\AgentData\\workbuddy.db',
    },
    hermes: { root: 'G:\\AgentData\\hermes', db: 'G:\\AgentData\\hermes.db' },
  };
  const fakeFs = {
    existsSync(file) { return file === configPath; },
    readFileSync(file, encoding) {
      assert.equal(file, configPath);
      assert.equal(encoding, 'utf8');
      return JSON.stringify(overrides);
    },
  };

  assert.equal(
    getSourcePathsConfigPath({ platform: 'win32', homedir: 'D:\\Users\\alice', env: {} }),
    configPath,
  );
  assert.deepEqual(loadSourcePathOverrides({ configPath, fsApi: fakeFs }), overrides);

  const paths = resolveSourcePaths({
    platform: 'win32',
    homedir: 'D:\\Users\\alice',
    env: {},
    overrides,
  });
  assert.equal(paths.claude, path.win32.resolve(overrides.claude));
  assert.equal(paths.codex, path.win32.resolve(overrides.codex.root));
  assert.equal(paths.codexSessionIndex, path.win32.resolve(overrides.codex.sessionIndex));
  assert.equal(paths.workbuddyHeartbeat, path.win32.resolve(overrides.workbuddy.heartbeatDir));
  assert.equal(paths.workbuddyDb, path.win32.resolve(overrides.workbuddy.db));
  assert.equal(paths.hermesDb, path.win32.resolve(overrides.hermes.db));
});

test('损坏或非对象的路径配置会安全回退到默认值', () => {
  const fakeFs = {
    existsSync() { return true; },
    readFileSync() { return '[]'; },
  };
  assert.deepEqual(
    loadSourcePathOverrides({ configPath: 'C:\\bad.json', fsApi: fakeFs }),
    {},
  );
});
