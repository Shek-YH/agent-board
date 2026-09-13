# STATE-V2-24 Evidence — Completion IDs and Notification Boundary

## Goal

Generate deterministic completion IDs, dedupe notifications per runtime and keep mark-seen/mark-turn-done separate from Session closure.

## Changed files

- `lib/state-engine/completion.js`
- `lib/state-engine/completion.test.js`
- `lib/state-engine/index.js`
- `lib/state-engine/index.test.js`
- `lib/state-engine/liveness.js`
- `lib/state-engine/liveness.test.js`

## Verification

- `node --test lib/state-engine/*.test.js` — exit 0, 58 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Completion ID combines agent, generation-scoped runtime key, turn ID and completion time.
- Engine invokes injected completion callback once; duplicate Evidence is rejected by watermark and duplicate ID is rejected by runtime notification history.
- mark seen clears attention only; mark turn done completes the Turn and keeps Session OPEN.
- Process observation enters the same Engine as liveness-only Evidence and exposes bounded source health.

## Known limitations

- Existing legacy Store notification path is not replaced; V2 callback integration with the notification transport remains controlled rollout work.
- Manual HTTP/UI actions for mark seen/mark turn done are not yet exposed.

## Rollback

Keep legacy completion notification handling and `STATE_ENGINE_V2=off`; remove the V2 completion/liveness modules if needed.

Verification label: `SELF_VERIFIED`.
