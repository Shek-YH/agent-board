'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// 2026-09-07：用户暂时关闭完成会话系统弹窗，只保留语音通知完成。
// IPC 通道（notification:completion）+ main 的 showAgentCompletionNotification 已停用。
// 后续若要恢复，参考 git 历史（commit c9e814b 起的版本）并恢复本测试为正向断言。

test('完成会话系统弹窗通道已停用，仅保留语音通知完成', () => {
  // 主进程不应再处理 notification:completion IPC、调用 Notification 弹窗、导出弹窗函数
  assert.doesNotMatch(main, /ipcMain\.handle\(['"]notification:completion['"]/);
  assert.doesNotMatch(main, /function showAgentCompletionNotification/);
  assert.doesNotMatch(main, /new Notification\(\{[\s\S]{0,200}已完成/);
  // preload 的 notifyCompletion 通道占位（无 IPC 调用），renderer 不再调用
  assert.doesNotMatch(preload, /ipcRenderer\.invoke\(['"]notification:completion['"]/);
  assert.doesNotMatch(renderer, /AgentBoardDesktop\?\.notifyCompletion\?/);
});
