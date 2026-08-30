# Slice 3 Single Session Auto 设计

## 目标

在 Slice 2 Suggest Mode 的数据模型上增加一个单 Session Auto Loop：每次只产生并发送一个经过验证的 Turn，等待 Worker 的完成/证据，再由 Supervisor 决定继续、暂停、阻塞或完成。所有无法证明安全的动作都 Fail Closed。

## 复用与边界

- 复用 `WorkflowStore` 的 JSON 原子保存、事件流、Run Contract 和显式 Evidence。
- 复用 `lib/verified-dispatch.js` 的 Session 双重验证、草稿验证、单次 SEND 和 Delivery Verification。
- Auto 只允许有 `binding.sessionRef` 的单 Session 工作流；不从项目目录猜测 Session。
- Auto 不调用未经验证的 `HeadlessTransport`。当前只通过注入的 Verified Dispatch capability 执行；能力缺失时进入 `PAUSED`/`BLOCKED`。
- Supervisor 使用确定性的结构化决策器，不保存完整 Prompt/Conversation，不引入第二套模型 Runtime。
- 保持旧 `status` 字段兼容，同时新增持久化 `autoState` 作为 FSM 真值。

## FSM

状态固定为：

```text
OFF → PREFLIGHT → WAITING_AGENT → REVIEWING → DISPATCHING → VERIFYING
                         ↑              ↓             ↓
                         └──────────────┴─────────────┘

任何阶段 → PAUSED / BLOCKED / DONE / STOPPED
```

- `OFF`：未启动；`PREFLIGHT`：机械 Gate；`WAITING_AGENT`：等待 Worker 产生新状态。
- `REVIEWING`：读取显式 Evidence 并生成结构化 Supervisor Decision。
- `DISPATCHING`：锁定单 Agent/Session，调用 Verified Dispatch。
- `VERIFYING`：确认送达/Worker 状态；成功后回到 `WAITING_AGENT`。
- `PAUSED` 可由 Human Override、身份/送达不确定、权限请求或策略失败触发。
- `BLOCKED` 用于预算、停滞、重复指令、能力缺失等不可继续状态。
- `DONE` 只允许所有 DoD 有明确 `passed` Evidence；`STOPPED` 只允许用户停止。

旧 `status` 映射为：`draft/queued/running/waiting_user/verifying/completed/failed/paused`，不删除旧字段。

## Policy Gate

Dispatch 前按固定顺序检查：

1. Auto mode、Run Contract、Scope、Budget 有效。
2. `binding.sessionRef`、agent、project 三者一致且 session identity 可验证。
3. Verified Dispatch capability 完整。
4. 当前 control owner 不是 human，且没有有效的其他项目租约。
5. 没有 permission/approval/danger 信号。
6. 指令 fingerprint 不等于最近一次未完成指令。
7. 当前迭代、运行时、失败、停滞和 Dispatch 次数未超 Watchdog。

任一检查失败都不发送消息。

## WAL 与对账

每次 Dispatch 先追加 `pending` WAL 记录，再进入 Verified Dispatch；记录包含 workflow/session、attempt、instruction fingerprint、phase 和 `sendAttempted`。成功后追加 `committed`，发送异常或进程重启发现 pending 时追加 `reconcile_required`。

恢复规则：

- `sendAttempted=false`：可回到 `PAUSED`，不得依据旧指令自动重发。
- `sendAttempted=true`：只调用 Delivery Verification 查询结果；`verified` → `WAITING_AGENT`，否则 → `PAUSED`。
- 永不因 Crash 或超时自动再次 SEND。

## Supervisor 与 Receipt

Supervisor 输出仅包含结构化字段：`decision`、`reasonCode`、`summary`、DoD checks、progress、turnContract、riskLevel、scopeCheck。指令由受控 Renderer 生成，不接受 Shell/URL/transport 等字段。

每次 Auto Run 结束生成 `runReceipt`，仅保存 goal 摘要、轮次、DoD 计数、状态、停止原因、Dispatch/失败/停滞计数、阶段证据和安全的 Supervisor 摘要；不保存完整 Prompt、Conversation、Secret 或 API Key。

## API/UI

- 创建请求支持 `autopilotMode:auto` 与可选 `binding.sessionRef`。
- `POST /run` 只对 Auto 启动异步 Loop；Suggest 继续返回 `SUGGEST_ONLY`。
- `POST /reconcile` 执行一次恢复/状态检查；`POST /evidence` 只接受显式 DoD evidence；`POST /stop` 进入 STOPPED。
- 人工 takeover 立即 PAUSED；Resume 重新读取状态并重新 Gate，不复用旧指令。
- AI Monitor 显示 Suggest/Auto、FSM、DoD、轮次、当前建议与 Receipt；Auto 没有“强制发送”旁路。

## 不做

- 不实现 Slice 3.5 模型发现、模型切换、Reasoning、路由或 Routing UI。
- 不支持跨 Session/Project Auto，不自动创建 Worktree，不自动批准权限。
- 不自动重发 SEND，不从 stdout/stderr 推断 DoD，不把 headless CLI 当作 Verified Dispatch。
