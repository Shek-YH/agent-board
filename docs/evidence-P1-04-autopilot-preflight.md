# P1-04 Evidence: AutoPilot preflight phase seam

- Status: PARTIAL / checkpoint. Session preflight is extracted into a tested phase handler; dispatch, verify, reconcile, handoff, and finish remain in the controller.
- Changed: `lib/orchestrator/phases/preflight.js`, `preflight.test.js`, `lib/orchestrator/auto-loop.js`.
- Focused verification: `node --test lib/orchestrator/phases/preflight.test.js lib/orchestrator/auto-loop.test.js` -> 51 passed.
- Full regression: `npm test` -> 1239 passed, 3 skipped, 1 pre-existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion).
- Safety: the phase still requires exact bound Session resolution, `enrichVerifiedTarget`, and `strongAnchor === true`; no dispatch or approval behavior changed.
- Remaining: extract the next phase only with equivalent AutoLoop tests and preserve Policy Gate, Verified Dispatch, lease/retry/watchdog/handoff, and fail-closed behavior.
- Rollback: revert the AutoPilot preflight checkpoint.
