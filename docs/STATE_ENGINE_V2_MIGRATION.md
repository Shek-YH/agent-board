# State Engine V2 Migration Notes

## Current rollout

`STATE_ENGINE_V2` supports three modes:

- `off` (default): legacy Store/status paths only; no V2 runtime is created.
- `shadow`: Codex and WorkBuddy adapters emit V2 Evidence and the Store exposes V2 diagnostics, but legacy state remains primary.
- `on`: Store status snapshots include `canonical_state` and `ui_status`; the frontend selects the V2 UI key while preserving legacy `state` for compatibility.

## Data flow

```text
Codex JSONL / WorkBuddy Hook / DB / Heartbeat
→ metadata-only Evidence
→ per-source watermark
→ attribute-level authority arbitration
→ pure reducer
→ canonical_state + ui_status
```

Adapters must not write final UI state or notifications. `TURN_COMPLETION_SIGNAL` is a Turn candidate; only explicit confirmation becomes `COMPLETED`. `SESSION_CLOSED`/`SessionEnd` controls Session closure independently.

## Safe rollout sequence

1. Run golden replay and focused/full tests with `off`.
2. Run synthetic Store shadow smoke and inspect `/api/state-engine/diagnostics`.
3. Compare legacy and V2 status in `shadow`; investigate each divergence with a fixture.
4. Enable `on` only for a controlled local session after diagnostics are clean.
5. Do not remove legacy fields/maps until real Codex + WorkBuddy, browser and restart acceptance is complete.

## Persistence status

When shadow/on is enabled, V2 persists a separate `state-engine-v2.json` snapshot containing safe canonical/identity/watermark metadata. It omits recent raw Evidence values and does not migrate or rewrite the legacy `data.json`; default off remains untouched. Process rebind and live transcript recovery still require real-agent acceptance.

## Safety boundary

Diagnostic and Evidence payloads exclude prompts, replies, message bodies, tokens, cookies, passwords and secrets. Real Agent data, login and installed-app acceptance must be supplied/verified by the user in a controlled environment.
