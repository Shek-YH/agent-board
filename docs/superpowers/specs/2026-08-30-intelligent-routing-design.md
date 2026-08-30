# Intelligent Execution Routing 设计

## 目标

在不改变 Slice 0–3 的 Verified Dispatch 与安全边界的前提下，为 Codex 单 Session Auto Loop 增加可验证的模型与 reasoning 路由。路由只决定当前 Turn 的 Execution Profile；无法读取、应用或验证 Profile 时，基础 AutoPilot 继续可用，路由本身必须降级或暂停。

## 现状与选型

- Agent Board 已有 `lib/adapters/codex.js`、Session Topology、Codex UIA、Verified Dispatch 和 Auto Loop。
- 当前没有 Model Catalog、Model Selector、Reasoning Selector、Profile Apply/Verify 能力。
- 本机 Codex App Server 的真实 Catalog 入口是 `model/list`；本机缓存是 `C:\Users\Administrator\.codex\models_cache.json`。
- 首期只做 Codex。Core 只依赖能力接口，不把 Codex 特有协议散落到 Supervisor 或 Auto Loop。
- Native 优先：通过注入的 App Server Client 读取 Catalog、执行每 Turn Profile；UIA 只作为明确的受控 fallback。
- 不修改全局 `config.toml`，不通过 Prompt 伪装切换模型，不自动批准权限，不自动重发 SEND。

## 数据流

```text
Progress / Supervisor Decision
        ↓
Routing Policy（C0-C3 / T0-T3 / P0-P2）
        ↓
Catalog Reader（Native → Cache）
        ↓
Profile Resolver（Agent-specific）
        ↓
Profile Applier（Native → UIA fallback）
        ↓
Profile Verifier（model + reasoning exact readback）
        ↓
Policy Gate → Verified Dispatch
```

路由失败不改变基础 Auto Loop 的可运行性：若没有路由能力，保持当前模型继续执行；若明确尝试切换但 Apply/Verify 失败，记录审计并暂停该次自动发送。

## 模块边界

- `lib/orchestrator/routing/catalog.js`：Catalog 规范化、合法模型/reasoning 查询、缓存元数据；不执行网络或桌面操作。
- `lib/orchestrator/routing/profile.js`：C/T/P 到 Execution Profile 的纯解析与最近合法 reasoning 映射。
- `lib/orchestrator/routing/router.js`：按进度、失败历史、人工 pin 和策略生成路由决策；不发送消息。
- `lib/orchestrator/routing/codex-app-server.js`：对 App Server Client 的最小能力契约，保留 Native 传输的注入边界。
- `lib/orchestrator/routing/profile-runtime.js`：Apply/Verify 编排，Native 优先，UIA fallback 必须显式提供且可验证。
- `lib/orchestrator/routing/audit.js`：只保存安全路由摘要，不保存 Prompt 或 Chain of Thought。
- `WorkflowStore`：扩展现有 JSON 持久化记录，不创建第二套 Store。

## Profile 规则

- C0：优先低成本/低 reasoning 的可用模型。
- C1：平衡模型与 medium reasoning。
- C2：强模型与 high reasoning。
- C3：最强可用模型与最高合法 reasoning。
- T0–T3 用于 reasoning 目标；最终值必须从当前模型的 supported levels 解析。
- P0–P2 只影响安全/上下文策略摘要，不授予额外 Scope 或权限。
- 连续失败、Regression、Stagnation 只允许升级；成功且任务简化时允许降级。
- Manual Model/Reasoning Pin 始终优先，自动路由不得覆盖。

## 验证与恢复

- Catalog Native 失败时尝试缓存；缓存也不可用时只返回 `routing_unavailable`，基础 Auto 仍执行。
- 目标模型不存在时不选择；reasoning 不支持时选择最近合法值并记录 fallback reason。
- Apply 后必须再次读取当前 Session 的实际 model/reasoning；无法精确证明则 `PROFILE_APPLY_FAILED`，不进入 SEND。
- Apply 中途崩溃、Session drift、Manual Pin 变化统一走 Reconciliation/人工处理，不重发。
- Catalog 按 `source/fetchedAt/agentVersion/etag` 记录；Agent 版本变化使缓存失效。

## UI

设置页新增“AI 智能执行调度”：启用开关、质量优先/平衡/节省额度/自定义预设、手动模型与 reasoning 锁定、路由信息显示开关。默认关闭智能路由，关闭时完全保持 Slice 3 行为。

## POC 验收

必须覆盖：Native `model/list`、缓存 fallback、无 Catalog 基线运行、模型与 reasoning 选择/降级、C0–C3、升级/降级、Manual Pin、Apply/Verify 失败、Catalog drift、Crash/Reconciliation，以及 Codex 的“读取列表 → 解析 reasoning → Apply → Verify → Verified Dispatch”链路。
