'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

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
  const script = names.map((name) => extractFunction(appSource, name)).join('\n');
  return vm.runInNewContext(`${script}\n({${names.map((name) => `${name}`).join(',')}})`, extra);
}

class FakeElement {
  constructor() {
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this._innerHTML = '';
    this.children = new Map();
    this.classList = { add() {}, remove() {} };
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children.clear();
    for (const className of ['s-jump', 's-sid', 's-more', 's-flow-dismiss']) {
      const tag = this._innerHTML.match(new RegExp(`<[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`));
      if (!tag) continue;
      const node = new FakeElement();
      for (const match of tag[0].matchAll(/data-([\w-]+)="([^"]*)"/g)) {
        const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        node.dataset[key] = match[2];
      }
      this.children.set(`.${className}`, node);
    }
  }

  get innerHTML() { return this._innerHTML; }
  querySelector(selector) { return this.children.get(selector) || null; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  getBoundingClientRect() { return { bottom: 0, right: 0 }; }
}

test('session cards render explicit topology badges and relationships', () => {
  assert.match(appSource, /◎ 主会话/);
  assert.match(appSource, /↳ 子代理/);
  assert.match(appSource, /\? 未确认/);
  assert.match(appSource, /parent_session_ref/);
  assert.match(appSource, /child_count/);
  assert.match(appSource, /topology-\$\{topologyRole\}/);
  assert.match(appSource, /card\.dataset\.topologyRole = topologyRole/);
});

test('project labels use the final path segment while retaining the full title', () => {
  assert.match(appSource, /function shortProj\(p\)/);
  assert.equal(appSource.includes('const parts = trimmed.split(/[\\\\/]/).filter(Boolean);'), true);
  assert.match(appSource, /class="s-proj" title="\$\{esc\(s\.project\)\}"/);
});

test('topology badge styles are compact and accessible by text, not color alone', () => {
  assert.match(htmlSource, /\.s-topology-badge\.main/);
  assert.match(htmlSource, /\.s-topology-badge\.child/);
  assert.match(htmlSource, /\.s-topology-badge\.unknown/);
});

test('native jumps resolve synthetic Marvis and Hermes children through their durable parent', () => {
  assert.match(appSource, /function sessionNavigationId\(s\)/);
  assert.match(appSource, /s\.agent === 'marvis' \|\| s\.agent === 'hermes'/);
  assert.match(appSource, /String\(s\.session_id \|\| ''\)\.includes\(':subagent:'\)/);
  assert.match(appSource, /parent_session_ref/);
  assert.match(appSource, /const navigationId = sessionNavigationId\(s\)/);
});

test('sessionNavigationId resolves only synthetic Marvis/Hermes children to parent IDs', () => {
  const { sessionNavigationId } = loadFunctions(['sessionNavigationId']);
  assert.equal(sessionNavigationId({ agent: 'marvis', session_role: 'child', session_id: 'conv:subagent:sa', parent_session_ref: 'marvis:conv' }), 'conv');
  assert.equal(sessionNavigationId({ agent: 'hermes', session_role: 'child', session_id: 'hm:subagent:call:0', parent_session_ref: 'hermes:hm' }), 'hm');
  assert.equal(sessionNavigationId({ agent: 'claude', session_role: 'child', session_id: 'c:subagent:1', parent_session_ref: 'claude:c' }), 'c:subagent:1');
  assert.equal(sessionNavigationId({ agent: 'pi', session_role: 'child', session_id: 'pi-child', parent_session_ref: 'pi:pi-main' }), 'pi-child');
  assert.equal(sessionNavigationId({ agent: 'marvis', session_role: 'main', session_id: 'conv', parent_session_ref: 'marvis:root' }), 'conv');
  assert.equal(sessionNavigationId({ agent: 'marvis', session_role: 'child', session_id: 'conv:subagent:sa' }), 'conv:subagent:sa');
  assert.equal(sessionNavigationId({ agent: 'marvis', session_role: 'child', session_id: 'conv:subagent:sa', parent_session_ref: 'hermes:conv' }), 'conv:subagent:sa');
});

test('topologyRoleMarkup renders the shared main, child, and unknown presentation', () => {
  const { displaySessionId, topologyRoleMarkup } = loadFunctions(['displaySessionId', 'topologyRoleMarkup'], {
    esc: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  });
  assert.match(topologyRoleMarkup({ session_role: 'main', child_count: 2, active_child_count: 1 }), /◎ 主会话/);
  assert.match(topologyRoleMarkup({ session_role: 'main', child_count: 2, active_child_count: 1 }), /子代理 2 · 1 活跃/);
  assert.match(topologyRoleMarkup({ session_role: 'child', parent_session_ref: 'marvis:conv' }), /↳ 子代理/);
  assert.match(topologyRoleMarkup({ session_role: 'child', parent_session_ref: 'marvis:conv' }), /父会话 marvis:conv/);
  assert.match(topologyRoleMarkup({ session_role: 'unexpected' }), /\? 未确认/);
  assert.equal(typeof displaySessionId, 'function');
});

test('buildCard preserves child identity while its jump uses the durable parent', () => {
  const state = {
    agentsDef: { marvis: { name: 'Marvis', color: '#123456' } },
    liveRefs: new Set(), runtimeStatuses: new Map(), recentDone: new Map(), dismissedRecent: new Set(),
  };
  const opened = [];
  const jumped = [];
  const context = {
    state,
    document: { createElement: () => new FakeElement() },
    window: {},
    navigator: { clipboard: { writeText: async () => true } },
    RUNTIME_STATUS_LABELS: { completed: '已完成', unknown: '状态未知' },
    esc: (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    openSession: (ref) => opened.push(ref),
    openMarvisSession: (sessionId) => jumped.push(sessionId),
    openClaudeSession() {}, openCodexThread() {}, openWorkBuddySession() {}, openDeepSeekSession() {},
    openZCodeSession() {}, openPiAgentSession() {}, openHermesSession() {}, launchAgent() {},
    dismissRecent() {}, syncFlowDecor() {}, toast() {}, openPopover() {},
  };
  const { buildCard } = loadFunctions([
    'displaySessionId', 'fmtTimeLabel', 'agentMeta', 'shortProj', 'topologyRoleMarkup', 'isRecentCompleted',
    'runtimeStatusFor', 'statusClass', 'statusMarkup', 'sessionNavigationId', 'jumpToAgentSession', 'buildCard',
  ], context);
  const child = {
    id: 'marvis:conv:subagent:sa', agent: 'marvis', session_id: 'conv:subagent:sa',
    session_role: 'child', parent_session_ref: 'marvis:conv', title: 'worker', project: 'C:/work',
    msg_count: 1, last_seen: Date.now(), last_user_text: 'inspect file',
  };
  const card = buildCard(child, 'marvis');
  assert.equal(card.dataset.sessionId, child.session_id);
  assert.equal(card.dataset.boardSessionId, child.session_id);
  assert.match(card.innerHTML, new RegExp(`data-session-id="${child.session_id}"`));
  assert.match(card.innerHTML, new RegExp(`data-ref="${child.id}"`));
  card.listeners.click({ target: { closest: () => null } });
  assert.deepEqual(opened, [child.id]);
  card.querySelector('.s-jump').listeners.click({ stopPropagation() {} });
  assert.deepEqual(jumped, ['conv']);
  assert.equal(child.session_id, 'conv:subagent:sa');
});
