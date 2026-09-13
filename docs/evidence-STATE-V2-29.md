# STATE-V2-29 Evidence — Current Main Package Smoke

## Goal

Build and verify a fresh package from the landed `main` branch without overwriting the existing `dist-main-20260913/` artifact or real user data.

## Artifact

- Output: `dist-state-engine-v2-20260913/`
- Target: Windows x64 NSIS plus `win-unpacked`
- The unpacked package contains `lib/state-engine/index.js`, `lib/state-engine/diagnostics.js`, Codex/WorkBuddy manifests and `public/session-lifecycle-status.js`.

## Verification

- `npx electron-builder --win nsis --config.directories.output=dist-state-engine-v2-20260913` — exit 0.
- `node tools/verify-package.js dist-state-engine-v2-20260913/win-unpacked` — exit 0.
- Packaged Electron smoke with isolated temporary user-data and a free loopback port — exit 0; verified desktop runtime identity and `/api/ready`, `/api/state`, `/api/health`.
- The first smoke timeout was reproduced as a 1.5-second `/api/state` harness limit; the harness now uses a 15-second state timeout and has a regression test.

## Boundary

- This proves fresh package contents and isolated unpacked execution.
- The NSIS installer was not installed over the real user installation; manual installation, shortcut/data-preservation review and security-software review remain `STATE-V2-21 WAITING_USER`.

Verification label: `SELF_VERIFIED` for package build, static verification and isolated smoke.
