# Agent Board State Engine V2 — Risk Register

| Risk | Impact | Mitigation / gate |
|---|---|---|
| Turn completion is mistaken for session closure | False completed state, lost follow-up turns | Separate canonical dimensions; reducer and golden replay tests before adapter rollout |
| Late or out-of-order evidence is dropped | High-value hook ignored | Per-source watermark and authority comparator; never use one global timestamp |
| Existing dirty/runtime state is overwritten | User data or unrelated work loss | Clean intake, scoped edits, no real AppData migration, no push or dist overwrite |
| Codex/WorkBuddy source semantics diverge | Adapter regressions | Source-specific policies/manifests, shadow comparison, existing regression suite |
| PID/process evidence is over-trusted | Resident app marked as running session | Process evidence only affects liveness and requires identity matching |
| Diagnostics leak private content | Security/privacy incident | Metadata-only evidence, redaction tests, no transcript body or secrets |
| V2 breaks legacy consumers | UI/notification regression | `STATE_ENGINE_V2=off`, compatibility projection, old fields retained until Phase 4 |
| Real-agent behavior differs from fixtures | Production misclassification | Synthetic first, then explicit real Codex/WorkBuddy acceptance; unresolved behavior remains unverified |
