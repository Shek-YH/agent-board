# STATE-V2-10 Evidence — WorkBuddy Shadow Adapter

## Goal

Translate WorkBuddy lifecycle hooks, heartbeat and database status into metadata-only V2 Evidence behind the feature flag while preserving the existing monitor.

## Changed files

- `lib/agent-adapters/workbuddy-state-adapter.js`
- `lib/agent-adapters/workbuddy-state-adapter.test.js`

## Verification

- Initial RED: adapter test failed with missing `workbuddy-state-adapter` module.
- `node --test <state-engine tests + both adapter tests>` — exit 0, 37 passed, 0 failed.
- `npx eslint lib/state-engine lib/agent-adapters/codex-state-adapter.js lib/agent-adapters/workbuddy-state-adapter.js` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine and adapter JS files>` — exit 0.
- `git diff --check` — exit 0.
- Full regression `npm test` after Task 09 — exit 0, 1302 tests, 1299 passed, 3 skipped, 0 failed.

## Acceptance checks

- SessionStart/UserPromptSubmit/tool/subagent/permission/wait/Stop/StopFailure/SessionEnd map to explicit V2 event types.
- Normal Stop emits `TURN_COMPLETION_SIGNAL`; `stop_hook_active=true` emits only transcript activity; SessionEnd emits `SESSION_CLOSED`.
- Heartbeat uses `source=heartbeat` and `HEARTBEAT`; database active/terminal uses `source=database` and distinct liveness/session semantics.
- Adapter emits only through injected `emit`; default `off` produces no Evidence; no hook prompt/cwd/body is retained.

## Known limitations

- Existing WorkBuddy monitor is not yet wired to this adapter; primary migration is later.
- Real WorkBuddy DB/spool acceptance remains open.

## Rollback

Keep `STATE_ENGINE_V2=off` or remove the new adapter files; legacy WorkBuddy monitor remains unchanged.

Verification label: `SELF_VERIFIED`.
