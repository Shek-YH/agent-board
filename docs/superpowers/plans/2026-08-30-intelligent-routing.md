# Intelligent Execution Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Codex 单 Session Auto Loop 增加可验证的 Runtime Model/Reasoning Routing，并保持无路由能力时基础 AutoPilot 可运行。

**Architecture:** 以纯函数 Catalog/Profile/Router 为核心，以注入式 Codex App Server Client 和 UIA fallback 作为边界能力。Auto Loop 只消费安全的 Routing Decision，并在 Verified Dispatch 前完成 Apply/Verify；路由摘要写入现有 WorkflowStore/dispatch record/audit event。

**Tech Stack:** Node.js CommonJS、Node test runner、现有 JSON WorkflowStore、现有 Codex UIA/Verified Dispatch。

---

### Task 1: 建立 Catalog 合同与规范化

**Files:**
- Create: `lib/orchestrator/routing/catalog.js`
- Test: `lib/orchestrator/routing/catalog.test.js`

- [ ] **Step 1: Write the failing test**：覆盖 `model/list` 响应规范化、supported reasoning、隐藏模型过滤、非法条目丢弃和缓存元数据。
- [ ] **Step 2: Run test to verify it fails**：运行 `node --test lib/orchestrator/routing/catalog.test.js`，应因模块不存在失败。
- [ ] **Step 3: Write minimal implementation**：实现 `normalizeCatalogResponse`、`findModel`、`supportedReasoning` 和 `isCatalogFresh`，只保留安全字段。
- [ ] **Step 4: Run test to verify it passes**：重新运行同一测试并确认通过。
- [ ] **Step 5: Commit**：`git add lib/orchestrator/routing/catalog.js lib/orchestrator/routing/catalog.test.js && git commit -m "feat: normalize codex model catalogs"`

### Task 2: 实现 Profile Resolver 与 C/T/P 路由规则

**Files:**
- Create: `lib/orchestrator/routing/profile.js`
- Test: `lib/orchestrator/routing/profile.test.js`

- [ ] **Step 1: Write the failing test**：覆盖 C0–C3、T0–T3、P0–P2、模型候选过滤、最近合法 reasoning 映射和 fallback reason。
- [ ] **Step 2: Run test to verify it fails**：运行 `node --test lib/orchestrator/routing/profile.test.js`。
- [ ] **Step 3: Write minimal implementation**：实现 `resolveExecutionProfile`，不访问外部系统、不改变人工 pin。
- [ ] **Step 4: Run test to verify it passes**：确认 profile 选择与映射全部通过。
- [ ] **Step 5: Commit**：提交 Profile Resolver 与测试。

### Task 3: 实现 Native Catalog/Apply/Verify 能力边界

**Files:**
- Create: `lib/orchestrator/routing/codex-app-server.js`
- Create: `lib/orchestrator/routing/profile-runtime.js`
- Test: `lib/orchestrator/routing/codex-app-server.test.js`
- Test: `lib/orchestrator/routing/profile-runtime.test.js`

- [ ] **Step 1: Write the failing tests**：覆盖 `model/list` 调用、Native apply/readback、UIA fallback、Session drift、Apply/Verify 失败 fail-closed，以及不修改全局配置。
- [ ] **Step 2: Run tests to verify they fail**：运行两个测试文件，确认模块/能力不存在导致失败。
- [ ] **Step 3: Write minimal implementation**：定义注入式 `listModels/readProfile/applyProfile/verifyProfile`，Native 优先，fallback 只能显式启用并返回可核对证据。
- [ ] **Step 4: Run tests to verify they pass**：确认每次 Apply 最多一次、失败不进入 dispatch。
- [ ] **Step 5: Commit**：提交 Codex Native capability boundary。

### Task 4: 实现 Catalog Cache 与 Drift Policy

**Files:**
- Create: `lib/orchestrator/routing/catalog-store.js`
- Test: `lib/orchestrator/routing/catalog-store.test.js`

- [ ] **Step 1: Write the failing test**：覆盖 native 优先、缓存 fallback、过期标记、Agent 版本失效、损坏缓存安全降级。
- [ ] **Step 2: Run test to verify it fails**。
- [ ] **Step 3: Write minimal implementation**：使用独立的配置路径 JSON 文件，原子写入，不保存 Prompt/Token。
- [ ] **Step 4: Run test to verify it passes**。
- [ ] **Step 5: Commit**：提交缓存策略。

### Task 5: 实现 Router、Manual Pin 与 Audit 摘要

**Files:**
- Create: `lib/orchestrator/routing/router.js`
- Create: `lib/orchestrator/routing/audit.js`
- Test: `lib/orchestrator/routing/router.test.js`
- Test: `lib/orchestrator/routing/audit.test.js`

- [ ] **Step 1: Write the failing tests**：覆盖复杂度、失败升级、成功降级、Manual Pin、scope/safety 不越界和安全审计字段。
- [ ] **Step 2: Run tests to verify they fail**。
- [ ] **Step 3: Write minimal implementation**：输出 `{enabled, routeRequest, resolvedProfile, action, reasonCode}`，审计只保存摘要和 fingerprint。
- [ ] **Step 4: Run tests to verify they pass**。
- [ ] **Step 5: Commit**：提交 Router 与 Audit。

### Task 6: 接入 WorkflowStore、Auto Loop 与 Run Receipt

**Files:**
- Modify: `lib/orchestrator/workflow-store.js`
- Modify: `lib/orchestrator/auto-loop.js`
- Modify: `lib/orchestrator/run-receipt.js`
- Modify: `lib/orchestrator/auto-loop.test.js`
- Modify: `lib/orchestrator/workflow-store.test.js`
- Modify: `lib/orchestrator/run-receipt.test.js`

- [ ] **Step 1: Write the failing tests**：覆盖路由关闭时基础 Auto 不变、路由成功后才 dispatch、Apply/Verify 失败暂停、routing summary 出现在 receipt、Manual Pin 保持。
- [ ] **Step 2: Run tests to verify they fail**。
- [ ] **Step 3: Write minimal implementation**：在现有 Auto Loop 的 dispatch 前调用 Routing Runtime；不重写 FSM/WAL/Verified Dispatch。
- [ ] **Step 4: Run tests to verify they pass**。
- [ ] **Step 5: Commit**：提交 Auto 集成。

### Task 7: 接入运行时与 HTTP API

**Files:**
- Modify: `lib/orchestrator/runtime.js`
- Modify: `lib/orchestrator/api.js`
- Modify: `lib/orchestrator/http.js`
- Modify: `server.js`
- Test: `lib/orchestrator/runtime.test.js`
- Test: `lib/orchestrator/http.test.js`

- [ ] **Step 1: Write the failing tests**：覆盖 Catalog 状态、路由配置读取/保存、只支持 Codex、路由不可用时 Auto API 仍可用。
- [ ] **Step 2: Run tests to verify they fail**。
- [ ] **Step 3: Write minimal implementation**：通过依赖注入连接 App Server Client；API 不返回 Prompt、Token 或内部 transport 细节。
- [ ] **Step 4: Run tests to verify they pass**。
- [ ] **Step 5: Commit**：提交 runtime/API 集成。

### Task 8: 增加 Settings 与 AutoPilot Detail Routing UI

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/ai-monitor-contract.test.js`

- [ ] **Step 1: Write the failing test**：覆盖路由开关、预设、Manual Pin、当前 Model/Reasoning/理由展示与敏感字段不展示。
- [ ] **Step 2: Run test to verify it fails**。
- [ ] **Step 3: Write minimal implementation**：复用现有 Settings Hub 与 AI monitor，不新增第二套状态源。
- [ ] **Step 4: Run test to verify it passes**。
- [ ] **Step 5: Commit**：提交 Routing UI。

### Task 9: Codex POC 与全量验证

**Files:**
- Create: `lib/orchestrator/routing/poc.test.js`
- Modify: `docs/superpowers/specs/2026-08-30-intelligent-routing-design.md`

- [ ] **Step 1: Write the failing POC tests**：Native `model/list` → supported reasoning → profile apply → exact readback → Verified Dispatch；并覆盖 cache fallback、drift、Manual Pin、crash/reconcile。
- [ ] **Step 2: Run POC tests to verify they fail**。
- [ ] **Step 3: Implement only missing POC wiring**：不得绕过 Policy Gate 或 Verified Dispatch。
- [ ] **Step 4: Run POC, Slice 0–3 and full tests**：`node --test` 必须全绿。
- [ ] **Step 5: Commit**：提交 POC 与文档更新。

### Task 10: Final verification

- [ ] Run `git diff --check`。
- [ ] Run `node --check` on every changed JavaScript file.
- [ ] Run `node --test`。
- [ ] Run `git status --short --branch` and verify only pre-existing `dist-*` directories remain untracked。
- [ ] Run `git log -12 --oneline --decorate` and report commits without pushing or deploying。
