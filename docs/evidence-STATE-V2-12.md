# STATE-V2-12 Evidence — Divergence Audit

## Goal

Review confirmed legacy/V2 divergence candidates before primary rollout and ensure each discovered core issue has a reproducing test and focused fix.

## Result

No new production divergence fix was required in this checkpoint. The divergence candidates found during Tasks 05–08 were closed with focused changes and regression tests:

- Parent `SUBAGENT_FINISHED` no longer overwrites a parent completion candidate with RUNNING.
- Explicit `SESSION_CLOSED` is not overwritten by the generic OPEN fallback.
- Golden parent completion uses a source whose authority matches the intended strong lifecycle signal.
- Evidence clock validation is strict while confidence/authority bounds remain clamped.
- Projection shadow comparison flags completed Turn + OPEN Session for later rollout visibility.

## Verification

- `node --test <state-engine and adapter tests>` — exit 0, 40 passed, 0 failed before the final adapter additions; current post-checkpoint core suite remains green at 40+ tests.
- Golden fixtures — exit 0, 8 fixtures passed.
- Full regression `npm test` with `TEMP/TMP=F:\\AgentBoard-test-temp-20260913` — exit 0, 1302 tests, 1299 passed, 3 skipped, 0 failed.
- ESLint, explicit TypeScript check and `git diff --check` passed at the checkpoint.

## Acceptance checks

- Every previously observed divergence has a named cause, focused fix and regression assertion.
- No speculative timeout or Store-wide refactor was introduced.
- Primary rollout remains blocked until a real State Engine runtime/Store integration is in place and shadow evidence is collected from adapters.

## Rollback

Use local commit `b910a5f` as the code checkpoint; do not reset unrelated work or push automatically.

Verification label: `SELF_VERIFIED`.
