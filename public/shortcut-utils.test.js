'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const modulePath = path.join(__dirname, 'shortcut-utils.js');

function loadUtils() {
  assert.ok(fs.existsSync(modulePath), 'shortcut-utils.js should exist');
  const sandbox = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
  return sandbox.window.AgentBoardShortcutUtils;
}

test('快捷键录入将修饰键和按键转换成 Electron accelerator', () => {
  const utils = loadUtils();
  assert.equal(utils.acceleratorFromKeyboardEvent({ code: 'Backquote', altKey: true }), 'Alt+`');
  assert.equal(utils.acceleratorFromKeyboardEvent({ code: 'KeyB', ctrlKey: true, shiftKey: true }), 'Control+Shift+B');
  assert.equal(utils.acceleratorFromKeyboardEvent({ code: 'KeyB' }), null);
  assert.equal(utils.acceleratorFromKeyboardEvent({ code: 'ControlLeft', ctrlKey: true }), null);
});
