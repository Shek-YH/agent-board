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
});
