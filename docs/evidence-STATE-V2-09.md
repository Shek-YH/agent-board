# STATE-V2-09 Evidence — Codex Shadow Adapter

## Goal

Translate existing Codex parser events into metadata-only V2 Evidence behind the feature flag while leaving legacy parser/status and notification paths intact.

## Changed files

- `lib/agent-adapters/codex-state-adapter.js`
- `lib/agent-adapters/codex-state-adapter.test.js`

## Verification

- Initial RED: adapter test failed with missing `codex-state-adapter` module.
- `node --test <state-engine tests + Codex adapter test>` — exit 0, 33 passed, 0 failed.
- `npx eslint lib/state-engine lib/agent-adapters/codex-state-adapter.js` — exit 0.
- `npx tsc --noEmit --allowJs --checkJs --target ES2022 --module commonjs --moduleResolution node --skipLibCheck <explicit state-engine and adapter JS files>` — exit 0.
- `git diff --check` — exit 0.
- Full regression `npm test` with `TEMP/TMP=F:\\AgentBoard-test-temp-20260913` — exit 0, 1302 tests, 1299 passed, 3 skipped, 0 failed.

## Acceptance checks

- Codex turn start, user/assistant message, completion candidate, failed/interrupted, tool/subagent and session signals map to V2 events.
- Adapter emits only through injected `emit`; no Store/UI/notification/process/file access.
- `STATE_ENGINE_V2=off` returns no Evidence; `shadow` allows collection.
- Evidence preserves occurred/observed clocks and drops message text; child topology stays structural metadata.

## Known limitations

- Existing `lib/adapters/codex.js` is not yet wired to call this adapter; that is intentionally deferred until shadow runtime/Store integration.
- Codex real JSONL acceptance and session generation rebinding remain open.

## Rollback

Keep `STATE_ENGINE_V2=off` or remove the new adapter files; legacy Codex behavior is unchanged.

Verification label: `SELF_VERIFIED`.
