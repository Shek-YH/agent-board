'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('Electron 主进程接入全局快捷键、IPC 设置和 preload', () => {
  assert.match(source, /globalShortcut/);
  assert.match(source, /ipcMain/);
  assert.match(source, /preload:\s*path\.join\(__dirname, ['"]preload\.js['"]\)/);
  assert.match(source, /shortcut:get/);
  assert.match(source, /shortcut:set/);
  assert.match(source, /will-quit/);
});
