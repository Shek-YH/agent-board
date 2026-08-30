# Verified Dispatch Slice 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

## Goal

在 Windows 桌面环境完成 PRD V2.2 Slice 0：对两个真实 GUI Agent 实现一次性、可验证的
`Resolve → Verify → Write → Draft Verify → Send → Delivery Verify`。

本 Slice 选择 Codex Desktop 与 Hermes Desktop 作为 POC 正向路径；Claude Code 不进入测试，
WorkBuddy/ZCode 在当前 UIA 证据不足时只允许 Suggest/安全降级。Slice 0 不实现 Supervisor、
Model Router、Model Discovery、Settings、完整数据库或 Worktree。

## Architecture and Reuse

- 保留 `lib/session-topology.js` 的严格主会话解析，不以 PID/HWND 作为唯一身份。
- 复用 `store.resolveSessionControlTarget()`、Codex/Hermes 现有读取器、
  `lib/codex-deep-link.js`、`lib/hermes-deep-link.js` 和 `server.js` 现有激活辅助逻辑。
- 新增一个 fail-closed 的 Verified Dispatch 编排器；UIA 写入器和送达证据读取器按 Agent
  分离，测试通过依赖注入隔离 Windows UIA 与真实文件/数据库。
- `SEND` 后禁止自动重试；崩溃或超时只进入 reconciliation，不再次发送。

## Implementation Tasks

### Task 1: Define the verified-dispatch contract and safety state machine

**Files:** `lib/verified-dispatch.js`, `lib/verified-dispatch.test.js`

先写 `node:test` 覆盖：无会话、子会话、候选歧义、身份漂移、已有用户草稿、空消息、发送后
无送达证据、重复调用和 `SEND` 后禁止重试。再实现一个纯编排层，明确记录
`PREPARE/LOCK/RESOLVE_SESSION/VERIFY_SESSION/ACTIVATE/RE_VERIFY_SESSION/WRITE/VERIFY_DRAFT/
SEND/VERIFY_DELIVERY/COMMIT`，任何前置验证失败都不调用 writer；`SEND` 后只返回待 reconciliation
状态，不循环重发。

```js
const result = await dispatchVerifiedMessage(request, {
  resolveSession,
  activateSession,
  verifySession,
  writer,
  verifyDraft,
  verifyDelivery,
});
```

### Task 2: Add Codex Desktop UIA writing and draft verification

**Files:** `lib/codex-desktop-uia.js`, `lib/codex-desktop-uia.test.js`

以现有 Codex 桌面焦点/启动逻辑为基础，定位已解析会话后只操作名为 `随心输入`、
`ControlType.Edit`、Chromium `ProseMirror` 的编辑框。优先使用 UIA ValuePattern 写入并读回
校验；无法确认唯一控件、控件不可写、读回不一致、用户已存在草稿或焦点丢失时返回失败。
Enter 只能由编排器在 Draft Verify 成功后调用一次。测试使用假的 PowerShell/UIA bridge，
覆盖唯一控件、不可访问、读回漂移、用户草稿保护和写入异常。

### Task 3: Add Hermes Desktop UIA writing and draft verification

**Files:** `lib/hermes-desktop-uia.js`, `lib/hermes-desktop-uia.test.js`

对 Hermes 的 `ControlType.Edit` 消息编辑框执行同样的 fail-closed 流程；不能仅凭窗口句柄
或当前焦点认定会话正确。复用现有 Hermes deep link/窗口激活入口，UIA bridge 通过依赖注入
测试。不得使用剪贴板作为默认写入路径；若不得不使用降级路径，必须把 IME/剪贴板不确定性
报告为不可发送，而不是静默继续。

### Task 4: Implement scoped Codex and Hermes delivery evidence

**Files:** `lib/codex-delivery.js`, `lib/codex-delivery.test.js`,
`lib/hermes-delivery.js`, `lib/hermes-delivery.test.js`

Codex 从发送前快照开始，读取目标 session JSONL 中发送后的新 user row，并校验 session ID、
规范化消息文本和时间边界；Hermes 只读 `state.db`，校验目标 session、发送后的新 user
message、文本和时间边界。旧消息、其他会话、assistant 回声、tool/delegation 记录和 schema
异常均不得算送达。数据库/文件读取失败返回 `unknown`，不触发重发。

### Task 5: Connect session resolve, activation and re-verification

**Files:** `lib/verified-dispatch.js` (extend), `server.js`, targeted tests

在写入前再次调用严格 session resolver，并通过 deep link/现有 activation helper 激活目标。
激活后必须重新读取并验证 Strong Session Anchor；如果桌面端无法证明当前会话，直接
Suggest/失败。锁按 session+agent 串行化，避免两个发送同时污染同一编辑框；锁释放必须在
`finally` 中完成。

### Task 6: Expose one minimal verified-dispatch API route

**Files:** `server.js`, `server-verified-dispatch.test.js`

新增 Slice 0 所需的最小接口，接受显式 agent/project/sessionRef/message，拒绝缺少强身份锚点的
请求，返回阶段、证据、失败原因和是否需要 reconciliation。接口不提供自动重试，不加入模型或
推理参数，不把 worker 输出当作可信指令。

### Task 7: Verify in layers, then perform real disposable-agent tests

**Files:** targeted tests and `docs/verification/verified-dispatch-slice-0.md`

先运行相关 `node --test`，再运行全量 `node --test`。只有自动化测试通过后，使用真实运行中的
Codex Desktop 与 Hermes Desktop 各创建/选择一次可丢弃的测试会话，发送无副作用测试文本，
检查 UI 草稿、真实 user message 和 delivery evidence；不使用 Claude Code。若需要真实 LLM
生成响应，才读取项目 `.env` 中的百炼密钥并选择百炼模型；纯 UI dispatch 验证不额外调用 LLM。
真实测试不得输出或提交 API key。

## Verification Commands

```powershell
cd C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10\agent-board
node --test lib/verified-dispatch.test.js lib/codex-desktop-uia.test.js lib/hermes-desktop-uia.test.js lib/codex-delivery.test.js lib/hermes-delivery.test.js server-verified-dispatch.test.js
node --test
```

真实测试必须在前置自动化测试通过、用户确认 Slice 0 方案且两个桌面 Agent 可安全使用时执行；
真实发送失败时记录证据并停止，不自动重发。

## Risks and Mitigations

- UIA 控件树变化：唯一控件、控件类型、读回和会话锚点均需验证，失败即降级。
- Clipboard/IME/中文/emoji/代码块/换行：默认不走剪贴板，写入后必须读回原文。
- TOCTOU：写前重解析、激活后重验证、发送后按快照范围查证。
- 进程崩溃或网络延迟：只做 reconciliation，不把不确定状态当失败重发。
- 旧分支实现与当前分支差异很大：只提取可复用思路，不整体合并
  `feature/autopilot-slice-0`。
