# Project Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the project dropdown with a project-path sidebar that filters the session board on click.

**Architecture:** Extend the existing project metadata query with each path's latest session timestamp, then keep `state.projects` as the source of project metadata. Render the sidebar beside the existing board; selecting a path updates `state.project` and reloads the same `/api/board` filter already used by the dropdown. CSS controls short-path versus full-path display so no path data is lost.

**Tech Stack:** Vanilla JavaScript, CSS Grid, Node.js built-in test runner.

---

### Task 1: Expose project activity metadata

**Files:**
- Modify: `lib/store.js`
- Create: `lib/store-projects.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('项目统计包含按项目聚合的最新会话时间', () => {
  assert.match(source, /lastSeen: Math\.max\(current\.lastSeen, s\.last_seen \|\| 0\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/store-projects.test.js`

Expected: FAIL because project statistics only expose counts.

- [ ] **Step 3: Implement the minimal project summary extension**

Update `store.stmts.projects.all()` to return `{ project, cnt, lastSeen }` and preserve existing hidden-session filtering.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/store-projects.test.js`

Expected: PASS.

### Task 2: Define the project sidebar contract

**Files:**
- Create: `public/project-sidebar.test.js`
- Modify: `public/index.html`
- Modify: `public/app.js`

- [ ] **Step 1: Write the failing test**

```js
test('项目侧栏按最近会话排序，点击可筛选并可取消', () => {
  assert.match(source, /function projectItems\(\)/);
  assert.match(source, /function toggleProject\(project\)/);
  assert.match(source, /state\.project = state\.project === project \? '' : project/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test public/project-sidebar.test.js`

Expected: FAIL because project sidebar functions do not exist.

- [ ] **Step 3: Implement the minimal data and interaction code**

```js
function projectItems() {
  return state.projects.filter((item) => item.project).sort((a, b) => b.lastSeen - a.lastSeen);
}
function toggleProject(project) {
  state.project = state.project === project ? '' : project;
  loadBoard();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test public/project-sidebar.test.js`

Expected: PASS.

### Task 3: Render the side-by-side project navigator

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Test: `public/project-sidebar.test.js`

- [ ] **Step 1: Extend the failing test for layout and path display**

```js
assert.match(html, /<aside class="project-rail" id="project-rail"><\/aside>/);
assert.match(html, /\.project-rail:hover \.project-path-full/);
assert.match(source, /function renderProjectRail\(\)/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test public/project-sidebar.test.js`

Expected: FAIL because no project rail exists.

- [ ] **Step 3: Implement the layout and renderer**

```html
<div class="board-layout">
  <aside class="project-rail" id="project-rail"></aside>
  <div class="board" id="board"></div>
</div>
```

`renderProjectRail()` must render each path as a button, show only its final path component by default, reveal the entire escaped path while the rail is hovered, and mark the selected project with `.on`.

- [ ] **Step 4: Run the focused and full test suites**

Run: `node --test public/project-sidebar.test.js` and `node --test`

Expected: all tests pass.

- [ ] **Step 5: Verify in the local page**

Check that project items are newest-first, one click filters all agent columns, a second click restores all sessions, and hover changes every project entry from its leaf directory to its full path.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/project-sidebar.test.js docs/superpowers/plans/2026-08-23-project-sidebar.md
git commit -m "feat: add project path sidebar"
```
