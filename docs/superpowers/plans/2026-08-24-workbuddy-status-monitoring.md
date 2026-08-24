# WorkBuddy Status Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use WorkBuddy's local SQLite session status as an authoritative completion signal while preventing heartbeat metadata from keeping completed cards fresh or active.

**Architecture:** Add a read-only WorkBuddy status reader with graceful fallback when the database or `node:sqlite` is unavailable. Store the external terminal signal separately from transient heartbeat/idle signals; only a newer real message may clear it. Keep the existing JSONL and heartbeat heuristics as fallback and for sessions not represented in the SQLite database.

**Tech Stack:** Node.js, built-in `node:sqlite` when available, Node test runner, existing in-memory JSON store.

---

### Task 1: Add failing WorkBuddy status and heartbeat regression tests

**Files:**
- Create: `lib/workbuddy-status.test.js`
- Modify: `lib/workbuddy-heartbeat.test.js`

- [x] **Step 1: Test terminal status normalization and unknown-status fallback**
- [x] **Step 2: Test a WorkBuddy terminal status remains done despite heartbeat/idle activity**
- [x] **Step 3: Test a newer real message clears the external terminal status**
- [x] **Step 4: Run the focused tests and confirm they fail for missing behavior**

### Task 2: Add the read-only WorkBuddy SQLite status reader

**Files:**
- Create: `lib/workbuddy-status.js`
- Modify: `lib/adapters/workbuddy.js`

- [x] **Step 1: Implement pure status mapping for `completed`, `terminated`, `error`, active statuses, and unknown statuses**
- [x] **Step 2: Implement a cached read-only `workbuddy.db` reader with a no-op fallback**
- [x] **Step 3: Export `scanSessionStatuses(store)` and invoke it during initial scans and the existing 5-second WorkBuddy monitor**
- [x] **Step 4: Run focused reader tests and confirm they pass**

### Task 3: Make external completion authoritative and stop heartbeat timestamp pollution

**Files:**
- Modify: `lib/store.js`
- Modify: `lib/adapters/workbuddy.js`

- [x] **Step 1: Add an in-memory external terminal marker checked by `isLiveRef()`**
- [x] **Step 2: Clear that marker only for a newer real message, not heartbeat/title metadata**
- [x] **Step 3: Prevent heartbeat/title metadata from advancing an existing session's real `last_seen`**
- [x] **Step 4: Ensure stale database timestamps cannot reapply completion after a newer message**
- [x] **Step 5: Run focused regression tests and confirm they pass**

### Task 4: Verify integration and preserve existing behavior

**Files:**
- Modify: `server.js`
- Modify: `lib/workbuddy-status.test.js`

- [x] **Step 1: Verify the server startup and 5-second monitor call the new status scan without throwing when the database is unavailable**
- [ ] **Step 2: Run all tests with `npm test`** *(当前被既有的 `public/session-expand-controls.test.js` 3 个失败用例阻断，与本次 WorkBuddy 改动无关)*
- [x] **Step 3: Inspect `git diff` and confirm unrelated user changes remain untouched**
- [x] **Step 4: Poll the running board API and confirm completed WorkBuddy sessions stay out of `liveRefs`**
