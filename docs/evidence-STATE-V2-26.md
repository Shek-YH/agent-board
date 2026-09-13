# STATE-V2-26 Evidence — P0 Replay Matrix and Rollout Audit

## Goal

Exercise the 32 PRD P0 scenarios against replay/identity/liveness behavior and keep non-synthetic acceptance boundaries explicit.

## Changed files

- `lib/state-engine/p0-matrix.test.js`
- `lib/state-engine/runtime.test.js`
- `package.json`
- `lib/agent-manifests/*.json`

## Verification

- `node --test lib/state-engine/p0-matrix.test.js` — exit 0, 34 tests, 34 passed, 0 failed (32 named scenario subtests plus process debounce).
- `node --test lib/state-engine/*.test.js` — exit 0, 96 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Matrix covers normal completion, continuation, waits, long tools, subagents, Ctrl+C, kill/crash/close/sleep-wake, truncate/rotate/restart/resume/fork, same-CWD separation, desktop+CLI, rate limit, compaction, late/out-of-order/duplicate evidence, heartbeat/process debounce and parent-child completion.
- Process events are source-labelled correctly; a process death with exact identity reaches `DEAD/CLOSED`, while weak/mismatched signals do not.
- All scenario outcomes are derived from the V2 replay/reducer or injectable liveness service, not hand-written production state.
- Real Agent, installed NSIS, security-software and owner enablement remain explicitly user-gated in `STATE-V2-21`.

## Known limitations

- The matrix is synthetic and cannot prove live vendor behavior, process rebind or installed-package acceptance.
- Full queue batching and all non-Codex/WorkBuddy Evidence migrations remain future scope.

## Rollback

Remove the matrix test and manifest/package additions; keep `STATE_ENGINE_V2=off`.

Verification label: `SELF_VERIFIED` for synthetic coverage.
