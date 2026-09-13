# STATE-V2-05 Evidence — Universal State Reducer

## Goal

Reduce normalized Evidence into deterministic Canonical Session Runtime while keeping Turn, Session, liveness, activity and attention semantics separate.

## Changed files

- `lib/state-engine/reducer.js`
- `lib/state-engine/reducer.test.js`

## Verification

- `node --test lib/state-engine/*.test.js` — exit 0, 20 passed, 0 failed.
- `npx eslint lib/state-engine` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine JS files>` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- `TURN_COMPLETION_SIGNAL` produces `turnState=COMPLETION_CANDIDATE`; confirmation produces `COMPLETED` while `sessionLifecycle=OPEN`.
- New user activity starts a new turn and clears completion attention.
- Process/heartbeat evidence affects liveness only; tool, wait and subagent events update their own dimensions and collections.
- `FAILED` and `INTERRUPTED` remain distinct; `SESSION_CLOSED` closes only the Session dimension.
- Parent completion remains a candidate while active subagents exist; duplicate evidence is idempotent.
- Reducer has no UI, process, filesystem or notification dependency.

## Known limitations

- Completion stabilization timer is intentionally not in the pure reducer; orchestration/replay will supply explicit confirmation.
- Store and real adapters still use legacy paths until shadow migration Tasks.

## Rollback

Remove the reducer and test; the existing `lib/session-lifecycle` and legacy Store paths remain available.

Verification label: `SELF_VERIFIED`.
