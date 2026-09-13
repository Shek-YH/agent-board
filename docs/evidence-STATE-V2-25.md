# STATE-V2-25 Evidence — Universal Adapter Contract

## Goal

Define a common manifest-backed Evidence adapter surface without rewriting existing source parsers or allowing adapters to write final state/UI/notifications.

## Changed files

- `lib/state-engine/adapter-contract.js`
- `lib/state-engine/adapter-contract.test.js`
- `lib/agent-adapters/codex-state-adapter.js`
- `lib/agent-adapters/workbuddy-state-adapter.js`
- `lib/agent-manifests/*.json`

## Verification

- `node --test lib/state-engine/adapter-contract.test.js lib/agent-adapters/codex-state-adapter.test.js lib/agent-adapters/workbuddy-state-adapter.test.js` — exit 0, 12 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Codex and WorkBuddy expose `agentId`, manifest capabilities and `collectEvidence`.
- Contract validates matching manifest and required collector, copies only safe methods, and rejects direct state/UI/notification keys.
- Unknown or malformed manifest IDs fail closed; all current Agent manifests are explicit.

## Known limitations

- Non-Codex/WorkBuddy adapters are declared but not yet emitting V2 Evidence.
- Process/transcript/jump optional methods remain future adapter seams.

## Rollback

Remove the contract layer and keep legacy adapters; V2 remains off.

Verification label: `SELF_VERIFIED`.
