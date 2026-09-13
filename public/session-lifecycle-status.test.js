'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, 'session-lifecycle-status.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source, context, { filename: 'session-lifecycle-status.js' });
  return context.window.AgentBoardSessionLifecycleStatus;
}

test('lifecycle status module maps public states and preserves legacy fallback', () => {
  const module = loadModule();
  assert.equal(module.runtimeStatusValue({ lifecycle_state: 'COMPLETED', state: 'running' }), 'completed');
  assert.equal(module.runtimeStatusValue({ lifecycle_state: 'WAITING_USER', state: 'completed' }), 'waiting_user_input');
  assert.equal(module.runtimeStatusValue({ state: 'failed' }), 'failed');
  assert.equal(module.lifecycleLiveValue({ lifecycle_state: 'ACTIVE' }), true);
  assert.equal(module.lifecycleLiveValue({ lifecycle_state: 'COMPLETED' }), false);
  assert.equal(module.lifecycleLiveValue({ state: 'running' }), null);
});
