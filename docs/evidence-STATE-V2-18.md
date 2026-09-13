# STATE-V2-18 Evidence — Automated and Available Acceptance

## Goal

Run the available automated, synthetic and local integration acceptance, and explicitly separate unavailable real-agent/manual checks.

## Verified

- Core State Engine: enums, Evidence safety, runtime, source watermark, arbitration, reducer, projection, replay, golden fixtures, queue.
- Codex and WorkBuddy metadata-only adapters plus Store shadow/on bridges.
- Diagnostics builder/API contract and Settings Hub diagnostics UI contract.
- Turn/Session separation, waiting states, heartbeat liveness-only semantics, child/session identity boundaries and duplicate Evidence behavior.
- Full `npm test` — exit 0, 1327 tests, 1324 passed, 3 skipped, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.

## Not verified / WAITING_USER

- Real long-running Codex and WorkBuddy sessions, process crash/sleep-wake/restart against live Agent data.
- Real Codex App + CLI same-CWD separation and WorkBuddy native sequence/generation behavior.
- Browser-driven click flow for the new Settings diagnostics panel.
- Installed NSIS/manual install, Windows security-software false-positive review and commercial release acceptance.

These checks require user-controlled login/private Agent data or installed-app/manual interaction and are not replaced by mocks.

## Safety

- Tests used isolated F-drive temporary directories where required; real `%LOCALAPPDATA%` Agent Board data was not migrated or deleted.
- No credential, token, cookie, transcript body or prompt was persisted in Evidence, diagnostics, fixtures, logs or ledger.
- V2 remains opt-in with `STATE_ENGINE_V2=off` as rollback.

Verification label: `SELF_VERIFIED` for automated checks; unavailable manual items remain unverified.
