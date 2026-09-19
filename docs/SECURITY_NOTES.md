# Security Notes

## Current boundary

- The desktop backend remains bound to loopback; this phase did not broaden its listener or weaken Electron sandbox/integration settings.
- In desktop mode, every UI mutation is checked before route dispatch. This includes `/api/orchestration/*` and `/api/jarvis/voice`.
- WorkBuddy and Agent completion Hooks require independent loopback JSON Bearer tokens. The completion configuration is written beneath `%LOCALAPPDATA%\AgentBoard\hooks`, never under `public/`.
- Electron only opens `http:` and `https:` external URLs.
- AutoPilot Verified Dispatch, Policy Gate, Identity Verification, Delivery Verification, lease, retry, watchdog, handoff, allowed roots, and fail-closed behavior were not changed.
- Storage dry-run and benchmark commands do not read real AppData unless explicit file paths are supplied.

## Development dependencies

- `eslint@8.57.1` — MIT, dev-only.
- `typescript@5.9.2` — Apache-2.0, dev-only.
- `@types/node@22.20.2` — MIT, dev-only.

## Remaining work

The cloud Agent endpoint now uses the documented strict-scope interim rule: an Agent can only promote a User who is already attached to its own subtree. An invitation/claim workflow is still the recommended future design for allowing a previously unassigned User to opt in. Token refresh after backend restart, complete route-by-route integration coverage, and security-header/CSP review remain open. This document does not claim a remote vulnerability or complete production hardening.
