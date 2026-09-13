# STATE-V2-06 Evidence — UI and Legacy Projection

## Goal

Project Canonical Runtime into user-facing status and legacy-compatible state while preserving an explicit `off|shadow|on` rollout flag.

## Changed files

- `lib/state-engine/projection.js`
- `lib/state-engine/projection.test.js`

## Verification

- `node --test lib/state-engine/*.test.js` — exit 0, 24 passed, 0 failed.
- `npx eslint lib/state-engine` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine JS files>` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Waiting approval/input, command/tool/subagent work, thinking, completed, failed and interrupted states have distinct UI keys and labels.
- Internal `ALIVE` and `OPEN` values are retained only in canonical data, not shown as the primary UI label.
- Completed Turn remains compatible as `completed` while an OPEN Session can be flagged as a shadow divergence.
- `off` defaults to legacy, `shadow` keeps legacy primary with V2 available for comparison, and `on` selects the V2 projection.

## Known limitations

- No actual Store/UI route consumes this projection yet; migration is later.
- Shadow comparison is currently returned in-memory, without persistence/telemetry.

## Rollback

Keep `STATE_ENGINE_V2=off` and remove the projection module; legacy consumers are unchanged.

Verification label: `SELF_VERIFIED`.
