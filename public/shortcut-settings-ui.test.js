'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('设置面板在提示音设置下面提供快捷键设置入口', () => {
  assert.match(app, /id="settings-sound">提示音设置[\s\S]*id="settings-shortcut">快捷键设置/);
  assert.match(app, /pop\.querySelector\('#settings-shortcut'\)\.onclick\s*=\s*openShortcutSettings/);
  assert.match(app, /function openShortcutSettings\(/);
});

test('快捷键页面通过桌面桥接读取、录入并保存快捷键', () => {
  assert.match(index, /shortcut-utils\.js/);
  assert.match(app, /AgentBoardDesktop/);
  assert.match(app, /acceleratorFromKeyboardEvent/);
  assert.match(app, /setShortcutSettings/);
  assert.match(app, /Alt\+`/);
});

test('快捷键页面为最近完成任务提供独立的 Alt+1 配置', () => {
  assert.match(app, /DEFAULT_AGENT_BOARD_JUMP_SHORTCUT\s*=\s*['"]Alt\+1['"]/);
  assert.match(app, /跳转到最近完成任务/);
  assert.match(app, /inputId:\s*['"]jump-shortcut-input['"]/);
  assert.match(app, /kind:\s*['"]jumpToLatestCompleted['"]/);
  assert.match(app, /setShortcutSettings\(shortcut,\s*def\.kind\)/);
});
