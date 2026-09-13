# STATE-V2-04 Evidence — Attribute-level Source Arbitration

## Goal

Select canonical-dimension evidence by source authority and deterministic tie-breakers, with explicit TTL and conflict reasons.

## Changed files

- `lib/state-engine/arbitrator.js`
- `lib/state-engine/arbitrator.test.js`
- `lib/state-engine/policies/default.js`
- `lib/state-engine/policies/codex.js`
- `lib/state-engine/policies/workbuddy.js`

## Verification

- `node --test lib/state-engine/evidence.test.js lib/state-engine/runtime.test.js lib/state-engine/source-watermark.test.js lib/state-engine/arbitrator.test.js` — exit 0, 14 passed, 0 failed.
- `npx eslint lib/state-engine` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine JS files>` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Source authority is selected per canonical dimension; a newer weak UI signal cannot override an older structured signal.
- Ties resolve by source generation, source sequence, occurredAt and observedAt rather than last-arrival time.
- Explicit TTL and policy TTL expiry are ignored with an `expired` reason.
- Codex and WorkBuddy lifecycle authority flags are separate and immutable by policy object.

## Known limitations

- Arbitration is not yet wired to a reducer or Store.
- Conflict lists are in-memory results; diagnostics persistence is a later Task.

## Rollback

Remove the policy and arbitrator files; legacy status paths are untouched.

Verification label: `SELF_VERIFIED`.
