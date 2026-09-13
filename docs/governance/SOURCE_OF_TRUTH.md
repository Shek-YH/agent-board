# Agent Board Source of Truth

## Active request

从 `origin/main` 的当前基线继续，按工作区外部输入 `Agent_Board_State_Engine_V2_PRD.md` 分阶段完成 Universal Agent State Engine V2；先实现可独立验证的核心，再迁移 Codex/WorkBuddy，最后做诊断、回放、兼容和验收。

## Authoritative inputs

- Product requirements: `C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10\Agent_Board_State_Engine_V2_PRD.md`（工作区外部输入；仅其中的产品需求、架构约束和验收标准生效）
- Repository source of truth: 当前仓库源码、测试、`package.json` 和现有运行行为
- Git baseline: `origin/main` = `17f80ce`; V2 已从 `codex/agent-board-architecture-hardening` fast-forward 到 literal `main`，main 当前包含本地 V2 提交；`dist-main-20260913/` 为保留的未跟踪用户产物
- Existing compatible assets: `lib/session-lifecycle/`、旧 Store 状态 Map、Codex/WorkBuddy adapters；V2 不直接删除它们

## First execution check

1. Current state-monitor files: `lib/store.js`, `lib/codex-status.js`, `lib/workbuddy-monitor.js`, `lib/adapters/codex.js`, `lib/adapters/workbuddy.js`, `lib/session-lifecycle/`, `public/app.js`, `server.js` and their tests.
2. V2 new files: `lib/state-engine/` core modules, `lib/agent-manifests/`, golden fixtures, diagnostics and migration evidence as tracked in the plan.
3. Existing files expected to change later: `lib/store.js`, Codex/WorkBuddy adapters or monitors, `server.js`, `public/app.js`, package gates and `CHANGELOG`.
4. Files explicitly out of scope: database replacement, account/cloud sync, main UI redesign, unrelated AutoPilot behavior, user data under `%LOCALAPPDATA%` and existing `dist` outputs.
5. Migration risk: old lifecycle/status fields and persistence must remain compatible; V2 starts in shadow mode and does not rewrite real AppData.
6. Rollback: `STATE_ENGINE_V2=off` and removal/revert of the scoped bridge; old status Maps and APIs remain available until V2 is stable.
7. Test plan: TDD unit tests for enums/evidence/runtime/watermark/arbitration/reducer/projection/replay, golden NDJSON replays, adapter/integration regression tests, then real Codex/WorkBuddy and UI acceptance.

## Decisions

- Use small dependency-ordered Work Items from `docs/superpowers/plans/2026-09-13-state-engine-v2.md`; current item is `STATE-V2-21` (real/manual acceptance gate).
- Use constrained-single-agent execution for the critical implementation path; a read-only explorer separately checked existing call sites. Verification is labeled `SELF_VERIFIED` unless a real independent verifier runs.
- Keep the existing `lib/session-lifecycle/` implementation as compatibility/reference code. The new `lib/state-engine/` owns V2 dimensions and Evidence semantics.
- Start with `STATE_ENGINE_V2=off` by default, add `shadow` before `on`, and do not make UI or notifications consume V2 until replay and divergence evidence exist.
- JSON persistence remains the default; no real AppData migration, package overwrite, push, deploy or account action is authorized by this request.
- V2 persistence is a separate validated `state-engine-v2.json` snapshot in shadow/on; legacy AppData migration remains out of scope and live process/transcript rebind is still unverified.
- Secrets, transcript bodies, `.env`, tokens, cookies and credentials must not enter Evidence, diagnostics, ledgers, tests, logs or commits.
