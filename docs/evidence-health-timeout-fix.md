# Health Timeout Fix Evidence

## Symptom

The UI reported `后台连接失败 · 请求超时：/api/health` while the Agent Board backend was still alive.

## Root cause

- `public/api-client.js` used a 5-second default request timeout.
- Startup and background scans run in the same Node.js event loop as HTTP handling; synchronous parsing, SQLite入库 and state projection can delay queued requests.
- A real-source read-only probe sent the same initial requests concurrently (`/api/state`, `/api/board`, orchestration, sounds and `/api/health`). All responses were delayed about 5–6 seconds, while `/api/health` still returned HTTP 200.
- The UI started health only after the other initial requests, making the health request especially likely to hit the timeout boundary.

## Fix

- Start the initial health request before the other first-screen requests.
- Give `/api/health` a 15-second timeout appropriate for local scan backlog.
- Coalesce health polling while a previous health request is pending.
- Treat a health timeout as `后端忙 · 后台扫描中` warning rather than a false connection failure; genuine connection errors remain errors.

## Verification

- TDD regression: `public/session-status.test.js` covers timeout, early request and single-flight behavior.
- Main full regression — exit 0, 1396 tests, 1393 passed, 3 skipped, 0 failed.
- `npm run lint`, `npm run check`, `git diff --check` — exit 0.
- The known concurrent probe still showed delayed but successful HTTP responses; after the fix the frontend no longer misclassifies that backlog as a dead backend.

Verification label: `SELF_VERIFIED`.
