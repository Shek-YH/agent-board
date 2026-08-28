'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadFunctions(names, extra = {}) {
  const script = names.map((name) => extractFunction(app, name)).join('\n');
  return vm.runInNewContext(`${script}\n({${names.map((name) => `${name}`).join(',')}})`, extra);
}

function fakeClassList(...initial) {
  const values = new Set(initial);
  return {
    add(...classes) { classes.forEach((name) => values.add(name)); },
    remove(...classes) { classes.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      const next = force === undefined ? !values.has(name) : force;
      if (next) values.add(name); else values.delete(name);
      return next;
    },
    contains(name) { return values.has(name); },
  };
}

function fakeGroup(rootRef, childCount) {
  const button = {
    dataset: { childCount: String(childCount) },
    attrs: {},
    title: '',
    setAttribute(name, value) { this.attrs[name] = String(value); },
  };
  return {
    dataset: { rootRef },
    classList: fakeClassList('is-stacked'),
    querySelector(selector) { return selector === '.s-subagent-toggle' ? button : null; },
    button,
  };
}

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

test('toggleSubagentGroup updates both same-root columns and both accessibility states without touching another root', () => {
  const firstColumn = fakeGroup('root-1', 3);
  const secondColumn = fakeGroup('root-1', 3);
  const otherRoot = fakeGroup('root-2', 1);
  const state = { expandedSubagentGroups: new Set() };
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, '#board .session-card-group');
      return [firstColumn, secondColumn, otherRoot];
    },
  };
  const { toggleSubagentGroup } = loadFunctions(['syncSubagentGroupExpansion', 'toggleSubagentGroup'], { state, document });

  toggleSubagentGroup('root-1');
  assert.equal(state.expandedSubagentGroups.has('root-1'), true);
  for (const group of [firstColumn, secondColumn]) {
    assert.equal(group.classList.contains('is-expanded'), true);
    assert.equal(group.classList.contains('is-stacked'), false);
    assert.equal(group.button.attrs['aria-expanded'], 'true');
    assert.equal(group.button.title, '收拢 3 个子代理');
    assert.equal(group.button.attrs['aria-label'], '收拢 3 个子代理');
  }
  assert.equal(otherRoot.classList.contains('is-expanded'), false);
  assert.equal(otherRoot.classList.contains('is-stacked'), true);
  assert.equal(otherRoot.button.attrs['aria-expanded'], undefined);

  toggleSubagentGroup('root-1');
  assert.equal(state.expandedSubagentGroups.has('root-1'), false);
  for (const group of [firstColumn, secondColumn]) {
    assert.equal(group.classList.contains('is-expanded'), false);
    assert.equal(group.classList.contains('is-stacked'), true);
    assert.equal(group.button.attrs['aria-expanded'], 'false');
    assert.equal(group.button.title, '展开 3 个子代理');
    assert.equal(group.button.attrs['aria-label'], '展开 3 个子代理');
  }
  assert.equal(otherRoot.classList.contains('is-expanded'), false);
  assert.equal(otherRoot.classList.contains('is-stacked'), true);
  assert.equal(otherRoot.button.attrs['aria-expanded'], undefined);
});

test('buildSessionCardGroup restores expanded state and passes context only to its root card', () => {
  const calls = [];
  const state = { expandedSubagentGroups: new Set(['root-1']) };
  const document = {
    createElement() {
      const element = {
        className: '',
        dataset: {},
        children: [],
        style: { values: {}, setProperty(name, value) { this.values[name] = String(value); } },
        classList: fakeClassList(),
        appendChild(child) { this.children.push(child); return child; },
      };
      return element;
    },
  };
  const buildCard = (...args) => {
    calls.push(args);
    return {
      classList: fakeClassList(),
      style: { values: {}, setProperty(name, value) { this.values[name] = String(value); } },
    };
  };
  const { buildSessionCardGroup } = loadFunctions(['buildSessionCardGroup'], { state, document, buildCard });
  const root = { id: 'root-1' };
  const childA = { id: 'child-a' };
  const childB = { id: 'child-b' };
  const wrapper = buildSessionCardGroup({ root, children: [childA, childB] }, 'all');

  assert.equal(wrapper.className, 'session-card-group is-expanded');
  assert.equal(wrapper.dataset.rootRef, 'root-1');
  assert.equal(wrapper.style.values['--stack-count'], '2');
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], root);
  assert.equal(calls[0][1], 'all');
  assert.equal(calls[0][2].expanded, true);
  assert.equal(calls[0][2].childCount, 2);
  assert.deepEqual(calls.slice(1).map((args) => args.length), [2, 2]);
  assert.deepEqual(calls.slice(1).map((args) => args[0]), [childA, childB]);
  assert.equal(wrapper.children.length, 2);
  assert.equal(wrapper.children[1].className, 'session-card-children');
  assert.equal(wrapper.children[1].children.length, 2);

  state.expandedSubagentGroups.clear();
  const collapsed = buildSessionCardGroup({ root, children: [childA, childB] }, 'all');
  assert.equal(collapsed.className, 'session-card-group is-stacked');
});

test('stack groups establish an isolated column layout and keep child cards in a column', () => {
  assert.match(html, /\.session-card-group\{[^}]*display:flex[^}]*flex-direction:column[^}]*min-width:0[^}]*isolation:isolate/);
  assert.match(html, /\.session-card-children\{[^}]*display:flex[^}]*flex-direction:column[^}]*min-width:0/);
});

test('compact child cards expose their action rows with indexed offsets and descending layers', () => {
  assert.match(html, /\.session-card-group\.is-stacked[^}]*\.stack-child-card\{[^}]*--stack-peek-height:48px[^}]*margin-top:calc\(var\(--stack-peek-height\) - 196px\)/);
  assert.match(html, /--stack-offset:\s*min\(calc\(var\(--stack-index\) \* [^)]*\),\s*16px\)/);
  assert.match(html, /margin-left:var\(--stack-offset\)/);
  assert.match(html, /width:calc\(100% - var\(--stack-offset\)\)/);
  assert.match(html, /z-index:calc\([^)]*var\(--stack-index\)[^)]*\)/);
  assert.match(html, /\.session-card-group\.is-stacked[^}]*\.stack-main-card\{[^}]*z-index:\s*\d+/);
  assert.match(html, /\.session-card-group\.is-stacked[^}]*\.stack-child-card:hover\{[^}]*transform:none/);
});

test('expanded groups restore full card spacing while retaining the existing card height', () => {
  assert.match(html, /\.session-card-group\.is-expanded\s*>\.session-card-children\{[^}]*margin-top:10px[^}]*gap:10px/);
  assert.match(html, /\.session-card-group\.is-expanded\s*>\.session-card-children\s*>\.stack-child-card\{[^}]*margin-top:0/);
  assert.match(html, /\.s-card\{[^}]*height:196px[^}]*min-height:196px/);
});

test('subagent toggle is a focusable compact control with an expanded chevron state', () => {
  assert.match(html, /\.s-subagent-toggle\{[^}]*position:absolute[^}]*top:[^}]*right:[^}]*width:24px[^}]*height:24px[^}]*border-radius:[^}]*border:/);
  assert.match(html, /\.s-subagent-toggle:hover/);
  assert.match(html, /\.s-subagent-toggle:focus-visible/);
  assert.match(html, /\.s-subagent-toggle\s+svg\{[^}]*transition:transform/);
  assert.match(html, /\.session-card-group\.is-expanded\s+\.s-subagent-toggle\s+svg\{[^}]*transform:rotate\(180deg\)/);
  assert.match(html, /\.has-subagent-toggle\s+\.s-row1\{[^}]*padding-right:/);
});

test('flow card stacking keeps the subagent toggle above the animated border contents', () => {
  assert.match(html, /\.s-card\.flow-red>\.s-subagent-toggle,\.s-card\.flow-green>\.s-subagent-toggle\{[^}]*position:absolute[^}]*z-index:4/);
});

test('Agent display settings use compact selectable cards without inline option styles', () => {
  const manager = app.match(/function openColManager\(\)\s*\{[\s\S]*?\n\}\n\$\('btn-settings-hub'\)/)?.[0] || '';
  const settingsMarkup = manager.match(/<fieldset class="subagent-style-settings">[\s\S]*?<\/fieldset>/)?.[0] || '';
  assert.match(manager, /<fieldset class="subagent-style-settings">/);
  assert.doesNotMatch(manager, /<div class="subagent-style-options">/);
  assert.match(settingsMarkup, /<fieldset class="subagent-style-settings">\s*<legend>[\s\S]*?<\/legend>\s*<label class="subagent-style-option">/);
  assert.match(settingsMarkup, /<\/label>\s*<label class="subagent-style-option">[\s\S]*?<\/label>\s*<\/fieldset>$/);
  assert.match(manager, /<span class="subagent-style-copy">/g);
  assert.doesNotMatch(manager, /<fieldset[^>]*style=/);
  assert.doesNotMatch(manager, /<label[^>]*style=/);
  assert.doesNotMatch(manager, /<span class="subagent-style-copy"[^>]*style=/);
  assert.match(html, /\.subagent-style-settings\{[^}]*display:grid[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.subagent-style-settings\s+legend\{[^}]*grid-column:1\/-1/);
  assert.match(html, /\.subagent-style-option:has\(input:checked\)\{[^}]*border-color:var\(--accent\)[^}]*background:var\(--accent-bg\)/);
  assert.match(html, /\.subagent-style-option\s+input\{[^}]*accent-color:var\(--accent\)/);
  assert.match(html, /\.subagent-style-option:focus-within\{[^}]*box-shadow:/);
  assert.match(html, /\.subagent-style-copy\{[^}]*min-width:0[^}]*overflow-wrap:/);
  assert.match(html, /\.popover:has\(\.subagent-style-settings\)\{[^}]*min-width:min\(300px,calc\(100vw - 24px\)\)/);
});
