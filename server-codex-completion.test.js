'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('Codex 完成状态由防抖后的 task_complete 决定，不再走静默完成检测', () => {
  assert.match(source, /store\.migrateCodexCompletionSignals\(\);/);
  assert.doesNotMatch(source, /idleCheck\.checkCodexIdle\(store\)/);
  assert.match(source, /store\.noteCodexActivity\(`codex:\$\{j\.adapter\.fileToSessionId\(j\.file\)\}`/);
  assert.match(source, /codex\.reconcileRecentCompletions\(store\);/);
});

test('Codex 不使用不可靠的进程名检查强制结束仍有日志的会话', () => {
  assert.doesNotMatch(source, /codex:\s*\[/);
});

test('服务启动时清理历史 Codex 进程误判的停止标记', () => {
  assert.match(source, /store\.setAgentStopped\('codex', false, Date\.now\(\)\);/);
});
