'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

test('session card stacking helper script loads before app.js', () => {
  assert.match(html, /<script src="\/session-card-stacking\.js"><\/script>\n<script src="\/app\.js"><\/script>/);
});

test('app initializes the subagent card display state from the helper', () => {
  assert.match(app, /const sessionCardStacking = window\.AgentBoardSessionStacking;[\s\S]*?const state = \{/);
  assert.match(app, /subagentCardStyle:\s*sessionCardStacking\.loadSubagentCardStyle\(subagentStorage\)/);
  assert.match(app, /expandedSubagentGroups:\s*new Set\(\)/);
});

test('Agent display settings expose flat and stacked subagent card radios with Chinese labels', () => {
  const manager = app.match(/function openColManager\(\)\s*\{[\s\S]*?\n\}\n\$\('btn-settings-hub'\)/)?.[0] || '';
  assert.match(manager, /<fieldset[\s\S]*name="subagent-card-style"/);
  assert.match(manager, /type="radio"[^>]*name="subagent-card-style"[^>]*value="flat"/);
  assert.match(manager, /type="radio"[^>]*name="subagent-card-style"[^>]*value="stacked"/);
  assert.match(manager, /平铺卡片/);
  assert.match(manager, /卡片对叠/);
});

test('changing subagent card style saves the checked value, clears expanded groups, and rerenders immediately', () => {
  const manager = app.match(/function openColManager\(\)\s*\{[\s\S]*?\n\}\n\$\('btn-settings-hub'\)/)?.[0] || '';
  assert.match(manager, /subagent-card-style/);
  assert.match(manager, /if \(![^\n]*\.checked\) return/);
  assert.match(manager, /sessionCardStacking\.saveSubagentCardStyle\(subagentStorage/);
  assert.match(manager, /state\.subagentCardStyle\s*=/);
  assert.match(manager, /state\.expandedSubagentGroups\.clear\(\)/);
  assert.match(manager, /renderBoard\(\)/);
});

test('restoring Agent display defaults also resets the subagent card style and expansion state', () => {
  const reset = app.match(/pop\.querySelector\('#cols-reset'\)\.onclick\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\};/)?.[0] || '';
  assert.match(reset, /sessionCardStacking\.saveSubagentCardStyle\(subagentStorage,\s*'flat'\)/);
  assert.match(reset, /state\.subagentCardStyle\s*=\s*'flat'/);
  assert.match(reset, /state\.expandedSubagentGroups\.clear\(\)/);
});

test('localStorage property access is protected so unavailable storage cannot break the board or settings', () => {
  assert.match(app, /let subagentStorage\s*=\s*null\s*;[\s\S]*?try\s*\{\s*subagentStorage\s*=\s*window\.localStorage\s*;\s*\}\s*catch/);
});
