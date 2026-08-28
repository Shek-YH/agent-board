# Subagent Card Stacking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent flat/stacked subagent card display choice and let each stacked main-session card toggle its descendants between compact peeks and full cards.

**Architecture:** Put topology grouping and preference normalization in a small browser/Node-compatible pure module, then keep `app.js` responsible only for DOM assembly and event wiring. Reuse the existing `buildCard` implementation for every card so status, read, jump, copy, and popover behavior stay unchanged; CSS controls only group geometry.

**Tech Stack:** Vanilla JavaScript, browser DOM, localStorage, CSS, Node.js built-in test runner (`node:test`).

---

## File structure

- Create `public/session-card-stacking.js`: pure grouping and display-preference functions, exported to both `window` and CommonJS.
- Create `public/session-card-stacking.test.js`: behavior tests for grouping, malformed topology, and preference persistence.
- Create `public/session-card-stacking-ui.test.js`: front-end wiring and CSS contract tests following the repository's existing source-contract test style.
- Modify `public/index.html`: load the helper before `app.js` and add group/settings styles.
- Modify `public/app.js`: initialize preference state, render grouped cards, wire expand/collapse, and extend Agent display settings.

### Task 1: Pure session grouping and preference module

**Files:**
- Create: `public/session-card-stacking.js`
- Create: `public/session-card-stacking.test.js`
- Modify: `public/index.html:574-577`

- [ ] **Step 1: Write the failing grouping and storage tests**

Create `public/session-card-stacking.test.js` with real behavior assertions:

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SUBAGENT_CARD_STYLE_KEY,
  groupSessions,
  loadSubagentCardStyle,
  saveSubagentCardStyle,
} = require('./session-card-stacking');

function session(id, role, parent = null) {
  return { id, session_role: role, parent_session_ref: parent };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('groups direct and nested children under their visible root while preserving child order', () => {
  const root = session('codex:root', 'main');
  const childB = session('codex:b', 'child', 'codex:a');
  const childA = session('codex:a', 'child', 'codex:root');
  const unrelated = session('codex:other', 'main');

  assert.deepEqual(groupSessions([childB, root, unrelated, childA]), [
    { type: 'group', root, children: [childB, childA] },
    { type: 'session', session: unrelated },
  ]);
});

test('leaves missing-parent and cyclic children visible as standalone sessions', () => {
  const orphan = session('codex:orphan', 'child', 'codex:missing');
  const cycleA = session('codex:a', 'child', 'codex:b');
  const cycleB = session('codex:b', 'child', 'codex:a');

  assert.deepEqual(groupSessions([orphan, cycleA, cycleB]), [
    { type: 'session', session: orphan },
    { type: 'session', session: cycleA },
    { type: 'session', session: cycleB },
  ]);
});

test('loads flat by default, restores valid values, and normalizes invalid values', () => {
  assert.equal(loadSubagentCardStyle(memoryStorage()), 'flat');
  assert.equal(loadSubagentCardStyle(memoryStorage({ [SUBAGENT_CARD_STYLE_KEY]: 'stacked' })), 'stacked');
  assert.equal(loadSubagentCardStyle(memoryStorage({ [SUBAGENT_CARD_STYLE_KEY]: 'tree' })), 'flat');
  assert.equal(loadSubagentCardStyle({ getItem() { throw new Error('blocked'); } }), 'flat');
});

test('saves only normalized display styles without throwing when storage is unavailable', () => {
  const storage = memoryStorage();
  assert.equal(saveSubagentCardStyle(storage, 'stacked'), 'stacked');
  assert.equal(storage.getItem(SUBAGENT_CARD_STYLE_KEY), 'stacked');
  assert.equal(saveSubagentCardStyle(storage, 'tree'), 'flat');
  assert.doesNotThrow(() => saveSubagentCardStyle({ setItem() { throw new Error('blocked'); } }, 'flat'));
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --test public/session-card-stacking.test.js
```

Expected: FAIL with `Cannot find module './session-card-stacking'`.

- [ ] **Step 3: Implement the minimal pure module**

Create `public/session-card-stacking.js`:

```js
'use strict';

(function initSessionCardStacking(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentBoardSessionStacking = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const SUBAGENT_CARD_STYLE_KEY = 'ab-subagent-card-style';

  function normalizeSubagentCardStyle(value) {
    return value === 'stacked' ? 'stacked' : 'flat';
  }

  function loadSubagentCardStyle(storage) {
    try {
      return normalizeSubagentCardStyle(storage.getItem(SUBAGENT_CARD_STYLE_KEY));
    } catch {
      return 'flat';
    }
  }

  function saveSubagentCardStyle(storage, value) {
    const normalized = normalizeSubagentCardStyle(value);
    try { storage.setItem(SUBAGENT_CARD_STYLE_KEY, normalized); } catch {}
    return normalized;
  }

  function findVisibleRoot(session, byId) {
    if (!session || session.session_role !== 'child') return null;
    const visited = new Set([session.id]);
    let current = session;
    while (current && current.session_role === 'child' && current.parent_session_ref) {
      const parentRef = current.parent_session_ref;
      if (visited.has(parentRef)) return null;
      visited.add(parentRef);
      const parent = byId.get(parentRef);
      if (!parent) return null;
      if (parent.session_role === 'main') return parent;
      if (parent.session_role !== 'child') return null;
      current = parent;
    }
    return null;
  }

  function groupSessions(list) {
    const sessions = Array.isArray(list) ? list : [];
    const byId = new Map(sessions.filter((item) => item && item.id).map((item) => [item.id, item]));
    const rootByChild = new Map();
    const childrenByRoot = new Map();

    for (const item of sessions) {
      const rootSession = findVisibleRoot(item, byId);
      if (!rootSession) continue;
      rootByChild.set(item.id, rootSession.id);
      if (!childrenByRoot.has(rootSession.id)) childrenByRoot.set(rootSession.id, []);
      childrenByRoot.get(rootSession.id).push(item);
    }

    const output = [];
    for (const item of sessions) {
      if (rootByChild.has(item.id)) continue;
      const children = childrenByRoot.get(item.id);
      output.push(children && children.length
        ? { type: 'group', root: item, children }
        : { type: 'session', session: item });
    }
    return output;
  }

  return {
    SUBAGENT_CARD_STYLE_KEY,
    groupSessions,
    loadSubagentCardStyle,
    normalizeSubagentCardStyle,
    saveSubagentCardStyle,
  };
});
```

Add this script immediately before `app.js` in `public/index.html`:

```html
<script src="/session-card-stacking.js"></script>
<script src="/app.js"></script>
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
node --test public/session-card-stacking.test.js
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 5: Commit the pure module**

```powershell
git add -- public/session-card-stacking.js public/session-card-stacking.test.js public/index.html
git commit -m "feat: group subagent session cards"
```

### Task 2: Display-style state and Agent settings UI

**Files:**
- Create: `public/session-card-stacking-ui.test.js`
- Modify: `public/app.js:3-29`
- Modify: `public/app.js:1805-1885`

- [ ] **Step 1: Write the failing settings wiring test**

Create `public/session-card-stacking-ui.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('Agent display settings expose and persist flat or stacked subagent cards', () => {
  assert.match(app, /subagentCardStyle:\s*sessionCardStacking\.loadSubagentCardStyle\(localStorage\)/);
  assert.match(app, /name="subagent-card-style"/);
  assert.match(app, /value="flat"/);
  assert.match(app, /value="stacked"/);
  assert.match(app, /平铺卡片/);
  assert.match(app, /卡片对叠/);
  assert.match(app, /sessionCardStacking\.saveSubagentCardStyle\(localStorage,\s*input\.value\)/);
  assert.match(app, /state\.expandedSubagentGroups\.clear\(\)/);
});

test('the stacking helper loads before the main application', () => {
  const helperIndex = html.indexOf('<script src="/session-card-stacking.js"></script>');
  const appIndex = html.indexOf('<script src="/app.js"></script>');
  assert.ok(helperIndex >= 0 && helperIndex < appIndex);
});
```

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```powershell
node --test public/session-card-stacking-ui.test.js
```

Expected: the script-order test passes and the settings test fails because state and controls are absent.

- [ ] **Step 3: Add preference state and settings controls**

At the top of `public/app.js`, define the module dependency before `state` and add two state fields:

```js
const sessionCardStacking = window.AgentBoardSessionStacking;

const state = {
  agents: [], projects: [], active: [], agentsDef: {},
  project: '', q: '', range: 7, activeRange: 'day', activeProject: '',
  onlyUser: true,
  board: {}, agentIds: [], defaultAgentIds: [], colOrder: null,
  subagentCardStyle: sessionCardStacking.loadSubagentCardStyle(localStorage),
  expandedSubagentGroups: new Set(),
  // keep the existing remaining fields unchanged
};
```

In `openColManager`, insert this markup before the scrollable Agent rows:

```js
let html = `<div class="pop-head">Agent 显示设置 <span style="opacity:.5;font-weight:400">（勾选显示，上下拖动顺序）</span></div>
  <fieldset class="subagent-style-settings">
    <legend>子代理显示样式</legend>
    <label class="subagent-style-option">
      <input type="radio" name="subagent-card-style" value="flat" ${state.subagentCardStyle === 'flat' ? 'checked' : ''}>
      <span><b>平铺卡片</b><small>主会话与子代理保持当前瀑布流</small></span>
    </label>
    <label class="subagent-style-option">
      <input type="radio" name="subagent-card-style" value="stacked" ${state.subagentCardStyle === 'stacked' ? 'checked' : ''}>
      <span><b>卡片对叠</b><small>子代理收在主会话卡片下方</small></span>
    </label>
  </fieldset>
  <div style="padding:6px 8px;max-height:46vh;overflow-y:auto">`;
```

After assigning `pop.innerHTML`, wire immediate persistence and redraw:

```js
pop.querySelectorAll('input[name="subagent-card-style"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    state.subagentCardStyle = sessionCardStacking.saveSubagentCardStyle(localStorage, input.value);
    state.expandedSubagentGroups.clear();
    renderBoard();
  });
});
```

Extend `#cols-reset` before `closePopover()`:

```js
state.subagentCardStyle = sessionCardStacking.saveSubagentCardStyle(localStorage, 'flat');
state.expandedSubagentGroups.clear();
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test public/session-card-stacking.test.js public/session-card-stacking-ui.test.js
```

Expected: 6 tests pass, 0 fail.

- [ ] **Step 5: Commit settings behavior**

```powershell
git add -- public/app.js public/session-card-stacking-ui.test.js
git commit -m "feat: configure subagent card display"
```

### Task 3: Group rendering and per-main-session expand/collapse

**Files:**
- Modify: `public/session-card-stacking-ui.test.js`
- Modify: `public/app.js:741-930`

- [ ] **Step 1: Add failing render-contract tests**

Append to `public/session-card-stacking-ui.test.js`:

```js
test('stacked mode renders root groups and reuses buildCard for every session', () => {
  assert.match(app, /sessionCardStacking\.groupSessions\(list\)/);
  assert.match(app, /function buildSessionCardGroup\(group,\s*colKey\)/);
  assert.match(app, /buildCard\(group\.root,\s*colKey,/);
  assert.match(app, /for \(const \[index, child\] of group\.children\.entries\(\)\)/);
  assert.match(app, /buildCard\(child,\s*colKey\)/);
  assert.match(app, /session-card-group/);
  assert.match(app, /session-card-children/);
});

test('only grouped main cards receive an accessible expand-collapse icon', () => {
  assert.match(app, /class="s-subagent-toggle"/);
  assert.match(app, /aria-expanded="\$\{groupContext\.expanded \? 'true' : 'false'\}"/);
  assert.match(app, /toggleSubagentGroup\(s\.id\)/);
  assert.match(app, /closest\('\.s-subagent-toggle'\)/);
  assert.match(app, /state\.expandedSubagentGroups\.has\(rootRef\)/);
});
```

- [ ] **Step 2: Run the render tests and verify RED**

Run:

```powershell
node --test public/session-card-stacking-ui.test.js
```

Expected: the two new tests fail because grouped rendering and the toggle do not exist.

- [ ] **Step 3: Implement group DOM assembly and state synchronization**

Add before `renderBoard` in `public/app.js`:

```js
function syncSubagentGroupExpansion(rootRef) {
  const expanded = state.expandedSubagentGroups.has(rootRef);
  document.querySelectorAll('#board .session-card-group').forEach((group) => {
    if (group.dataset.rootRef !== rootRef) return;
    group.classList.toggle('is-expanded', expanded);
    group.classList.toggle('is-stacked', !expanded);
    const button = group.querySelector('.s-subagent-toggle');
    if (!button) return;
    const count = Number(button.dataset.childCount || 0);
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    button.title = expanded ? `收拢 ${count} 个子代理` : `展开 ${count} 个子代理`;
  });
}

function toggleSubagentGroup(rootRef) {
  if (state.expandedSubagentGroups.has(rootRef)) state.expandedSubagentGroups.delete(rootRef);
  else state.expandedSubagentGroups.add(rootRef);
  syncSubagentGroupExpansion(rootRef);
}

function buildSessionCardGroup(group, colKey) {
  const expanded = state.expandedSubagentGroups.has(group.root.id);
  const wrapper = document.createElement('div');
  wrapper.className = 'session-card-group ' + (expanded ? 'is-expanded' : 'is-stacked');
  wrapper.dataset.rootRef = group.root.id;
  wrapper.style.setProperty('--stack-count', String(group.children.length));
  wrapper.appendChild(buildCard(group.root, colKey, { expanded, childCount: group.children.length }));

  const children = document.createElement('div');
  children.className = 'session-card-children';
  for (const [index, child] of group.children.entries()) {
    const childCard = buildCard(child, colKey);
    childCard.classList.add('stack-child-card');
    childCard.style.setProperty('--stack-index', String(index + 1));
    children.appendChild(childCard);
  }
  wrapper.appendChild(children);
  return wrapper;
}
```

Replace the final card loop in `renderBoard` with:

```js
if (state.subagentCardStyle === 'stacked') {
  const items = sessionCardStacking.groupSessions(list);
  for (const item of items) {
    cardsBox.appendChild(item.type === 'group'
      ? buildSessionCardGroup(item, key)
      : buildCard(item.session, key));
  }
} else {
  for (const s of list) cardsBox.appendChild(buildCard(s, key));
}
```

Change the signature to `function buildCard(s, colKey, groupContext = null)`. Add `has-subagent-toggle` only when context exists, and append this icon-only button inside the card template after `.s-actions`:

```js
${groupContext ? `<button type="button" class="s-subagent-toggle" data-child-count="${groupContext.childCount}" aria-label="${groupContext.expanded ? '收拢' : '展开'} ${groupContext.childCount} 个子代理" aria-expanded="${groupContext.expanded ? 'true' : 'false'}" title="${groupContext.expanded ? '收拢' : '展开'} ${groupContext.childCount} 个子代理">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
</button>` : ''}
```

Use this class addition after creating the card:

```js
if (groupContext) card.classList.add('has-subagent-toggle', 'stack-main-card');
```

Exclude the toggle from the card click and wire its own click:

```js
if (e.target.closest('.s-jump') || e.target.closest('.s-more') || e.target.closest('.s-flow-dismiss') || e.target.closest('.s-subagent-toggle')) return;
```

```js
card.querySelector('.s-subagent-toggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSubagentGroup(s.id);
});
```

- [ ] **Step 4: Run grouping and UI tests and verify GREEN**

Run:

```powershell
node --test public/session-card-stacking.test.js public/session-card-stacking-ui.test.js public/session-card-layout.test.js public/session-card-topology.test.js public/session-expand-controls.test.js
```

Expected: all focused tests pass with 0 failures.

- [ ] **Step 5: Commit grouped interaction**

```powershell
git add -- public/app.js public/session-card-stacking-ui.test.js
git commit -m "feat: toggle stacked subagent groups"
```

### Task 4: Stacked-card visual treatment and regression verification

**Files:**
- Modify: `public/session-card-stacking-ui.test.js`
- Modify: `public/index.html:103-170`

- [ ] **Step 1: Add the failing CSS contract test**

Append to `public/session-card-stacking-ui.test.js`:

```js
test('compact groups expose one child action row per card and expanded groups restore normal spacing', () => {
  assert.match(html, /\.session-card-group\{[^}]*isolation:isolate/);
  assert.match(html, /\.session-card-group\.is-stacked \.stack-child-card\{[^}]*margin-top:calc\(var\(--stack-peek-height\) - 196px\)/);
  assert.match(html, /--stack-peek-height:48px/);
  assert.match(html, /\.session-card-group\.is-stacked \.stack-child-card:hover\{[^}]*transform:none/);
  assert.match(html, /\.session-card-group\.is-expanded>\.session-card-children\{[^}]*margin-top:10px/);
  assert.match(html, /\.s-subagent-toggle\{/);
  assert.match(html, /\.session-card-group\.is-expanded \.s-subagent-toggle svg\{[^}]*rotate\(180deg\)/);
});
```

- [ ] **Step 2: Run the CSS contract test and verify RED**

Run:

```powershell
node --test public/session-card-stacking-ui.test.js
```

Expected: the new CSS test fails because none of the stacking selectors exist.

- [ ] **Step 3: Add minimal stacked and expanded styles**

Insert after the existing Session card styles in `public/index.html`:

```css
.session-card-group{min-width:0;display:flex;flex-direction:column;isolation:isolate}
.session-card-children{min-width:0;display:flex;flex-direction:column;gap:10px}
.session-card-group .stack-main-card{z-index:100;margin-left:0}
.session-card-group.is-stacked .session-card-children{gap:0}
.session-card-group.is-stacked .stack-child-card{
  --stack-peek-height:48px;
  margin-top:calc(var(--stack-peek-height) - 196px);
  margin-left:min(calc(var(--stack-index) * 4px),16px);
  width:calc(100% - min(calc(var(--stack-index) * 4px),16px));
  z-index:calc(90 - var(--stack-index));
}
.session-card-group.is-stacked .stack-child-card:hover{transform:none}
.session-card-group.is-expanded>.session-card-children{margin-top:10px}
.s-card.has-subagent-toggle .s-row1{padding-right:28px}
.s-subagent-toggle{position:absolute;top:10px;right:10px;z-index:4;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:7px;background:#fff;color:var(--text2);box-shadow:var(--shadow);transition:.15s}
.s-subagent-toggle:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-bg)}
.s-subagent-toggle svg{transition:transform .18s ease}
.session-card-group.is-expanded .s-subagent-toggle svg{transform:rotate(180deg)}
.subagent-style-settings{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:8px 10px;padding:9px;border:1px solid var(--border);border-radius:9px}
.subagent-style-settings legend{padding:0 4px;font-size:11px;font-weight:650;color:var(--text2)}
.subagent-style-option{display:flex;align-items:flex-start;gap:7px;padding:7px;border:1px solid var(--border);border-radius:7px;cursor:pointer}
.subagent-style-option:has(input:checked){border-color:var(--accent);background:var(--accent-bg)}
.subagent-style-option input{margin-top:2px;accent-color:var(--accent)}
.subagent-style-option span{display:flex;min-width:0;flex-direction:column;gap:2px}
.subagent-style-option b{font-size:11px;color:var(--text)}
.subagent-style-option small{font-size:10px;line-height:1.35;color:var(--text3)}
```

- [ ] **Step 4: Run focused and complete verification**

Run:

```powershell
node --test public/session-card-stacking.test.js public/session-card-stacking-ui.test.js
npm test
git diff --check
git status --short
```

Expected: focused tests and the full suite pass with 0 failures; `git diff --check` is silent; status contains only the intended files before the final commit.

- [ ] **Step 5: Commit the visual treatment**

```powershell
git add -- public/index.html public/session-card-stacking-ui.test.js
git commit -m "style: stack subagent session cards"
```

- [ ] **Step 6: Verify the committed tree**

Run:

```powershell
npm test
git diff --check HEAD^
git status --short
```

Expected: the full suite passes, the commit diff has no whitespace errors, and the working tree is clean.
