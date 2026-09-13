# STATE-V2-16 Evidence — Diagnostics UI

## Goal

Add a minimal developer diagnostics flow under the existing Settings Hub without redesigning the main board.

## Changed files

- `public/app.js`
- `public/index.html`
- `public/session-status.test.js`

## Verification

- `node --test public/session-status.test.js public/session-lifecycle-status.test.js` — exit 0, 6 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.
- Full regression `npm test` with `TEMP/TMP=F:\\AgentBoard-test-temp-20260913` — exit 0, 1324 tests, 1321 passed, 3 skipped, 0 failed.

## Acceptance checks

- Settings Hub exposes `状态监控诊断`.
- UI loads safe State Engine session summaries, then detail bundle data containing canonical state, winning evidence, conflicts and Evidence Timeline.
- Local `导出诊断包` creates a JSON download from already redacted API data.
- Empty/error/loading states are explicit; no main board layout or state truth is duplicated in the UI.

## Known limitations

- Browser click-flow automation for the new diagnostics panel is not yet run; current coverage is static UI contract plus API/builder tests.
- V2 remains opt-in (`off` by default).

## Rollback

Remove the Settings Hub entry and diagnostics render function; the read-only API can remain disabled.

Verification label: `SELF_VERIFIED`.
