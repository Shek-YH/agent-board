# STATE-V2-30 Evidence — Fully Isolated Package Smoke

## Goal

Ensure packaged Electron smoke cannot read or write real Agent Board data, configuration or Agent transcript sources while exercising the packaged runtime.

## Changed files

- `tools/electron-smoke.js`
- `tools/electron-smoke.test.js`

## Verification

- TDD regression initially failed because the smoke environment did not override backend paths.
- The harness now sets temporary `AB_DATA_DIR` and `AB_CONFIG_DIR`, plus isolated source paths for Claude, Codex, WorkBuddy, DeepSeek, Marvis, ZCode, Pi and Hermes (including Codex index, WorkBuddy DB/heartbeat/spool and Hermes DB).
- `node --test tools/electron-smoke.test.js` — exit 0, 1 passed, 0 failed.
- Packaged smoke using `dist-state-engine-v2-20260913/win-unpacked/Agent Board.exe` — exit 0; verified desktop runtime and `/api/ready`, `/api/state`, `/api/health` with temporary paths.
- The earlier package smoke run before this isolation fix is superseded and is not used as the security-isolated acceptance evidence.

## Boundary

- This strengthens the isolated package/unpacked smoke gate.
- It does not replace installation over the real user environment, security-software review or real Codex/WorkBuddy long-running acceptance; those remain `STATE-V2-21 WAITING_USER`.

Verification label: `SELF_VERIFIED` for the isolated harness and packaged smoke.
