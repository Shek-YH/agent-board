# STATE-V2-13/14 Evidence — Codex and WorkBuddy Primary Bridges

## Goal

Expose V2 canonical/UI projections through the existing Store status path for `STATE_ENGINE_V2=on`, while keeping `off` rollback and legacy fields intact.

## Changed files

- `lib/state-engine/store-bridge.js`
- `lib/state-engine/store-bridge.test.js`
- `lib/store.js`
- `lib/store-state-engine-shadow.test.js`
- `lib/store-state-engine-workbuddy.test.js`
- `public/session-lifecycle-status.js`
- `public/session-lifecycle-status.test.js`
- `public/app.js`
- `public/session-status.test.js`
- `server.js` (startup deferral from microtask to `setImmediate`)
- `package.json`, `jsconfig.json`

## Verification

- State Engine + adapter + bridge suite — exit 0, 43 passed, 0 failed.
- WorkBuddy/Store/UI focused suite — exit 0, 40 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.
- Codex shadow Store smoke — exit 0; `OPEN + COMPLETION_CANDIDATE`, legacy primary preserved.
- Codex on-mode Store smoke — exit 0; `state_engine_source=state-engine-v2`, `ui_status=completion_candidate`, canonical Turn/Session separated.
- WorkBuddy on-mode Store smoke — exit 0; heartbeat produced `ALIVE`, Stop remained candidate, SessionEnd produced `CLOSED`.
- Full regression after Codex Store bridge — exit 0, 1302 tests, 1299 passed, 3 skipped, 0 failed.

## Acceptance checks

- Codex and WorkBuddy both use the same V2 State Engine bridge when on; adapters remain evidence-only.
- Legacy `state`, `lifecycle_state`, Store maps and notification paths remain available.
- Frontend on-mode reads fine-grained V2 keys and supports thinking/tool/command/subagent/waiting/completion/failed/interrupted labels; off/shadow legacy behavior remains.
- Heartbeat affects only liveness; Stop is not SessionEnd; explicit SessionEnd closes Session.
- Existing startup account smoke was separately rerun and still can exceed its fixed 8-second readiness window under current scan/resource load; no account logic was changed.

## Known limitations

- V2 mode is not enabled by default; diagnostics and rollout telemetry are next.
- WorkBuddy monitor snapshots are the current hook seam; richer native source sequence/generation data will be added when available.
- Installed-NSIS/manual/security-software acceptance remains outside automated evidence.

## Rollback

Set `STATE_ENGINE_V2=off`; remove the Store bridge fields if needed. Legacy status remains the fallback.

Verification label: `SELF_VERIFIED`.
