# STATE-V2-20 Evidence — Persistence and Restart Recovery

## Goal

Persist State Engine identity/canonical/watermark metadata in a separate atomic snapshot and recover conservatively after restart.

## Changed files

- `lib/state-engine/persistence.js`
- `lib/state-engine/persistence.test.js`
- `lib/state-engine/index.js`
- `lib/state-engine/index.test.js`
- `lib/state-engine/runtime.js`
- `lib/store.js`

## Verification

- `node --test lib/state-engine/index.test.js lib/state-engine/persistence.test.js` — exit 0, 6 passed, 0 failed.
- `npm run lint` — exit 0.
- `npm run check` — exit 0.
- `git diff --check` — exit 0.
- Full regression `npm test` with `TEMP/TMP=F:\\AgentBoard-test-temp-20260913` — exit 0, 1330 tests, 1327 passed, 3 skipped, 0 failed.

## Acceptance checks

- Snapshot is schema-versioned and atomically written to a separate `state-engine-v2.json` path when shadow/on is enabled.
- Identity/generation, canonical terminal state, completion notification IDs and source watermarks restore across a new engine instance.
- Recent raw Evidence values/transcript bodies are omitted; corrupt snapshots return null without overwriting the source file.
- Persisted RUNNING/STARTING state is conservatively recovered as liveness UNKNOWN, turn NONE, activity UNKNOWN and empty active sets; terminal Turn remains recoverable.
- Default `STATE_ENGINE_V2=off` does not create or load V2 runtime.

## Known limitations

- Real process rebind/transcript reattachment after restart is not yet verified against live Agents.
- Snapshot persistence is synchronous and per accepted Evidence; performance on very large real session counts remains manual acceptance work.

## Rollback

Set `STATE_ENGINE_V2=off`; leave the separate snapshot untouched or remove only a confirmed V2 snapshot file after review. Legacy data is not migrated or rewritten.

Verification label: `SELF_VERIFIED`.
