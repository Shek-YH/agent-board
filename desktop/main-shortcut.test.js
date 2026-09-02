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

test('托盘退出时不拦截 Electron 的最终退出事件', () => {
  assert.match(source, /window-all-closed['"]\s*,\s*\(event\)\s*=>\s*\{\s*if\s*\(!quitting\)\s*event\.preventDefault\(\)\s*;?\s*\}/s);
});

test('Electron 主进程使用 safeStorage 管理 Provider Key，并只向渲染层暴露安全状态', () => {
  assert.match(source, /createSecureStore/);
  assert.match(source, /safeStorage/);
  assert.match(source, /provider:status/);
  assert.match(source, /provider:set-api-key/);
  assert.match(source, /provider:clear-api-key/);
  assert.match(source, /backendEnvironment/);
  assert.match(preload, /setApiKey/);
  assert.match(preload, /clearApiKey/);
});

test('Electron 主进程为托管任务提供本地项目文件夹选择器', () => {
  assert.match(source, /project:select-folder/);
  assert.match(source, /showOpenDialog/);
  assert.match(source, /openDirectory/);
  assert.match(preload, /selectProjectFolder/);
});
