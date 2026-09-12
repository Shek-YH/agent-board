# Agent Board Architecture Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Incrementally remove proven I/O and lifecycle consistency risks while preserving Agent Board’s existing data, UI behavior, and AutoPilot safety gates.

**Architecture:** Start with a bounded byte-range reader and a compact Codex completion-history reducer. Then introduce a pure SessionLifecycleEngine as a compatibility layer before migrating adapters. Storage, frontend, AutoPilot, auth, CI/E2E, and SSE changes remain separate work items so each can be rolled back independently.

**Tech Stack:** Node.js CommonJS, built-in `fs`/`http`, Node test runner, Electron 44, native browser DOM.

---

### Task 1: Range-based watcher reads

**Files:**
- Modify: `lib/watcher.js`
- Modify: `lib/watcher.test.js`
- Test: `lib/watcher.test.js`

- [x] Add tests that stub `fs.readFileSync` and `fs.promises.readFile` to throw, then prove `tailRead`, `tailReadAsync`, and `tailRecent` still parse range data; add UTF-8, CRLF, partial final line, and offset-progress assertions.
- [x] Run `node --test lib/watcher.test.js`; expected new tests fail because the current implementation calls whole-file reads.
- [x] Add small `readRangeSync` and `readRangeAsync` helpers using `open/openSync` plus `read/readSync`, reading only the requested byte range and closing descriptors in `finally`.
- [x] Make tail functions locate newline boundaries in raw bytes, decode only complete line bytes, and calculate `newOffset` from byte positions.
- [x] Run `node --test lib/watcher.test.js`; expected PASS, then run `npm test` and inspect `git diff --check`.
- [x] Record a repeatable 100MB range-read benchmark under `tools/benchmark-watcher.js` only after the focused behavior is green; report bytes requested, elapsed time, and peak RSS without claiming a Defender/360 result.
- [x] Commit with `P0-01: use bounded range reads for watcher tails`.

### Task 2: Incremental Codex completion history

**Files:**
- Create: `lib/adapters/codex-completion-history.js`
- Create: `lib/adapters/codex-completion-history.test.js`
- Modify: `lib/adapters/codex.js`

- [ ] Add reducer tests for one turn, multi-turn default hold, rapid continuation, cutoff at signal timestamp, truncation, and file identity replacement.
- [ ] Run the focused history test; expected FAIL before the module exists.
- [ ] Implement a bounded state `{ fileIdentity, lastOffset, starts, completes, lastTaskStartAt, lastTaskCompleteAt }` that consumes only appended normalized events.
- [ ] Wire `codex.js` to update the bounded history from the existing incremental lines and use it for `completionHoldMsForSession`; rebuild only through the range reader when identity/size proves invalid.
- [ ] Run Codex adapter tests plus `npm test`; inspect that no completion path invokes synchronous whole-file JSONL reading.
- [ ] Commit with `P1-02: make Codex completion history incremental`.

### Task 3: SessionLifecycleEngine compatibility layer

**Files:**
- Create: `lib/session-lifecycle/events.js`
- Create: `lib/session-lifecycle/reducer.js`
- Create: `lib/session-lifecycle/engine.js`
- Create: `lib/session-lifecycle/selectors.js`
- Create: `lib/session-lifecycle/runtime-store.js`
- Create: `lib/session-lifecycle/reducer.test.js`
- Create: `lib/session-lifecycle/engine.test.js`

- [ ] Add reducer tests for dedupe, stale events, terminal monotonicity, completion candidate/veto/confirm, waiting user, manual completion, turn rollover, and child isolation.
- [ ] Implement normalized event validation and the public states `UNKNOWN`, `IDLE`, `ACTIVE`, `WAITING_USER`, `COMPLETION_CANDIDATE`, `COMPLETED`, `FAILED`, and `INTERRUPTED`.
- [ ] Implement `applyEvent(state, event)` as a pure reducer with `eventId` dedupe and timestamp-based terminal guards; emit transition metadata without user text or secrets.
- [ ] Implement `SessionLifecycleEngine` with injected clock, stable notification keys, replay-safe event application, and snapshot selectors.
- [ ] Run lifecycle tests and `npm test`; keep the engine unconnected to UI until contract tests pass.
- [ ] Commit with `P1-01: add replay-safe session lifecycle engine`.

### Task 4: Codex and WorkBuddy adapter migration

**Files:**
- Modify: `lib/adapters/codex.js`
- Modify: `lib/workbuddy-monitor.js`
- Modify: `lib/store.js`
- Add focused adapter/lifecycle integration tests beside existing suites.

- [ ] Add integration tests proving adapter evidence enters the engine and public state matches existing completed/waiting/active behavior.
- [ ] Add a compatibility projection from engine snapshots to current Store maps; retain old fields as mirrors only during migration.
- [ ] Route Codex and WorkBuddy completion, heartbeat, external terminal, and manual completion evidence through the engine without removing Verified Dispatch checks.
- [ ] Run all Codex, WorkBuddy, store completion, and lifecycle tests plus `npm test`; mark remaining adapters as not migrated.
- [ ] Commit with `P1-01: project Codex and WorkBuddy through lifecycle engine`.

### Task 5: Storage interface and safe migration tooling

**Files:**
- Create: `lib/storage/interface.js`
- Create: `lib/storage/json-snapshot-store.js`
- Create: `lib/storage/migration.js`
- Create: `lib/storage/benchmark.js`
- Create: `lib/storage/*.test.js`
- Modify: `lib/store.js` only where dependency injection is required.

- [ ] Add contract tests for load/save, backup manifest, record counts, dry-run, mismatch abort, and rollback.
- [ ] Implement the interface over the existing JSON store first; do not change the default backend.
- [ ] Implement migration dry-run that records hash, size, session/message/hidden/manual/user-data counts and refuses writes when counts differ.
- [ ] Benchmark current JSON load/save and document results in `docs/PERFORMANCE_REPORT.md`; do not claim SQLite or segmented JSONL readiness without real validation.
- [ ] Commit with `P1-03: add storage interface and migration dry run`.

### Task 6: Engineering gates and bounded UI/AutoPilot decomposition

**Files:**
- Create: `.eslintrc.json`, `jsconfig.json`, `.github/workflows/ci.yml`
- Create: `docs/SECURITY_NOTES.md`
- Modify: `package.json`, `public/app.js`, `lib/orchestrator/auto-loop.js` only through tested extraction seams.

- [ ] Add lint/check scripts and run them against core modules first; fix actual undefined/unreachable/duplicate-key issues without mass formatting.
- [ ] Add Ubuntu and Windows Node 22 CI jobs running `npm ci`, `npm test`, `npm run lint`, and `npm run check`.
- [ ] Extract one tested frontend module seam and one tested AutoPilot phase seam at a time, preserving policy gate, identity/delivery verification, lease, retry, watchdog, handoff, and fail-closed paths.
- [ ] Add the first Electron/Playwright smoke tests only after a reproducible local Electron launch command exists; label unavailable real desktop checks as manual.
- [ ] Commit each independently verified gate/decomposition work item.

### Task 7: Runtime auth, SSE recovery, and observability

**Files:**
- Modify: `server.js`, relevant `lib/workbuddy-http.js`, `public/app.js`
- Create: focused auth/SSE tests and `docs/SECURITY_NOTES.md` / `docs/PERFORMANCE_REPORT.md` updates.

- [ ] Add tests for loopback-only listener, distinct UI/Hook tokens, mutation auth, Host/Origin/Content-Type/body-size checks, and rejected cross-token use.
- [ ] Implement a per-runtime UI token without persisting token values in source, logs, or ledgers; keep WorkBuddy Hook auth separate.
- [ ] Add versioned SSE envelopes with `seq` and `eventId`; make the client reconcile an authoritative snapshot on a sequence gap.
- [ ] Add structured transition/scan/storage/SSE diagnostics with redaction tests.
- [ ] Run focused tests and `npm test`; leave backend defaults unchanged when a compatibility check is not available.
- [ ] Commit each independently verified security/recovery work item.

### Final verification

- [ ] Run `npm test`, `npm run lint`, `npm run check`, and available desktop/package verification.
- [ ] Recheck `git diff --check`, staged paths, secret-like strings, and user-data paths before any checkpoint.
- [ ] Update `docs/PERFORMANCE_REPORT.md`, `docs/SECURITY_NOTES.md`, and the final P0/P1/P2 evidence with `DONE`, `PARTIAL`, `NOT STARTED`, or `BLOCKED` based on actual commands and manual verification limits.
