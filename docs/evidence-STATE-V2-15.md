# STATE-V2-15 Evidence — Diagnostics API

## Goal

Expose explainable State Engine status and redacted diagnostic bundle data through a read-only Store/API boundary.

## Changed files

- `lib/state-engine/diagnostics.js`
- `lib/state-engine/diagnostics.test.js`
- `lib/store.js`
- `server.js`
- `server-sse.test.js`

## Verification

- `node --test <state-engine, adapter, bridge, Store and server focused tests>` — exit 0, 57 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Diagnostics include canonical five-dimensional state, winning evidence details, ignored conflict reasons, source health, bounded timing and deterministic `AB-STATE-YYYYMMDD-xxxxxxxx` ID.
- Bundle includes a bounded metadata-only timeline, safe identity/process fields, active tool/subagent IDs and adapter booleans.
- Raw Evidence `value`, message/prompt/response body, token, cookie, password and secret fields are never serialized.
- Store exposes `getStateEngineDiagnostics`; server exposes read-only `/api/state-engine/diagnostics` with optional `bundle=1` and no mutation/auth side effect.

## Known limitations

- Server route requires an existing V2 runtime for a session and currently returns 404 otherwise.
- Source-health/capability aggregation will be enriched during rollout/performance work.

## Rollback

Remove the diagnostics route/helper; core State Engine and legacy status paths remain usable.

Verification label: `SELF_VERIFIED`.
