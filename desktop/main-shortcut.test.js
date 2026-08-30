'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');

test('Electron 主进程接入全局快捷键、IPC 设置和 preload', () => {
  assert.match(source, /globalShortcut/);
  assert.match(source, /ipcMain/);
  assert.match(source, /preload:\s*path\.join\(__dirname, ['"]preload\.js['"]\)/);
  assert.match(source, /shortcut:get/);
  assert.match(source, /shortcut:set/);
  assert.match(source, /will-quit/);
});

test('Electron 主进程接入最近完成任务快捷键事件和独立配置', () => {
  assert.match(source, /jumpToLatestCompleted/);
  assert.match(source, /shortcut:jump-latest-completed/);
  assert.match(source, /did-finish-load/);
  assert.match(source, /activeJumpToLatestCompleted/);
  assert.match(preload, /onJumpToLatestCompleted/);
  assert.match(preload, /shortcut:jump-latest-completed/);
});
