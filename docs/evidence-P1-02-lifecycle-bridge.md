# P1-02 Evidence: Codex and WorkBuddy lifecycle bridge

- Status: COMPLETED for Codex + WorkBuddy compatibility migration. Legacy Store fields remain as compatibility mirrors; other adapters are intentionally not migrated in this phase.
- Changed: `lib/session-lifecycle/adapter-bridge.js`, `adapter-bridge.test.js`, `replay.js`, `replay.test.js`, `runtime-store.js`, `lib/store.js`, `public/app.js`, `public/session-status.test.js`.
- Focused test: lifecycle bridge, replay, Codex/WorkBuddy runtime, Store completion, spool/status bridge, and session-card tests -> 25 passed.
- Full regression: `npm test` -> 1232 passed, 3 skipped, 1 pre-existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion).
- Covered evidence: Codex/WorkBuddy turn messages, WorkBuddy external terminal, heartbeat, manual completion, and hook runtime states.
- Compatibility: existing runtime `state` fields and AutoPilot paths remain unchanged; UI uses `lifecycle_state` first and falls back to legacy fields.
- Remaining: migrate the remaining adapters in later phases; lifecycle state is authoritative for the migrated Codex/WorkBuddy runtime/UI path.
- Data/security: no user data path or credential was changed.
- Rollback: revert this checkpoint; P1-01 and earlier P0 commits remain independently revertible.
