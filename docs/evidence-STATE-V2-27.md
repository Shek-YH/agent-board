# STATE-V2-27 Evidence — Manual Controls and Live Queue Integration

## Goal

Expose the separated manual State Engine actions and use the bounded queue at the Engine boundary while preserving legacy behavior.

## Changed files

- `lib/state-engine/index.js`
- `lib/state-engine/index.test.js`
- `lib/state-engine/runtime.js`
- `lib/state-engine/completion.js`
- `lib/state-engine/completion.test.js`
- `lib/state-engine/queue.js`
- `lib/state-engine/queue.test.js`
- `lib/store.js`
- `lib/store-state-engine-manual.test.js`
- `server.js`
- `server-sse.test.js`
- `public/app.js`
- `public/session-status.test.js`
- `lib/agent-adapters/*state-adapter.js`

## Verification

- Focused State Engine/adapter/Store/UI suite — exit 0, 143 passed, 0 failed.
- P0 matrix — exit 0, 34 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.
- Full `npm test` — exit 0, 1386 tests, 1383 passed, 3 skipped, 0 failed.

## Acceptance checks

- `mark-seen`, `mark-turn-done`, and `close-session` are separate Store/API actions; completion does not close Session.
- Engine queued ingestion coalesces heartbeat/process Evidence and preserves terminal events under pressure.
- Completion callback and notification IDs remain deduplicated.
- Native session anchors are carried by Codex/WorkBuddy Evidence and generation-scoped keys.
- UI diagnostics exposes the three manual actions without exposing raw Evidence values.

## Known limitations

- Real Agent process binding, sleep/wake, crash/rebind, installed NSIS and security-software acceptance remain in `STATE-V2-21 WAITING_USER`.
- The default runtime mode remains `off`.

Verification label: `SELF_VERIFIED` for automated/local acceptance.
