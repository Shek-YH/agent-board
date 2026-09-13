# STATE-V2-11 Evidence — Legacy/V2 Shadow Comparison

## Goal

Compare legacy display state with Canonical V2 dimensions using bounded, redacted metadata without changing the primary legacy path.

## Changed files

- `lib/state-engine/comparison.js`
- `lib/state-engine/comparison.test.js`

## Verification

- Initial RED: comparison test failed with missing `comparison` module.
- `node --test <state-engine tests + both adapter tests>` — exit 0, 40 passed, 0 failed.
- `npx eslint lib/state-engine lib/agent-adapters/codex-state-adapter.js lib/agent-adapters/workbuddy-state-adapter.js` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine and adapter JS files>` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Comparison exposes only safe legacy state, five canonical dimensions, divergence boolean and bounded reason codes.
- Legacy `completed` with V2 `sessionLifecycle=OPEN` is explicitly marked `session_open`.
- Matching running states do not diverge.
- Unknown/arbitrary legacy input is normalized to `unknown`; no prompt/body/token fields are copied.

## Known limitations

- Comparison is not yet wired to the running Store/adapter shadow path.
- Divergence storage/telemetry is a later migration Task.

## Rollback

Remove comparison module/test; no runtime consumer currently depends on it.

Verification label: `SELF_VERIFIED`.
