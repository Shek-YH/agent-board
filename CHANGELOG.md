# Changelog

## Unreleased

- Added the opt-in State Engine V2 core: canonical liveness/session/turn/activity/attention dimensions, metadata-safe Evidence, source watermarks, authority arbitration, deterministic reducer/replay, golden fixtures and bounded queue support.
- Added Codex and WorkBuddy shadow/on Store bridges while preserving legacy status fields and `STATE_ENGINE_V2=off` rollback.
- Added redacted State Engine diagnostics API, Settings Hub timeline/export UI and migration/rollback notes.
- Added regression coverage for Turn vs Session separation, waiting/failed/interrupted states, child sessions, duplicate/late Evidence and heartbeat liveness.
- Added generation-scoped Session Identity, manifest-backed adapter contract, debounced Process Liveness, completion ID dedupe and a 32-scenario P0 replay matrix.
