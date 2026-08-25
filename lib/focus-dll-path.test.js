'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveFocusDll } = require('./focus-dll-path');

test('焦点 DLL 优先使用环境变量路径', () => {
  assert.equal(resolveFocusDll({
    env: { AGENT_BOARD_FOCUS_DLL: 'D:\\AgentBoard\\wf.dll' },
    backendDir: 'C:\\App\\backend',
  }), 'D:\\AgentBoard\\wf.dll');
});

test('焦点 DLL 优先使用后端资源中的预编译 DLL', () => {
  const backendDir = 'C:\\App\\backend';
  assert.equal(resolveFocusDll({
    env: {},
    backendDir,
    existsSync: file => file === backendDir + '\\tools\\wf.dll',
  }), backendDir + '\\tools\\wf.dll');
});

test('没有打包 DLL 时回退到用户配置目录', () => {
  assert.equal(resolveFocusDll({
    env: {},
    backendDir: 'C:\\App\\backend',
    homedir: 'C:\\Users\\test',
    existsSync: () => false,
  }), 'C:\\Users\\test\\.agent-board\\wf.dll');
});
