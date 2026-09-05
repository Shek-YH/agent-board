# Project Todo Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the project selector beside the conversation search field and add a global Todo drawer that stays hidden at the left edge until hover or shortcut activation.

**Architecture:** Keep the existing vanilla HTML/CSS/JS architecture. Extend the existing JSON store with a global `todoTasks` collection and expose a small REST surface; keep drawer UI state in a dedicated browser controller and task business rules in a testable Node service. Reuse the existing Electron global shortcut registry for the Todo toggle command.

**Requirement revision:** Todo tasks are manually added global items and no longer follow or require the selected project. The default Todo toggle shortcut is `Alt+Q`.

**Tech Stack:** Electron 44, Node.js built-in test runner, vanilla browser JavaScript/CSS, existing JSON persistence.

---

### Task 1: Add testable Todo service rules

**Files:**
- Create: `lib/todo-service.js`
- Create: `lib/todo-service.test.js`

- [x] **Step 1: Write tests** for create, one-level parent validation, cascade completion, indeterminate parent state, auto-complete, and cascade delete using an in-memory repository.
- [x] **Step 2: Establish the test-first failure condition, then run the service tests after implementation and confirm they pass.**
- [x] **Step 3: Implement the minimal service with 1–500 character title validation, same-project parent validation, and parent/child completion rules.**
- [x] **Step 4: Run `node --test lib/todo-service.test.js` and verify all service tests pass.**

### Task 2: Persist Todo records and expose REST APIs

**Files:**
- Modify: `lib/store.js`
- Modify: `server.js`

- [x] **Step 1: Add `todoTasks` loading/saving and repository adapters without changing session data behavior.**
- [x] **Step 2: Add `GET /api/todos`, `POST /api/todos`, `PATCH /api/todos/:id`, and `DELETE /api/todos/:id`; return JSON errors for invalid parent/title input.**
- [x] **Step 3: Run `node --test lib/todo-service.test.js` and a direct server syntax check.**

### Task 3: Add project selector and drawer UI

**Files:**
- Create: `public/project-todo.js`
- Modify: `public/index.html`
- Modify: `public/app.js`

- [x] **Step 1: Move the existing project select into `.filters` immediately after `#f-q`, and wire it to the board's existing `state.project` filter.**
- [x] **Step 2: Remove the old visible project rail from the board grid so it no longer competes with the left-edge drawer.**
- [x] **Step 3: Implement the hidden edge trigger and overlay drawer with 80 ms open delay, 300 ms close delay, pinned mode, width persistence, hover preference, hide-completed preference, ESC behavior, blur behavior, and interaction lock.**
- [x] **Step 4: Implement global task rendering and API-backed add/edit/delete/toggle/subtask/collapse/progress interactions.**
- [x] **Step 5: Load the controller before `app.js`, synchronize it after project state loads/switches, and expose user-visible error notifications through the existing toast behavior.**

### Task 4: Reuse the desktop shortcut registry

**Files:**
- Modify: `desktop/shortcut-settings.js`
- Modify: `desktop/global-shortcut.js` only if the existing controller needs no changes (otherwise leave unchanged)
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `public/app.js`
- Modify: `desktop/shortcut-settings.test.js`
- Modify: `desktop/main-shortcut.test.js`

- [x] **Step 1: Add `toggleProjectTodoDrawer` to the existing settings object with the non-conflicting default `Alt+Q`.**
- [x] **Step 2: Register the command through the existing Electron `globalShortcut` controller and forward it to the renderer.**
- [x] **Step 3: Add it to the existing shortcut settings UI and verify all three shortcut values remain conflict-checked.**
- [x] **Step 4: Run the shortcut tests and the full `node --test` suite.**

### Task 5: Final verification

**Files:**
- Test only; no additional product files.

- [x] **Step 1: Run `node --test` from `agent-board-main`.**
- [x] **Step 2: Run `node --check server.js`, `node --check lib/store.js`, `node --check lib/todo-service.js`, `node --check public/app.js`, and `node --check public/project-todo.js`.**
- [x] **Step 3: Inspect the final diff and verify only the active `agent-board-main` worktree was changed.**
