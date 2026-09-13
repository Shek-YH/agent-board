# STATE-V2-17 Evidence — Performance and Backpressure

## Goal

Bound high-frequency Evidence handling and prove recent Evidence retention/coalescing do not grow without limit.

## Changed files

- `lib/state-engine/queue.js`
- `lib/state-engine/queue.test.js`

## Verification

- Initial RED: queue test failed with missing `queue` module.
- `node --test <state-engine and adapter/bridge tests>` — exit 0, 54 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.
- Full regression after Store/diagnostics integration — exit 0, 1324 tests, 1321 passed, 3 skipped, 0 failed.

## Acceptance checks

- Heartbeat/process items for one agent/session/source coalesce to the latest Evidence.
- Queue size never exceeds configured maxSize; terminal events displace removable high-frequency items first.
- When no removable item exists, new terminal input fails closed with `queue_full` instead of growing memory.
- Canonical Runtime retains only the configured bounded recent Evidence window (1000 in the current implementation).
- Existing incremental watcher/range-read behavior remains covered by the full regression.

## Known limitations

- Queue is exposed as a reusable primitive; the live server does not yet batch every collector through it.
- SLO measurements and real long-running Agent workloads remain final acceptance work.

## Rollback

Remove `queue.js` and its tests; correctness paths remain synchronous and bounded by Runtime retention.

Verification label: `SELF_VERIFIED`.
