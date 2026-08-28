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

test('stacked board rendering groups sessions while flat rendering keeps one card per session', () => {
  const render = app.match(/function renderBoard\(\)\s*\{[\s\S]*?\n\}\n\n\/\/ 隐藏一个 Agent/)?.[0] || '';
  assert.match(render, /if \(state\.subagentCardStyle === 'stacked'\)/);
  assert.match(render, /const groups = sessionCardStacking\.groupSessions\(list\)/);
  assert.match(render, /buildSessionCardGroup\(item, key\)/);
  assert.match(render, /buildCard\(item\.session, key\)/);
  assert.match(render, /for \(const s of list\) cardsBox\.appendChild\(buildCard\(s, key\)\)/);
});

test('stacked groups render a contextual root card and indexed child cards', () => {
  const group = app.match(/function buildSessionCardGroup\([\s\S]*?\n\}\n\nfunction buildCard/)?.[0] || '';
  assert.match(group, /className = 'session-card-group\s*'/);
  assert.match(group, /dataset\.rootRef = group\.root\.id/);
  assert.match(group, /is-expanded.*is-stacked|is-stacked.*is-expanded/);
  assert.match(group, /buildCard\(group\.root, colKey, \{ expanded, childCount \}\)/);
  assert.match(group, /className = 'session-card-children'/);
  assert.match(group, /buildCard\(child, colKey\)/);
  assert.match(group, /stack-child-card/);
  assert.match(group, /--stack-index/);
});

test('only grouped main cards expose an accessible toggle and expansion sync excludes card opening', () => {
  assert.match(app, /function buildCard\(s, colKey, groupContext = null\)/);
  assert.match(app, /classList\.add\('has-subagent-toggle',\s*'stack-main-card'\)/);
  assert.match(app, /class="s-subagent-toggle"/);
  assert.match(app, /data-child-count="\$\{groupContext\.childCount\}"/);
  assert.match(app, /aria-expanded="\$\{groupContext\.expanded \? 'true' : 'false'\}"/);
  assert.match(app, /function toggleSubagentGroup\(rootRef\)/);
  assert.match(app, /state\.expandedSubagentGroups\.(?:add|delete)\(rootRef\)/);
  assert.match(app, /syncSubagentGroupExpansion\(rootRef\)/);
  assert.match(app, /function syncSubagentGroupExpansion\(rootRef\)/);
  assert.match(app, /button\.setAttribute\('aria-label', label\)/);
  assert.match(app, /button\.title = label/);
  assert.match(app, /e\.target\.closest\('\.s-subagent-toggle'\)/);
  const cardClick = app.match(/card\.addEventListener\('click',[\s\S]*?\n\s*\}\);/)?.[0] || '';
  assert.match(cardClick, /e\.target\.closest\('\.s-subagent-toggle'\)/);
});
