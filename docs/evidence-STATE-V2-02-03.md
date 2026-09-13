# STATE-V2-02/03 Evidence — Runtime and Source Watermark

## Goals

- Represent the complete Canonical Session Runtime with a generation-scoped internal key and bounded evidence history.
- Track source watermarks independently so late evidence from one source is not discarded by another source's clock.

## Changed files

- `lib/state-engine/runtime.js`
- `lib/state-engine/runtime.test.js`
- `lib/state-engine/source-watermark.js`
- `lib/state-engine/source-watermark.test.js`
- `lib/state-engine/evidence.js` (JSDoc return contract for optional watermark fields)

## Verification

- `node --test lib/state-engine/evidence.test.js lib/state-engine/runtime.test.js lib/state-engine/source-watermark.test.js` — exit 0, 10 passed, 0 failed.
- `npx eslint lib/state-engine` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine JS files>` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Initial runtime contains all five canonical dimensions, identity, generation key, active tool/subagent sets, winning evidence, confidence and bounded recent evidence.
- Runtime cloning does not mutate the prior snapshot and deduplicates active IDs.
- Watermarks are keyed by agent/session/source, track sequence/offset/observedAt, reject duplicates and stale same-generation order, and reset sequence/offset on a new generation.
- A late `jsonl` evidence item is accepted after a newer-observed `process` item; no global timestamp gate exists.

## Known limitations

- Reducer/arbitration has not been added; watermarks currently only gate evidence intake.
- No Store/adapter/UI integration yet.

## Rollback

Remove the runtime and watermark modules/tests; legacy state paths are untouched.

Verification label: `SELF_VERIFIED`.
