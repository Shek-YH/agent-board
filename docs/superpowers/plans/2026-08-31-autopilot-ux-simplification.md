# AutoPilot UX Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Session 卡的 AI 托管入口简化为“自动绑定当前 Session + 用户只填写 Goal”，并让 AutoPilot 调度、预算、安全和 Provider 凭据通过设置中心持久化继承。

**Architecture:** 前端只提交当前 Session 引用和 Goal；服务端通过 SessionLocator/IdentityVerifier 重新解析 Agent 与项目路径，使用全局 AutoPilot 设置补齐 Run Contract 和 Routing Defaults。Provider 凭据按 Provider 存储在 Electron safeStorage 中，旧的 Workflow routingConfig 与环境变量作为兼容覆盖层保留。

**Tech Stack:** Node.js CommonJS、原生 HTML/CSS/JavaScript、Electron IPC、JSON 文件存储、Node built-in test runner、现有 AutoPilot WorkflowStore/AutoLoop/Capability Registry。

---

## Scope and file map

- `public/index.html`：将 Session 快速入口和主表单改为 Goal-only；保留高级字段在折叠区域。
- `public/app.js`：提交 `sessionRef + goal` 的快速路径，显示只读绑定上下文，并接入 PRD 草稿按钮。
- `lib/orchestrator/settings-store.js`：持久化 AutoPilot 默认设置，使用原子写入和默认值合并。
- `lib/orchestrator/api.js`、`server.js`：增加从 Session 创建 Workflow、读取/保存设置、发现 PRD 的服务端入口。
- `lib/orchestrator/workflow-store.js`：在新 Workflow 生成时保存 settings snapshot，不改写历史 Workflow。
- `lib/orchestrator/project-prd.js`：限制在当前项目内发现和读取 PRD，输出受控文本摘要。
- `desktop/secure-store.js`、`desktop/main.js`、`lib/orchestrator/provider-config.js`、`lib/jarvis-voice.js`：保持 Provider 级安全存储并统一能力槽位读取。
- `public/*.test.js`、`lib/orchestrator/*.test.js`、`desktop/*.test.js`：覆盖快速入口、继承、持久化、密钥隔离和 PRD 确认边界。

## Task 1: Document baseline and API preparation

**Files:**
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/Agent_Board_AutoPilot_PRD_V2.2.md`
- Create: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/项目所需api.txt`
- Create: `docs/superpowers/plans/2026-08-31-autopilot-ux-simplification.md`

- [x] Add PRD section 158 covering the Session fast path, global settings, Provider credentials, PRD Goal assistant, safety boundaries, staged acceptance criteria, and compatibility rules.
- [x] Record required and optional credentials, exact environment variable names, default endpoints, local Agent prerequisites, and secret handling without real values.
- [x] Verify with `git diff --check` and inspect both external documents before the baseline commit.

## Task 2: Persist global AutoPilot settings

**Files:**
- Create: `lib/orchestrator/settings-store.js`
- Test: `lib/orchestrator/settings-store.test.js`
- Modify: `server.js`, `lib/orchestrator/api.js`, `lib/orchestrator/workflow-store.js`
- Test: `lib/orchestrator/api.test.js`

- [ ] Write tests for defaults, atomic persistence, unknown-field removal, reload, settings routes, and Workflow inheritance.
- [ ] Run `node --test lib/orchestrator/settings-store.test.js lib/orchestrator/api.test.js` and confirm the new settings behavior fails before implementation.
- [ ] Implement `get()`, `update(patch)`, and `reset()` with known-section merging and same-directory temporary-file rename.
- [ ] Add `GET /api/orchestration/settings` and `PUT /api/orchestration/settings`; use settings only when a new Workflow omits an explicit compatibility override.
- [ ] Run the focused tests and confirm zero failures.

## Task 3: Session-card Goal-only fast path

**Files:**
- Modify: `public/index.html`, `public/app.js`, `server.js`
- Test: `public/autopilot-fast-path.test.js`, `public/ai-monitor-contract.test.js`, `lib/orchestrator/api.test.js`

- [ ] Add failing UI contracts for the `AI 托管` label, Goal control, manual/PRD source actions, and hidden editable metadata fields.
- [ ] Run the focused UI tests and confirm they fail against the old multi-field entry.
- [ ] Render a compact composer that derives `s.id`, `s.agent`, and `s.project` into locked context and submits only `sessionRef`, `goal`, and `goalSource`.
- [ ] Add a server fast path that resolves the Session again, forces current-project scope, derives the binding server-side, and inherits the persisted mode/routing defaults.
- [ ] Keep the old form behind an advanced/manual entry and run all focused UI/orchestration tests.

## Task 4: Unified Provider credential access

**Files:**
- Modify: `desktop/secure-store.js`, `desktop/main.js`, `lib/orchestrator/provider-config.js`, `lib/jarvis-voice.js`
- Test: `desktop/secure-store.test.js`, `lib/orchestrator/provider-config.test.js`, `lib/jarvis-voice.test.js`

- [ ] Add a failing test proving one Provider credential can satisfy multiple allowed capability slots and is absent from serialized workflow/audit data.
- [ ] Run the focused tests and confirm the old per-surface configuration fails the new contract.
- [ ] Implement capability-based Provider lookup while retaining environment-variable fallback; expose only configured status to the renderer.
- [ ] Verify the Supervisor and voice runtime can use the same Provider credential without logging or persisting the secret outside safeStorage.

## Task 5: PRD Goal assistant with explicit confirmation

**Files:**
- Create: `lib/orchestrator/project-prd.js`
- Test: `lib/orchestrator/project-prd.test.js`
- Modify: `server.js`, `public/app.js`
- Test: `public/autopilot-fast-path.test.js`

- [ ] Add failing tests for bounded PRD discovery, outside-project refusal, missing PRD, and draft-only behavior.
- [ ] Run `node --test lib/orchestrator/project-prd.test.js` and confirm the missing-module failure.
- [ ] Search only the current project root for `PRD.md`, `*PRD*.md`, and `docs/*prd*.md`, cap file size, and return sanitized text.
- [ ] Add a draft endpoint and place the result into the Goal field; require the existing Start action before creating or running a Workflow.
- [ ] Run the focused PRD/UI tests and verify no draft call starts a Workflow.

## Task 6: Full regression and delivery

**Files:** Only the files listed above if verification requires a fix.

- [ ] Run `npm test` and record the exact pass/fail/skip counts.
- [ ] Run `npm run desktop:verify -- dist-autopilot-20260830/win-unpacked` and confirm the packaged resources contain the updated UI/runtime.
- [ ] Run `git diff --check`, `git status --short --branch`, and `git diff --stat`; leave all historical untracked `dist-*` directories untouched.
- [ ] Commit intended source and plan changes with `git add public lib desktop server.js docs/superpowers/plans/2026-08-31-autopilot-ux-simplification.md && git commit -m "feat: simplify autopilot setup and globalize defaults"`.
- [ ] Report changed files, exact verification commands, the external PRD/API paths, and any remaining provider or legacy-workflow limitations.
