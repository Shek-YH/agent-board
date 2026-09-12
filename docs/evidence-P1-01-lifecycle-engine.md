# P1-01 Evidence: SessionLifecycleEngine

- Goal: establish a replay-safe, pure reducer and public runtime snapshot without changing existing adapters or UI.
- Changed: `lib/session-lifecycle/events.js`, `reducer.js`, `engine.js`, `selectors.js`, `runtime-store.js`, and focused tests.
- Focused test: `node --test lib/session-lifecycle/reducer.test.js lib/session-lifecycle/engine.test.js` -> 5 passed.
- Full regression: `npm test` -> 1223 passed, 3 skipped, 1 pre-existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion).
- Invariants covered: terminal monotonicity, newer real activity rollover, completion candidate stabilization, live veto, duplicate event idempotency, child isolation, and per-session isolation.
- Scope: compatibility layer only; Codex/WorkBuddy migration is the next Work Item.
- Data/security: no user data path, AutoPilot dispatch path, or credential was changed.
- Rollback: revert the P1-01 commit; the engine is isolated until adapter migration.
