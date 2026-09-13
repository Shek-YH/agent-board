# Electron startup readiness evidence

- Symptom: packaged Electron showed backend startup timeout even though the backend entry file existed.
- Root cause: desktop readiness probing requested `/api/state`, which performs the full board query and serialization while initial scans may be active; the 1-second probe could false-negative.
- Fix: added lightweight `GET /api/ready` returning only the runtime identity, and changed `desktop/backend-process.js` to probe it with a 3-second request timeout while retaining identity checks.
- Focused test: `node --test desktop/backend-process.test.js` -> 7 passed, including readiness path verification.
- Full regression: `npm test` -> 1231 passed, 3 skipped, 1 existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion).
- Package verification: `npm run desktop:verify` -> passed.
- Real packaged smoke: isolated Electron user-data directory; `/api/ready` and `/api/state` both returned HTTP 200 by tick 7; test process tree was stopped afterward.
- Existing installed app: `D:\Program Files (x86)\AgentBoard2\Agent Board` was not terminated or overwritten; it held the single-instance lock during diagnosis.
