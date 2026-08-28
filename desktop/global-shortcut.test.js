'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const modulePath = path.join(__dirname, 'global-shortcut.js');

test('全局快捷键控制器注册新快捷键并释放旧快捷键', () => {
  assert.ok(fs.existsSync(modulePath), 'global-shortcut.js should exist');
  const { createGlobalShortcutController } = require('./global-shortcut');
  const calls = [];
  const fakeGlobalShortcut = {
    register(accelerator) { calls.push(['register', accelerator]); return true; },
    unregister(accelerator) { calls.push(['unregister', accelerator]); },
  };
  let activated = 0;
  const controller = createGlobalShortcutController({
    globalShortcut: fakeGlobalShortcut,
    onActivate: () => { activated += 1; },
  });

  assert.deepEqual(controller.apply('Alt+`'), { ok: true, accelerator: 'Alt+`', changed: true });
  assert.deepEqual(controller.apply('Control+Shift+B'), { ok: true, accelerator: 'Control+Shift+B', changed: true });
  assert.deepEqual(calls, [
    ['register', 'Alt+`'],
    ['register', 'Control+Shift+B'],
    ['unregister', 'Alt+`'],
  ]);
  assert.equal(controller.current, 'Control+Shift+B');
  controller.dispose();
  assert.deepEqual(calls.at(-1), ['unregister', 'Control+Shift+B']);
  assert.equal(activated, 0);
});

test('快捷键被占用时保留当前快捷键，并返回可展示错误', () => {
  assert.ok(fs.existsSync(modulePath), 'global-shortcut.js should exist');
  const { createGlobalShortcutController } = require('./global-shortcut');
  const calls = [];
  const fakeGlobalShortcut = {
    register(accelerator) { calls.push(['register', accelerator]); return accelerator !== 'Alt+`'; },
    unregister(accelerator) { calls.push(['unregister', accelerator]); },
  };
  const controller = createGlobalShortcutController({ globalShortcut: fakeGlobalShortcut });
  controller.apply('Control+Shift+B');
  const result = controller.apply('Alt+`');
  assert.equal(result.ok, false);
  assert.equal(result.accelerator, 'Control+Shift+B');
  assert.match(result.error, /占用|不可用/);
  assert.deepEqual(calls, [
    ['register', 'Control+Shift+B'],
    ['register', 'Alt+`'],
  ]);
});
