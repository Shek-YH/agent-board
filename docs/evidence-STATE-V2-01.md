# STATE-V2-01 Evidence — Enums and Evidence

## Goal

Create immutable canonical dimension/source/event enums and a metadata-safe Evidence normalizer without changing legacy runtime code.

## Changed files

- `lib/state-engine/enums.js`
- `lib/state-engine/evidence.js`
- `lib/state-engine/evidence.test.js`
- Governance/plan files for the new PRD execution.

## Verification

- `node --test lib/state-engine/evidence.test.js` — exit 0, 4 passed, 0 failed.
- `npx eslint lib\\state-engine` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine JS files>` — exit 0.
- `git diff --check` — exit 0.
- `npm test` with `TEMP/TMP=F:\\AgentBoard-test-temp-20260913` — exit 1, 1267 passed, 3 skipped, 3 failed. Failures are pre-existing/unrelated: two `lib/user-data-persistence.test.js` assertions and `server-account.test.js` startup. The new four Evidence tests passed in the same run.

## Acceptance checks

- Five canonical dimensions and source/event/health enums are frozen.
- Evidence preserves `occurredAt` and `observedAt` separately.
- Confidence and authority are bounded; invalid identity, clocks, sources, cycles and secret/body-like fields are rejected.
- No old Store, Adapter, persistence file or real user data was changed.

## Known limitations

- V2 is not connected to Store, adapters, UI or notifications yet.
- Full regression remains non-green for the unrelated baseline failures above.

## Rollback

Remove the three new `lib/state-engine` files and this evidence file; legacy state behavior is unaffected.

Verification label: `SELF_VERIFIED`.
