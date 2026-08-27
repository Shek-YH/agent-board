'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('桌面窗口隐藏原生菜单栏', () => {
  assert.match(main, /autoHideMenuBar:\s*true/);
  assert.match(main, /mainWindow\.setMenuBarVisibility\(false\)/);
});
