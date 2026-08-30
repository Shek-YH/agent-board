'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { inspectWorkBuddyPlugin } = require('./workbuddy-plugin');

test('检测 WorkBuddy 已安装且启用的 Agent Board 插件版本', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-plugin-state-'));
  const installPath = path.join(home, '.workbuddy', 'plugins', 'cache', 'agent-board', 'agent-board-workbuddy', '1.0.0');
  const settingsPath = path.join(home, '.workbuddy', 'settings.json');
  const installedPath = path.join(home, '.workbuddy', 'plugins', 'installed_plugins.json');
  try {
    fs.mkdirSync(path.join(installPath, '.codebuddy-plugin'), { recursive: true });
    fs.writeFileSync(path.join(installPath, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({
      name: 'agent-board-workbuddy', version: '1.0.0', hooks: './hooks/hooks.json',
    }));
    fs.writeFileSync(installedPath, JSON.stringify({ version: 2, plugins: {
      'agent-board-workbuddy@agent-board': [{ scope: 'user', installPath, version: '1.0.0' }],
    }}));
    fs.writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { 'agent-board-workbuddy@agent-board': true } }));

    const health = inspectWorkBuddyPlugin({ homedir: home });
    assert.deepEqual(health, {
      installed: true,
      enabled: true,
      version: '1.0.0',
      installPath: path.resolve(installPath),
      source: 'installed_plugins',
      gitBash: health.gitBash,
    });
    assert.equal(health.gitBash.required, process.platform === 'win32');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('插件缺失或配置损坏时返回可展示的安全状态', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-plugin-empty-'));
  try {
    const health = inspectWorkBuddyPlugin({ homedir: home });
    assert.deepEqual(health, {
      installed: false,
      enabled: false,
      version: null,
      installPath: null,
      source: null,
      gitBash: health.gitBash,
    });
    assert.equal(health.gitBash.required, process.platform === 'win32');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Windows command Hook 健康检查能识别 Git Bash 路径', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-plugin-git-bash-'));
  const gitBash = path.join(home, 'Git', 'bin', 'bash.exe');
  try {
    fs.mkdirSync(path.dirname(gitBash), { recursive: true });
    fs.writeFileSync(gitBash, '');
    const health = inspectWorkBuddyPlugin({
      homedir: home,
      platform: 'win32',
      env: { CODEBUDDY_CODE_GIT_BASH_PATH: gitBash },
    });
    assert.deepEqual(health.gitBash, { required: true, available: true, path: path.resolve(gitBash) });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
