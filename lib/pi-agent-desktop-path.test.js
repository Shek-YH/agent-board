'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolvePiAgentDesktopExe } = require('./pi-agent-desktop-path');

test('Pi Agent Desktop 优先使用环境变量路径', () => {
  const result = resolvePiAgentDesktopExe({
    homedir: 'C:\\Users\\test',
    env: { PI_AGENT_DESKTOP_EXE: 'D:\\Apps\\pi-agent-desktop.exe' },
    existsSync: file => file === 'D:\\Apps\\pi-agent-desktop.exe',
  });

  assert.equal(result, 'D:\\Apps\\pi-agent-desktop.exe');
});

test('Pi Agent Desktop 回退到 Windows 默认安装路径', () => {
  const home = 'C:\\Users\\test';
  const result = resolvePiAgentDesktopExe({
    homedir: home,
    env: {},
    existsSync: file => file.endsWith('Pi Agent\\pi-agent-desktop.exe'),
  });

  assert.equal(result, `${home}\\AppData\\Local\\Pi Agent\\pi-agent-desktop.exe`);
});

test('Pi Agent Desktop 支持 macOS 应用包路径', () => {
  const result = resolvePiAgentDesktopExe({
    platform: 'darwin',
    homedir: '/Users/test',
    env: {},
    existsSync: file => file === '/Users/test/Applications/Pi Agent.app/Contents/MacOS/Pi Agent',
  });
  assert.equal(result, '/Users/test/Applications/Pi Agent.app/Contents/MacOS/Pi Agent');
});
