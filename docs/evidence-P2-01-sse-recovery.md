# P2-01 Evidence: SSE Sequence Recovery

- Status: PARTIAL / checkpoint. SSE broadcasts now use a versioned envelope (`version: 1`) with a monotonic process-local `seq`, `eventId`, and `id` field. The browser tracks the last sequence and reloads authoritative `/api/state` and `/api/board` snapshots when it detects a sequence gap. The health endpoint exposes a bounded, redacted diagnostics summary; it does not expose raw entries.
- Changed: `lib/diagnostics.js`, `lib/diagnostics.test.js`, `lib/sse-protocol.js`, `lib/sse-protocol.test.js`, `server.js`, `server-sse.test.js`, `server-rescan-active.test.js`, `public/app.js`, `public/sse-recovery.test.js`, `public/refresh-throttle.test.js`, `desktop/main.js`, `tools/electron-smoke.js`, `tools/electron-smoke.test.js`.
- Focused verification: diagnostics, SSE protocol, server contract, client recovery, and Runtime Auth tests -> 11 passed.
- Syntax/quality verification: `node --check server.js`, `node --check public/app.js`, `npm run lint`, and `npm run check` -> passed.
- Electron smoke: `npm run desktop:smoke` -> passed. It launched an isolated Electron user-data profile, selected a dedicated local port, and verified `/api/ready`, `/api/state`, and `/api/health`; the temporary profile and process tree were cleaned up.
- HTTP smoke: `AB_PORT=4888 node server.js` plus `curl --max-time 2 -N -H "Accept: text/event-stream" http://127.0.0.1:4888/api/events` returned consecutive `hello`/`active` events with `id`, `version`, and `seq`; the server was then stopped and port 4888 was confirmed clear.
- Full regression: after making the timeout fixture deterministic, `npm test` -> 1256 passed, 3 skipped, 0 failed.
- Remaining: wire transition/storage diagnostics into their owning modules, add UI click-flow coverage with Electron/Playwright, and run the smoke against a freshly rebuilt packaged installer.
- Rollback: revert the P2-01 SSE checkpoint; legacy payload parsing remains supported during rollout.
