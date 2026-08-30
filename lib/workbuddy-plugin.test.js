'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { installWorkBuddyPlugin, inspectWorkBuddyPlugin } = require('./workbuddy-plugin');

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

test('bootstrap 自动安装并启用插件且保留用户配置', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-bootstrap-'));
  const source = path.join(home, 'source-plugin');
  try {
    fs.mkdirSync(path.join(source, '.codebuddy-plugin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(source, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({
      name: 'agent-board-workbuddy', version: '1.0.0', hooks: './hooks/hooks.json',
    }));
    fs.writeFileSync(path.join(source, 'scripts', 'status-hook.mjs'), 'updated');
    fs.mkdirSync(path.join(home, '.workbuddy', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.workbuddy', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'existing@plugin': true }, customSetting: 'keep',
    }));

    const result = installWorkBuddyPlugin({ sourcePath: source, homedir: home });
    assert.equal(result.ok, true);
    assert.equal(result.enabled, true);
    assert.equal(fs.readFileSync(path.join(result.installPath, 'scripts', 'status-hook.mjs'), 'utf8'), 'updated');
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'settings.json'), 'utf8'));
    assert.equal(settings.customSetting, 'keep');
    assert.equal(settings.enabledPlugins['existing@plugin'], true);
    assert.equal(settings.enabledPlugins['agent-board-workbuddy@agent-board'], true);
    const registry = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'plugins', 'installed_plugins.json'), 'utf8'));
    assert.equal(registry.plugins['agent-board-workbuddy@agent-board'].length, 1);

    installWorkBuddyPlugin({ sourcePath: source, homedir: home });
    const secondRegistry = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'plugins', 'installed_plugins.json'), 'utf8'));
    assert.equal(secondRegistry.plugins['agent-board-workbuddy@agent-board'].length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
