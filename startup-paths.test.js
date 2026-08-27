'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = __dirname;
const STARTUP_FILES = [
  'launch.vbs',
  'start-server.vbs',
  'agent-board-watchdog.vbs',
  'agent-board-watchdog.bat',
  'agent-board-watchdog.js',
  'start.bat',
  'start.sh',
];
const LEGACY_ROOT = String.raw`C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10\agent-board`;
const LEGACY_NODE = String.raw`C:\Program Files\nodejs\node.exe`;

test('启动入口不再写死 A 电脑的项目根目录或 Node 路径', () => {
  for (const name of STARTUP_FILES) {
    const content = fs.readFileSync(path.join(ROOT, name), 'utf8');
    assert.equal(content.includes(LEGACY_ROOT), false, `${name} 仍包含旧项目路径`);
    assert.equal(content.includes(LEGACY_NODE), false, `${name} 仍包含旧 Node 路径`);
  }
});

test('启动入口从自身目录或当前运行时解析项目和 Node', () => {
  const vbsFiles = ['launch.vbs', 'start-server.vbs', 'agent-board-watchdog.vbs'];
  for (const name of vbsFiles) {
    const content = fs.readFileSync(path.join(ROOT, name), 'utf8');
    assert.match(content, /WScript\.ScriptFullName/);
    assert.match(content, /runtime/i);
  }

  const bat = fs.readFileSync(path.join(ROOT, 'agent-board-watchdog.bat'), 'utf8');
  assert.match(bat, /%~dp0/i);

  const startBat = fs.readFileSync(path.join(ROOT, 'start.bat'), 'utf8');
  assert.match(startBat, /%~dp0.*runtime\\node\.exe/i);
  assert.match(startBat, /where node/i);
  assert.match(startBat, /if errorlevel 1/i);

  const watchdog = fs.readFileSync(path.join(ROOT, 'agent-board-watchdog.js'), 'utf8');
  assert.match(watchdog, /__dirname/);
  assert.match(watchdog, /process\.execPath/);

  const shell = fs.readFileSync(path.join(ROOT, 'start.sh'), 'utf8');
  assert.match(shell, /command -v node/);
  assert.match(shell, /未找到|not found|安装 Node/i);
});

test('Windows VBS 启动入口会读取运行 marker 的实际端口，避免误打开固定旧端口', () => {
  for (const name of ['launch.vbs', 'start-server.vbs', 'agent-board-watchdog.vbs']) {
    const content = fs.readFileSync(path.join(ROOT, name), 'utf8');
    assert.match(content, /LOCALAPPDATA/i, `${name} 未读取用户数据目录`);
    assert.match(content, /\.runtime\.json/i, `${name} 未读取运行 marker`);
    assert.match(content, /"port"/i, `${name} 未解析 marker 端口`);
  }
});

test('状态接口暴露启动时运行时身份，便于识别旧 server 进程', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /buildRuntimeIdentity/);
  assert.match(server, /serverRoot:\s*__dirname/);
  assert.match(server, /serverEntry:\s*__filename/);
  assert.match(server, /runtime:\s*RUNTIME_IDENTITY/);
});
