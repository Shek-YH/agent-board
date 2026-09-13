# P1-02 Evidence: lifecycle snapshot replay and authority

- Goal: restore explicit lifecycle terminal evidence after Store restart and make migrated Codex/WorkBuddy runtime output consistent for Store/UI.
- Changed: `lib/session-lifecycle/replay.js`, `replay.test.js`, `runtime-store.js`, `lib/store.js`, `public/app.js`, `public/session-status.test.js`.
- Replay rule: persisted manual completion and explicit done signals restore terminal state; historical ordinary messages do not create current ACTIVE state.
- Focused verification: replay, lifecycle, Store completion, WorkBuddy runtime, and session-card tests -> 22 passed.
- Full regression: `npm test` -> 1233 passed, 3 skipped, 2 environment-sensitive failures; `server-account.test.js` passed when isolated, while `lib/launch.test.js` timeout remains reproducible.
- UI rule: `lifecycle_state` takes precedence over legacy `runtime.state` and `liveRefs`; legacy fields remain fallback compatibility data.
- Data/security: replay reads the already loaded snapshot only; no user data file is rewritten and AutoPilot dispatch gates are unchanged.
- Remaining: migrate other adapters and eventually remove legacy lifecycle readers after independent acceptance.
