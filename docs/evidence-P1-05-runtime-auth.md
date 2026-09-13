# P1-05 Evidence: UI Runtime Auth

- Status: PARTIAL / checkpoint. Electron desktop UI mutations now use an ephemeral UI runtime token with loopback Host/Origin, JSON Content-Type, and 10 MiB Content-Length checks. WorkBuddy Hook auth remains separate; `/api/complete` remains an agent-hook compatibility path.
- Changed: `lib/runtime-auth.js`, `runtime-auth.test.js`, `server.js`, `server-runtime-auth.test.js`, `public/api-client.js`, `public/api-client.test.js`.
- Focused verification: Runtime Auth/API client/server contract tests -> 11 passed.
- Full regression: `npm test` -> 1244 passed, 3 skipped, 1 pre-existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion).
- Safety: UI token values are ephemeral and not persisted or logged; no Hook token is reused as a UI token; AutoPilot Verified Dispatch and fail-closed paths were not changed.
- Remaining: handle token refresh after backend restart, validate every intended mutation/Hook route with integration requests, and add security-header/CSP review.
- Rollback: revert the Runtime Auth checkpoint; source-mode CLI remains compatible because enforcement is enabled for `AB_RUNTIME=desktop`.
