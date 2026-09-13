# STATE-V2-07 Evidence — Replay Engine

## Goal

Replay metadata-only Evidence through the reducer with deterministic output, per-step canonical trace and session isolation.

## Changed files

- `lib/state-engine/replay.js`
- `lib/state-engine/replay.test.js`
- `lib/state-engine/reducer.js` (protect explicit lifecycle transitions from OPEN fallback)

## Verification

- `node --test lib/state-engine/*.test.js` — exit 0, 27 passed, 0 failed.
- `npx eslint lib/state-engine` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine JS files>` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Same Evidence sequence returns deep-equal Runtime and trace.
- Replay does not mutate input and rejects mixed session references.
- Trace contains each Evidence ID, changed flag and canonical five-dimension snapshot.
- Explicit `SESSION_CLOSED` remains CLOSED and is not overwritten by generic activity fallback.

## Known limitations

- Replay is an in-memory API; fixture discovery and filesystem loading are the next Task.
- Multi-session batch replay is intentionally out of scope for this single-session core.

## Rollback

Remove `replay.js` and its tests; existing legacy replay remains unchanged.

Verification label: `SELF_VERIFIED`.
