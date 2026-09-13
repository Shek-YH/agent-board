# STATE-V2-28 Evidence — WorkBuddy Transcript Turn Identity Hardening

## Goal

Close the post-matrix boundary found during real-data smoke: parsed WorkBuddy JSONL messages must become metadata-only turn Evidence, and Store-generated hook Evidence must retain the current turn identity through the public V2 status projection.

## Changed files

- `lib/agent-adapters/workbuddy-state-adapter.js`
- `lib/agent-adapters/workbuddy-state-adapter.test.js`
- `lib/state-engine/store-bridge.js`
- `lib/store.js`
- `lib/store-state-engine-workbuddy.test.js`

## Verification

- TDD regression initially failed because `currentTurnId` was not exposed by the Store status path.
- Focused adapter/bridge/Store suite — exit 0, 10 passed, 0 failed.
- Full `npm test` — exit 0, 1387 tests, 1384 passed, 3 skipped, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.

## Real-data smoke (read-only)

- Codex source: 872 JSONL files, 33,229 parsed events, 33,229 metadata-only Evidence records.
- WorkBuddy source: 267 JSONL files, 12,558 parsed events, 12,383 metadata-only Evidence records; unsupported non-state records remain ignored.
- The smoke emitted counts only; it did not record paths, prompts, replies, transcript bodies, or secrets.

## Acceptance boundary

- This closes the adapter/projection regression locally.
- Live long-running, crash, sleep/wake, same-CWD dual-session, process rebind, installed NSIS, security-software and product-owner on-mode acceptance remain `STATE-V2-21 WAITING_USER`.

Verification label: `SELF_VERIFIED` for automated and read-only local smoke checks.
