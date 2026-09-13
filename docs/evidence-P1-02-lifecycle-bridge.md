# P1-02 Evidence: Codex and WorkBuddy lifecycle bridge

- Status: PARTIAL / checkpoint. Adapter evidence now reaches the lifecycle runtime and the UI prefers its public state; legacy Store maps remain as compatibility mirrors and restart/replay seeding is not yet complete.
- Changed: `lib/session-lifecycle/adapter-bridge.js`, `adapter-bridge.test.js`, `lib/store.js`, `public/app.js`, `public/session-status.test.js`.
- Focused test: lifecycle bridge, Codex/WorkBuddy runtime, Store completion, spool/status bridge, and session-card tests -> 25 passed.
- Full regression: `npm test` -> 1232 passed, 3 skipped, 1 pre-existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion).
- Covered evidence: Codex/WorkBuddy turn messages, WorkBuddy external terminal, heartbeat, manual completion, and hook runtime states.
- Compatibility: existing runtime `state` fields and AutoPilot paths remain unchanged; UI uses `lifecycle_state` first and falls back to legacy fields.
- Remaining: add restart/replay integration, then migrate the remaining adapters.
- Data/security: no user data path or credential was changed.
- Rollback: revert this checkpoint; P1-01 and earlier P0 commits remain independently revertible.
