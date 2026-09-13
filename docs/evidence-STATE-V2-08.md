# STATE-V2-08 Evidence — Golden Replay Fixtures

## Goal

Establish metadata-only replay fixtures that lock core canonical outcomes before any real adapter migration.

## Changed files

- `lib/state-engine/golden-fixtures.test.js`
- `tests/fixtures/state-engine/*/input.ndjson`
- `tests/fixtures/state-engine/*/expected.json` (8 fixtures)

## Verification

- Initial RED: runner failed with `expected at least five state-engine fixtures` when fixture directory was empty.
- `node --test lib/state-engine/golden-fixtures.test.js` — exit 0, 1 passed, 0 failed.
- `node --test lib/state-engine/*.test.js` — exit 0, 28 passed, 0 failed.
- `npx eslint lib/state-engine` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine JS files>` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Fixtures cover normal completion, waiting approval, waiting user, long tool, failure, interruption, late cross-source evidence and parent active child.
- Expected files assert all five canonical dimensions plus current turn and active tool/subagent IDs.
- Inputs contain only structural metadata; no prompt, reply, token, cookie, password or transcript body.
- The parent-child fixture uses native lifecycle authority for the parent completion signal, matching the arbitration contract.

## Known limitations

- Fixture coverage is the first core subset, not all 32 PRD scenarios.
- Adapter-specific and real-agent fixtures are not yet included.

## Rollback

Remove the new fixture directories and runner test; replay and legacy behavior remain available.

Verification label: `SELF_VERIFIED`.
