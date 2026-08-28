'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const modulePath = path.join(__dirname, 'shortcut-settings.js');

test('快捷键设置模块提供默认值，并可持久化到用户配置文件', () => {
  assert.ok(fs.existsSync(modulePath), 'shortcut-settings.js should exist');
  const { DEFAULT_SHORTCUT, loadShortcutSettings, saveShortcutSettings } = require('./shortcut-settings');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-shortcuts-'));
  const filePath = path.join(root, 'shortcut-settings.json');
  try {
    assert.deepEqual(loadShortcutSettings(filePath), { activateApp: DEFAULT_SHORTCUT });
    assert.deepEqual(saveShortcutSettings('Control+Shift+B', filePath), { activateApp: 'Control+Shift+B' });
    assert.deepEqual(loadShortcutSettings(filePath), { activateApp: 'Control+Shift+B' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('快捷键设置拒绝空值，并忽略损坏的配置回退到默认值', () => {
  assert.ok(fs.existsSync(modulePath), 'shortcut-settings.js should exist');
  const { DEFAULT_SHORTCUT, loadShortcutSettings, saveShortcutSettings } = require('./shortcut-settings');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-shortcuts-invalid-'));
  const filePath = path.join(root, 'shortcut-settings.json');
  try {
    assert.throws(() => saveShortcutSettings('   ', filePath), /快捷键/);
    fs.writeFileSync(filePath, '{broken', 'utf8');
    assert.deepEqual(loadShortcutSettings(filePath), { activateApp: DEFAULT_SHORTCUT });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
