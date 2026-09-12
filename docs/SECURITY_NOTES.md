# Security Notes

## Current boundary

- The existing backend remains bound to loopback; this phase did not broaden its listener or weaken Electron sandbox/integration settings.
- AutoPilot Verified Dispatch, Policy Gate, Identity Verification, Delivery Verification, lease, retry, watchdog, handoff, allowed roots, and fail-closed behavior were not changed.
- Storage dry-run and benchmark commands do not read real AppData unless explicit file paths are supplied.

## Development dependencies

- `eslint@8.57.1` — MIT, dev-only.
- `typescript@5.9.2` — Apache-2.0, dev-only.
- `@types/node@22.20.2` — MIT, dev-only.

## Not yet implemented

The separate UI runtime token, Host/Origin/Content-Type mutation checks, and formal UI-vs-WorkBuddy Hook token separation remain a later P1 security work item. This document does not claim a remote vulnerability or a completed auth hardening.
