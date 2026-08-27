# Session Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist verified main/child/unknown session topology, expose it on session cards, and provide strict main-session target resolution for future AI supervision.

**Architecture:** Add a pure topology module at the storage seam. Adapters emit provider evidence; `lib/store.js` normalizes and persists topology metadata while preserving the existing JSON session format. The UI consumes derived fields and never infers role from status or titles. Control-target resolution is read-only in this plan and rejects ambiguous or child targets.

**Tech Stack:** Node.js built-ins, existing JSON store, native browser JavaScript, Node test runner.

---

### Task 1: Add topology normalization and strict target resolution

**Files:**
- Create: `lib/session-topology.js`
- Create: `lib/session-topology.test.js`

- [x] **Step 1: Write failing tests**

Cover `main`, `child`, and `unknown` normalization; stable parent/root refs; default capability metadata for all eight adapters; child target rejection; unique main resolution; ambiguous resolution; and no-candidate resolution.

- [x] **Step 2: Run the focused test**

Run: `node --test lib/session-topology.test.js`  
Expected: FAIL because `lib/session-topology.js` does not exist.

- [x] **Step 3: Implement the pure module**

Export `AGENT_TOPOLOGY_CAPABILITIES`, `normalizeTopologyMessage(msg)`, `mergeTopology(session, topology)`, `summarizeTopology(sessions, now)`, and `resolveControlTarget(sessions, options)`. Use `main|child|unknown` and `eligible|manual_only|blocked|unknown` exactly as defined by the design. Treat an explicit child signal as authoritative; never fall back to most-recent activity for control resolution.

- [x] **Step 4: Run the focused test**

Run: `node --test lib/session-topology.test.js`  
Expected: PASS.

### Task 2: Persist topology fields in the existing store

**Files:**
- Modify: `lib/store.js`
- Create: `lib/store-topology.test.js`

- [x] **Step 1: Write failing store tests**

Assert that ingesting a main event creates topology fields, a later child event creates a separate child session without erasing the parent, old snapshots load with safe defaults, and `getSessions()` returns child counts, active child counts, `session_role`, `parent_session_ref`, `root_session_ref`, `child_detection`, and `control_eligibility`.

- [x] **Step 2: Run the focused test**

Run: `node --test lib/store-topology.test.js`  
Expected: FAIL because store does not persist or project topology fields.

- [x] **Step 3: Implement minimal store integration**

Normalize `msg` topology before session creation/update, merge only non-empty evidence, migrate missing fields in `load()`, and derive parent summaries in `getSessions()` and `getRecentActive()`. Keep hidden-session behavior, message deduplication, active status, and existing JSON keys unchanged.

- [x] **Step 4: Run focused store tests**

Run: `node --test lib/session-topology.test.js lib/store-topology.test.js`  
Expected: PASS.

### Task 3: Split Claude child files and retain ZCode child sessions

**Files:**
- Modify: `lib/adapters/claude.js`
- Modify: `lib/adapters/zcode.js`
- Create: `lib/adapters/claude-topology.test.js`
- Modify: `lib/adapters/zcode.test.js`

- [x] **Step 1: Add failing adapter tests**

For Claude, pass a synthetic `subagents/agent-abc.jsonl` path and assert the emitted session ID is child-scoped, its parent is the logged parent `sessionId`, and `sessionRole` is `child`; assert a normal project file emits `main`. For ZCode, assert `interactive` is main, `subagent_child` is child, and unknown task types are retained as unknown rather than filtered.

- [x] **Step 2: Run focused adapter tests**

Run: `node --test lib/adapters/claude-topology.test.js lib/adapters/zcode.test.js`  
Expected: FAIL because Claude parsing has no file context and ZCode filters child rows.

- [x] **Step 3: Implement source-specific evidence**

Change Claude `parseLines(lines, filePath)` and pass `filePath` from `scanAll`/`poll`; derive child identity from the `subagents` path and `agentId`, while preserving parent session IDs for ordinary files. Keep `isSidechain` out of whole-session role classification. Change ZCode scans to ingest all task types and attach the normalized role metadata.

- [x] **Step 4: Run focused adapter tests**

Run: `node --test lib/adapters/claude-topology.test.js lib/adapters/zcode.test.js`  
Expected: PASS.

### Task 4: Add capability-aware session target API

**Files:**
- Modify: `server.js`
- Create: `session-topology-api.test.js`

- [x] **Step 1: Write failing HTTP contract tests**

Cover a read-only endpoint that returns `resolved`, `ambiguous`, `not_found`, and `blocked` results; ensure a child `sessionRef` cannot be returned as a target; and ensure no “latest active” fallback is used.

- [x] **Step 2: Implement the read-only endpoint**

Add `GET /api/session-control-target` with `agent`, `project`, and optional `sessionRef` query parameters. Use the topology resolver and return candidates/evidence/reason. Do not dispatch commands or alter leases in this endpoint.

- [x] **Step 3: Run the focused server test**

Run: `node --test session-topology-api.test.js`  
Expected: PASS.

### Task 5: Render topology and last-level project labels in the UI

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Create: `public/session-card-topology.test.js`

- [x] **Step 1: Write failing source-contract tests**

Assert that cards render main/child/unknown text badges, parent information and child counts, that the card stores the role in a data attribute, and that project display uses only the final path segment while retaining the full path as a title.

- [x] **Step 2: Implement pure path and topology presentation helpers**

Replace `shortProj` with a separator-aware final-segment helper covering `C:\\a\\b`, `/a/b`, trailing separators, drive roots, and empty values. Add escaped topology markup and classes without changing the card click/jump/menu behavior.

- [x] **Step 3: Add the focused CSS and drawer metadata**

Add compact, accessible badge styles, child indentation/relationship text, unsupported-detection hint, and topology fields to the session drawer header.

- [x] **Step 4: Run UI source tests**

Run: `node --test public/session-card-topology.test.js`  
Expected: PASS.

### Task 6: Verify all adapters and run regression tests

**Files:**
- Modify: adapter capability declarations only where tests show the source provides a reliable structural main-session signal.
- Create: `lib/session-topology-capabilities.test.js`

- [x] **Step 1: Test the capability matrix**

Assert all eight current adapters are declared, Claude and ZCode are `verified`, and unsupported adapters are visibly marked `manual_only` rather than silently treated as fully verified.

- [x] **Step 2: Run the full suite**

Run: `npm test` and `git diff --check` from `agent-board`. Existing unrelated failures must be recorded separately; topology failures must be fixed before handoff.
