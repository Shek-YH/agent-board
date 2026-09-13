# Agent Board State Engine V2 Implementation Plan

> **For agentic workers:** Execute one checkbox task at a time with TDD and verify each checkpoint. The PRD remains authoritative; this plan records the dependency order and exact repository boundaries.

**Goal:** Build a replayable, explainable Universal Agent State Engine that separates liveness, session lifecycle, turn, activity and attention while preserving legacy behavior and rollback.

**Architecture:** Source-specific adapters emit normalized Evidence. Per-source watermarks and attribute-level authority arbitration select winning evidence. A pure reducer produces Canonical Session Runtime; projections, replay, diagnostics and a compatibility bridge consume that runtime without letting adapters write UI state directly.

**Tech Stack:** CommonJS JavaScript, Node.js built-in APIs, `node:test`, native HTTP/SSE UI, JSON persistence, existing Codex/WorkBuddy adapters.

---

## File map and scope

- Create `lib/state-engine/`: V2 enums, Evidence normalization, runtime, watermarks, policies, arbitration, reducer, projection, replay, diagnostics and index.
- Create `lib/agent-manifests/`: declarative capabilities and timeout/authority data for Codex and WorkBuddy first.
- Create `tests/fixtures/state-engine/` only when golden replay begins; use metadata-only fixtures.
- Modify `lib/store.js`, adapters/monitors, `server.js`, `public/app.js`, package gates and `CHANGELOG` only at their dependency-ordered migration Tasks.
- Do not modify database schema, replace the UI framework, delete old lifecycle/status code, touch real AppData, overwrite `dist`, push or deploy.

## Work Items

### Task 01 — `STATE-V2-01` Enums and Evidence (current)

Files: create `lib/state-engine/enums.js`, `lib/state-engine/evidence.js`, test `lib/state-engine/evidence.test.js`.

RED: assert all five canonical dimensions and source/event enums are frozen, and `normalizeEvidence()` preserves `occurredAt`/`observedAt`, clamps valid confidence/authority, and rejects missing identity, invalid timestamps, secrets and transcript bodies. Run `node --test lib/state-engine/evidence.test.js`; it must fail because the module is absent.

GREEN: add only immutable enums and a metadata-safe normalizer. Do not add reducer or source-specific mappings. Re-run the focused test, then `npm test`.

Acceptance: normalized Evidence contains `evidenceId`, `agent`, `sessionRef`, `source`, `signalType`, both clocks and bounded numeric confidence/authority; no secret/body fields are accepted.

### Task 02 — `STATE-V2-02` Canonical runtime

Create `runtime.js` and `runtime.test.js`. Test initial dimensions, identity/generation, active tool/subagent sets, winning evidence, confidence and bounded recent evidence. Implement immutable `createInitialRuntime()`/`cloneRuntime()` only.

### Task 03 — `STATE-V2-03` Source watermark

Create `source-watermark.js` and tests. Test independent source watermarks, sequence ordering, byte offsets, generation changes, late observations and duplicate fingerprints. Implement deterministic `createSourceWatermarks()`/`acceptEvidence()`; no global timestamp gate.

### Task 04 — `STATE-V2-04` Attribute-level arbitrator

Create `policies/default.js`, `policies/codex.js`, `policies/workbuddy.js`, `arbitrator.js` and tests. Test authority beats newer weak evidence, source generation/sequence tie-breakers, TTL expiry and conflict reasons.

### Task 05 — `STATE-V2-05` Universal reducer

Create `reducer.js` and tests. Test turn completion leaves session OPEN, completion candidate veto, waiting approval/user, tool/subagent tracking, failure/interruption distinction, heartbeat liveness only, session end closure, parent-with-active-child candidate and idempotent duplicate evidence.

### Task 06 — `STATE-V2-06` UI/legacy projections

Create `projection.js` and tests. Map canonical dimensions to Chinese UI labels and legacy state without exposing `ALIVE`/`OPEN` as primary labels. Keep `legacyState` available and make `STATE_ENGINE_V2=off|shadow|on` explicit.

### Task 07 — `STATE-V2-07` Replay engine

Create `replay.js` and tests. Replay normalized Evidence in deterministic order through the reducer/arbitrator and return final runtime plus diagnostic trace; no filesystem or process access.

### Task 08 — `STATE-V2-08` Golden fixtures

Create metadata-only NDJSON/JSON fixture pairs under `tests/fixtures/state-engine/` for normal completion, waiting approval/user, long tool, failure/interruption, late/out-of-order/duplicate evidence, heartbeat loss, child completion and same-CWD identity separation. Add a fixture runner and ensure all expected states are exact.

### Task 09 — `STATE-V2-09` Codex shadow adapter

Add `lib/agent-adapters/codex-state-adapter.js` or the smallest existing seam, plus adapter tests. Translate existing Codex JSONL/runtime events into Evidence, preserve incremental reader and legacy status, and emit no UI/notification writes. Wire shadow-only ingestion behind the flag.

### Task 10 — `STATE-V2-10` WorkBuddy shadow adapter

Add the WorkBuddy Evidence seam and tests for SessionStart, Stop, SessionEnd, tool/subagent, permission, user wait, DB and heartbeat. Keep Stop as turn candidate and heartbeat liveness-only.

### Task 11 — `STATE-V2-11` Shadow comparison

Add a pure legacy-v2 comparison utility and tests. Record divergence metadata (`legacy`, canonical dimensions, reason) without sensitive message content or changing legacy output.

### Task 12 — `STATE-V2-12` Divergence fixes

Use recorded replay/adapter evidence to fix only confirmed policy/reducer mismatches. Each fix gets a reproducing test before production changes; no speculative timeout or Store-wide rewrite.

### Task 13 — `STATE-V2-13` Codex primary

Add regression tests and change the Codex UI/status source to the V2 projection only after shadow replay is green. Verify turn/session separation, late hooks, process/activity separation, duplicate notification and restart behavior.

### Task 14 — `STATE-V2-14` WorkBuddy primary

Add regression tests and switch WorkBuddy to V2 projection only after its shadow evidence is green. Verify Stop vs SessionEnd, waiting states, DB/terminal arbitration and duplicate hook idempotency.

### Task 15 — `STATE-V2-15` Diagnostics API

Add read-only status diagnostics and redacted bundle export. Expose canonical state, winning/ignored evidence, source health, identity/process/transcript metadata and diagnostic ID; never expose bodies/secrets.

### Task 16 — `STATE-V2-16` Diagnostics UI

Add the smallest settings/developer diagnostics surface using existing UI conventions. Test render states and timeline/export interactions with browser/UI coverage; do not redesign the main board.

### Task 17 — `STATE-V2-17` Performance/backpressure

Add bounded per-session evidence retention, coalescing for heartbeat/process events, incremental JSONL proof and benchmark evidence. Verify no unbounded queue and no whole-file scan regression.

### Task 18 — `STATE-V2-18` Real acceptance

Run replay, integration, browser and available Codex/WorkBuddy real-flow checks. Mark unavailable login/private media/device/installed-NSIS/security-software checks as `WAITING_USER` or unverified rather than fabricating completion.

### Task 19 — `STATE-V2-19` Rollout and release notes

Document `off|shadow|on`, migration/restart recovery, rollback and CHANGELOG. Only mark complete after Definition of Done, P0 acceptance and known manual gaps are closed.

### Task 20 — `STATE-V2-20` State Engine persistence and restart recovery

Create `lib/state-engine/persistence.js` and tests. Persist only versioned identity, generation, canonical dimensions, notification IDs, source watermarks and last strong evidence metadata in a separate atomic snapshot; omit recent raw values/transcript bodies and temporary process health. Add optional persistence to `createStateEngine`, validate corrupt snapshots without overwriting them, and restore terminal evidence without inferring ACTIVE from old ordinary events.

### Task 21 — `STATE-V2-21` Final real/manual acceptance

Run real Codex/WorkBuddy long-running, restart, same-CWD and browser click flows where available. Verify installed NSIS/security-software/manual acceptance only with user-controlled environment; keep unavailable checks explicitly unverified and keep the default rollout off.

### Task 22 — `STATE-V2-22` Session Identity V2 and capability manifests

Create `lib/state-engine/identity.js`, `identity.test.js`, `lib/agent-manifests/*.json` and `manifest.js` tests. Normalize host/native/transcript/process/terminal/workspace anchors, create generation-scoped runtime keys, compare identities without treating same CWD as identity, and load safe declarative capabilities/timeouts/authority for Codex and WorkBuddy plus explicit unsupported declarations for current agents.

### Task 23 — `STATE-V2-23` Process liveness and source health

Create a pure/injectable `ProcessLivenessService` with missing-process debounce and source health transitions. Test ALIVE/SUSPECT/DEAD without mapping process presence to RUNNING, and expose bounded health metadata to diagnostics.

### Task 24 — `STATE-V2-24` Completion IDs and notification boundary

Add deterministic completion ID generation, per-runtime notification dedupe and manual seen/turn-done separation. Integrate only after a reproducing test proves duplicate completion events do not notify twice.

### Task 25 — `STATE-V2-25` Universal adapter contract and manifest-backed policies

Create `lib/state-engine/adapter-contract.js` and tests. Validate the common adapter surface, bind Codex/WorkBuddy adapters to manifest IDs, and fail closed for adapters that attempt direct state/UI writes or unsupported capabilities.

### Task 26 — `STATE-V2-26` Final P0 replay matrix and rollout audit

Expand metadata-only fixtures for late hooks, duplicates, same-CWD identities, child completion, heartbeat loss, process debounce, restart recovery and failed/interrupted states; run the requirement matrix and leave real/manual checks explicitly gated.

## Verification commands

Focused: `node --test <specific-file>`.

Regression: `npm test`, `npm run lint`, `npm run check`, `git diff --check`.

UI/package checks are separate evidence; unpacked Electron smoke is not installed-NSIS/manual acceptance.

## Self-review

- Coverage: PRD Tasks 01–19 and Phase 1/2 acceptance are mapped above.
- Placeholder scan: no task is delegated to an unspecified subsystem; real-agent and manual checks are explicitly bounded.
- Compatibility: the V2 runtime name is distinct from existing `lib/session-lifecycle`; `STATE_ENGINE_V2=off` remains available.
