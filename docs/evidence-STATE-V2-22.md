# STATE-V2-22 Evidence — Session Identity and Capability Manifests

## Goal

Add generation-scoped Session Identity V2 and declarative capabilities/authority/timeouts for all current Agent IDs.

## Changed files

- `lib/state-engine/identity.js`
- `lib/state-engine/identity.test.js`
- `lib/state-engine/manifest.js`
- `lib/state-engine/manifest.test.js`
- `lib/agent-manifests/{codex,workbuddy,claude,pi,hermes,marvis,deepseek,zcode}.json`

## Verification

- Initial RED: identity and manifest tests failed with missing modules.
- `node --test lib/state-engine/*.test.js` — exit 0, 51 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Identity normalizes strong anchors and produces `agent:nativeSessionId:gen:N` keys.
- Generation advances are immutable and reasoned; same CWD with different native IDs does not match.
- Codex/WorkBuddy and all current agents have explicit capabilities, authority arrays and centralized timeout values.
- Unknown/path-like manifest IDs fail closed; loaded manifests are deeply frozen.

## Known limitations

- Runtime still has a small duplicate identity normalizer; later liveness/engine work can converge it without changing legacy fields.
- Manifests are loaded as a V2 library surface; remaining adapters are not yet migrated to emit V2 Evidence.

## Rollback

Remove identity/manifest modules and JSON declarations; existing runtime/adapter paths remain.

Verification label: `SELF_VERIFIED`.
