# STATE-V2-23 Evidence — Process Liveness and Source Health

## Goal

Provide an injectable process-liveness reducer with missing-process debounce and bounded source-health metadata, without mapping process existence to activity/RUNNING.

## Changed files

- `lib/state-engine/liveness.js`
- `lib/state-engine/liveness.test.js`

## Verification

- `node --test lib/state-engine/*.test.js` — exit 0, 58 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.

## Acceptance checks

- Exact process identity emits `PROCESS_SEEN` and `ALIVE`; unmatched identity stays `UNKNOWN`.
- Consecutive misses move through `SUSPECT` before configured `DEAD` threshold.
- Process service never emits turn/activity/session completion semantics.
- Source health returns only bounded status values and no session content.

## Known limitations

- Existing OS process probes are not yet routed through this service; the next Engine integration adds that injectable seam.
- Live crash/sleep-wake/rebind behavior remains user-controlled acceptance.

## Rollback

Remove the liveness module; existing legacy process checks remain available.

Verification label: `SELF_VERIFIED`.
