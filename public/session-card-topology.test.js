'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  // 保留 `async` 前缀：漏掉它会让 async 函数体里的 `await` 变成语法错误。
  const prefixStart = start - 'async '.length;
  if (prefixStart >= 0 && source.slice(prefixStart, start) === 'async ') start = prefixStart;
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
  // 被抽取的函数里有 async（如跳转前的权威补全），普通 vm.Script 遇到 `await` 会
  // SyntaxError。vm 的模块加载是异步接口，这里改用「显式提供 async 运行环境」的
  // 方式：把整个脚本包进一个 async IIFE 求值，返回其 Promise 解析出的导出对象。
  const wrapped = `(async () => { ${script}\n; return {${names.join(',')}}; })()`;
  const promise = vm.runInNewContext(wrapped, extra);
  return { promise };
}
// 测试内同步使用导出对象时走这个取件器。
async function loadFunctionsAsync(names, extra = {}) {
  return loadFunctions(names, extra).promise;
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
  // 完整路径保留在 title 中；但数据未读全（is_read_complete === false）时不得展示残缺路径，
  // 改为「读取中…」占位（见下一条断言）。
  assert.match(appSource, /class="s-proj" title="\$\{esc\(readPending \? '' : s\.project\)\}"/);
  assert.match(appSource, /readPending \? '读取中…' : esc\(shortProj\(s\.project\) \|\| '（无项目路径）'\)/);
});

test('unread sessions render placeholders instead of contradicted field values', () => {
  // 会话仍在被读入时，msg_count / project / 末条用户消息都还是初值。
  // 卡片必须把它们显示成「读取中」，而不是「（无项目路径）」「N 条」「（暂无用户指令）」。
  assert.match(appSource, /const readPending = s\.is_read_complete === false/);
  assert.match(appSource, /const lastCmd = readPending\s*\n?\s*\? '数据读取中…'/);
  assert.match(appSource, /readPending \? '读取中' : `\$\{s\.msg_count\} 条`/);
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

test('sessionNavigationId resolves only synthetic Marvis/Hermes children to parent IDs', async () => {
  const { sessionNavigationId } = await loadFunctionsAsync(['sessionNavigationId']);
  assert.equal(sessionNavigationId({ agent: 'marvis', session_role: 'child', session_id: 'conv:subagent:sa', parent_session_ref: 'marvis:conv' }), 'conv');
  assert.equal(sessionNavigationId({ agent: 'hermes', session_role: 'child', session_id: 'hm:subagent:call:0', parent_session_ref: 'hermes:hm' }), 'hm');
  assert.equal(sessionNavigationId({ agent: 'claude', session_role: 'child', session_id: 'c:subagent:1', parent_session_ref: 'claude:c' }), 'c:subagent:1');
  assert.equal(sessionNavigationId({ agent: 'pi', session_role: 'child', session_id: 'pi-child', parent_session_ref: 'pi:pi-main' }), 'pi-child');
  assert.equal(sessionNavigationId({ agent: 'marvis', session_role: 'main', session_id: 'conv', parent_session_ref: 'marvis:root' }), 'conv');
  assert.equal(sessionNavigationId({ agent: 'marvis', session_role: 'child', session_id: 'conv:subagent:sa' }), 'conv:subagent:sa');
  assert.equal(sessionNavigationId({ agent: 'marvis', session_role: 'child', session_id: 'conv:subagent:sa', parent_session_ref: 'hermes:conv' }), 'conv:subagent:sa');
});

test('topologyRoleMarkup renders the shared main, child, and unknown presentation', async () => {
  const { displaySessionId, topologyRoleMarkup } = await loadFunctionsAsync(['displaySessionId', 'topologyRoleMarkup'], {
    esc: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  });
  assert.match(topologyRoleMarkup({ session_role: 'main', child_count: 2, active_child_count: 1 }), /◎ 主会话/);
  assert.match(topologyRoleMarkup({ session_role: 'main', child_count: 2, active_child_count: 1 }), /子代理 2 · 1 活跃/);
  assert.match(topologyRoleMarkup({ session_role: 'child', parent_session_ref: 'marvis:conv' }), /↳ 子代理/);
  assert.match(topologyRoleMarkup({ session_role: 'child', parent_session_ref: 'marvis:conv' }), /父会话 marvis:conv/);
  assert.match(topologyRoleMarkup({ session_role: 'unexpected' }), /\? 未确认/);
  assert.equal(typeof displaySessionId, 'function');
});

test('buildCard preserves child identity while its jump uses the durable parent', async () => {
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
    requestJson: async () => { throw new Error('offline'); },
  };
  const { buildCard } = await loadFunctionsAsync([
    'displaySessionId', 'fmtTimeLabel', 'agentMeta', 'shortProj', 'topologyRoleMarkup', 'isRecentCompleted',
    'runtimeStatusFor', 'statusClass', 'statusMarkup', 'sessionNavigationId', 'jumpToAgentSession',
    'jumpWithResolvedSession', 'dispatchAgentJump', 'buildCard',
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
  // 跳转链路自身是 promise（未读卡片会先做一次权威单会话补全）；本用例伪造的
  // requestJson 必然 reject，因此最终仍走 dispatchAgentJump 的直连分支。
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(jumped, ['conv']);
  assert.equal(child.session_id, 'conv:subagent:sa');
});

test('buildCard keeps a manually completed session completed despite a stale running runtime snapshot', async () => {
  const session = {
    id: 'codex:01a04ee4-4c26-7680-a583-42518889dee3',
    agent: 'codex', session_id: '01a04ee4-4c26-7680-a583-42518889dee3',
    session_role: 'child', title: 'worker', project: 'C:/work', msg_count: 1,
    last_seen: Date.now(), last_user_text: 'inspect file', manual_done: true,
  };
  const state = {
    agentsDef: { codex: { name: 'Codex', color: '#123456' } },
    liveRefs: new Set([session.id]),
    runtimeStatuses: new Map([[session.id, { state: 'running' }]]),
    recentDone: new Map(), dismissedRecent: new Set(),
  };
  const context = {
    state,
    document: { createElement: () => new FakeElement() },
    window: {}, navigator: { clipboard: { writeText: async () => true } },
    esc: (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    RUNTIME_STATUS_LABELS: { completed: '已完成', running: '进行中', unknown: '状态未知' },
    openSession() {}, openCodexThread() {}, openClaudeSession() {}, openWorkBuddySession() {},
    openDeepSeekSession() {}, openZCodeSession() {}, openPiAgentSession() {}, openHermesSession() {},
    launchAgent() {}, dismissRecent() {}, syncFlowDecor() {}, toast() {}, openPopover() {},
  };
  const { buildCard } = await loadFunctionsAsync([
    'displaySessionId', 'fmtTimeLabel', 'agentMeta', 'shortProj', 'topologyRoleMarkup', 'isRecentCompleted',
    'extractCodexThreadId', 'runtimeStatusFor', 'statusClass', 'statusMarkup', 'sessionNavigationId', 'jumpToAgentSession', 'buildCard',
  ], context);
  const card = buildCard(session, 'codex');
  assert.equal(card.dataset.manualDone, '1');
  assert.equal(card.dataset.runtimeStatus, 'completed');
  assert.match(card.className, /done/);
  assert.match(card.innerHTML, /已完成/);
});
