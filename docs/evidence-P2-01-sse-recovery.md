# P2-01 Evidence: SSE Sequence Recovery

- Status: PARTIAL / checkpoint. SSE broadcasts now use a versioned envelope (`version: 1`) with a monotonic process-local `seq`, `eventId`, and `id` field. The browser tracks the last sequence and reloads authoritative `/api/state` and `/api/board` snapshots when it detects a sequence gap. The health endpoint exposes a bounded, redacted diagnostics summary; it does not expose raw entries.
- Changed: `lib/diagnostics.js`, `lib/diagnostics.test.js`, `lib/sse-protocol.js`, `lib/sse-protocol.test.js`, `server.js`, `server-sse.test.js`, `server-rescan-active.test.js`, `public/app.js`, `public/sse-recovery.test.js`, `public/refresh-throttle.test.js`.
- Focused verification: diagnostics, SSE protocol, server contract, client recovery, and Runtime Auth tests -> 11 passed.
- Syntax/quality verification: `node --check server.js`, `node --check public/app.js`, `npm run lint`, and `npm run check` -> passed.
- HTTP smoke: `AB_PORT=4888 node server.js` plus `curl --max-time 2 -N -H "Accept: text/event-stream" http://127.0.0.1:4888/api/events` returned consecutive `hello`/`active` events with `id`, `version`, and `seq`; the server was then stopped and port 4888 was confirmed clear.
- Full regression: after making the timeout fixture deterministic, `npm test` -> 1255 passed, 3 skipped, 0 failed.
- Remaining: wire transition/storage diagnostics into their owning modules and add Electron/Playwright critical-flow smoke coverage.
- Rollback: revert the P2-01 SSE checkpoint; legacy payload parsing remains supported during rollout.
