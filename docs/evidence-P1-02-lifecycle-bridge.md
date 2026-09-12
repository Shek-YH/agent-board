# P1-02 Evidence: Codex and WorkBuddy lifecycle bridge

- Status: PARTIAL / checkpoint. Adapter evidence now reaches the lifecycle runtime; legacy Store maps remain for compatibility and are not yet removed as authoritative readers.
- Changed: `lib/session-lifecycle/adapter-bridge.js`, `adapter-bridge.test.js`, `lib/store.js`.
- Focused test: lifecycle bridge, Codex/WorkBuddy runtime, Store completion, and spool/status bridge tests -> 15 passed.
- Full regression: `npm test` -> 1226 passed, 3 skipped, 1 pre-existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion).
- Covered evidence: Codex/WorkBuddy turn messages, WorkBuddy external terminal, heartbeat, manual completion, and hook runtime states.
- Compatibility: existing runtime `state` fields and AutoPilot paths remain unchanged; `lifecycle_state` is additive.
- Remaining: make lifecycle snapshots authoritative for Store/UI reads, add restart/replay integration, then migrate the remaining adapters.
- Data/security: no user data path or credential was changed.
- Rollback: revert this checkpoint; P1-01 and earlier P0 commits remain independently revertible.
