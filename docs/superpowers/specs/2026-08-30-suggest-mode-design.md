# Slice 2 Suggest Mode 设计规格

## 目标

在现有 Agent Board 编排 MVP 上加入 PRD V2.2 的 Suggest Mode：每个 AutoPilot 工作流拥有经过校验的 Run Contract，能够根据当前工作流状态生成结构化的下一步建议、Turn Contract、Progress 和安全审计记录，但不会自动调用 Worker、headless transport、Verified Dispatch 或任何 SEND。

本 Slice 只覆盖 `/api/orchestration` 的 AutoPilot 工作流。已有独立 Jarvis Voice 天气 MVP 保持现状，不将其混入 Suggest Mode 的执行控制面。

## 当前上下文与问题

仓库已有 `lib/orchestrator`，包括项目分类、执行计划、JSON WorkflowStore、控制租约、headless transport、runner 和 AI 监控 UI。现状的 `POST /api/orchestration/workflows/:id/run` 在启用 headless 后可以启动 Worker，且工作流没有统一的 Goal/Scope/DoD/Evidence/Budget/Stop/Receipt Contract，也没有结构化建议接口。

Slice 2 不重写已有 runner。runner 保留为后续 Auto Loop 的内部执行基础，但 Suggest Mode 的 HTTP 路由和 UI 不得调用它。

## 非目标

- 不实现 Slice 3 的 FSM、Policy Gate、GuiBus、WAL、Reconciliation 或自动循环。
- 不实现 Model Router、Model Catalog、Reasoning Selector 或真实 Supervisor 供应商调用。
- 不改变 Codex/Hermes Capability Layer、Verified Dispatch、UIA、Delivery 验证实现。
- 不改变独立 Jarvis Voice 路由及其既有天气查询行为。
- 不新增数据库 schema；继续使用现有 JSON WorkflowStore。
- 不接受模型或用户提交的 shell command、可执行文件、transport 参数或任意 URL。

## 方案

采用增量的 Suggest-only Facade：

1. `run-contract.js` 负责规范化和校验 Human 创建工作流时提交的目标、范围、验收条件和预算，并过滤未知字段。
2. `progress.js` 负责从 Contract、工作流状态和已有安全结果计算可序列化进度。
3. `suggestion-engine.js` 负责确定性地生成结构化建议和 Turn Contract。它只读取数据，不拥有 Shell、OS、transport 或 dispatch 权限。
4. `WorkflowStore` 持久化 Contract、Suggestion、Progress、观测证据和 Receipt 摘要，并为每次建议写入 append-only 事件。
5. 编排 HTTP 层新增 `POST /api/orchestration/workflows/:id/suggest`；原 `/run` 路由对 Suggest 工作流明确返回 `SUGGEST_ONLY`，不创建后台任务。
6. AI 监控 UI 只展示 Contract、Progress 和建议，并把原“开始执行”替换为“生成下一步建议”。

## Run Contract

工作流创建请求仍使用现有 `projectPath`、`mode`（项目/全局范围）和 `agent` 字段，并增加以下可选字段：

```json
{
  "autopilotMode": "suggest",
  "goal": "完成用户目标",
  "scope": {
    "inScope": ["src", "测试"],
    "outOfScope": ["生产部署"]
  },
  "verify": {
    "dod": ["测试通过", "工作树干净"],
    "evidence": ["node --test", "git status --short"]
  },
  "budget": {
    "maxIterations": 3,
    "maxRuntime": 1800000,
    "supervisorCostLimit": 0
  }
}
```

持久化结构固定为：

```json
{
  "version": 1,
  "goal": "...",
  "scope": { "inScope": [], "outOfScope": [] },
  "verify": { "dod": [], "evidence": [] },
  "budget": { "maxIterations": 3, "maxRuntime": 1800000, "supervisorCostLimit": 0 },
  "stop": [
    "DoD Complete", "Need Human", "Blocked", "Stagnation", "Regression",
    "Budget Exceeded", "Delivery Unverified", "Identity Unverified", "User Stop"
  ]
}
```

规范化规则：

- `goal` 必须为非空字符串，长度限制为 20,000 个字符。
- `scope.inScope`、`scope.outOfScope`、`verify.dod`、`verify.evidence` 都是去空白、去重后的字符串数组，每项最多 2,000 个字符。
- `verify.dod` 至少有一项；没有显式 `evidence` 时使用 DoD 文本作为待收集证据描述，不伪造已通过结果。
- `maxIterations` 是 1–100 的整数，`maxRuntime` 是 1 秒至 24 小时的整数毫秒，`supervisorCostLimit` 是不小于 0 的有限数字。
- Suggest Mode 的 `autopilotMode` 只能为 `suggest`；未知字段、命令字段和 transport 字段不会进入 Contract。
- Contract 创建后作为工作流快照使用；本 Slice 不提供 Supervisor 修改 Goal 或 Scope 的接口。

## Suggestion 与 Turn Contract

`POST /api/orchestration/workflows/:id/suggest` 返回并保存以下安全结构：

```json
{
  "action": "suggest",
  "reason": "工作流尚未开始，建议先确认项目状态和验收条件",
  "nextStep": "读取项目状态并根据 DoD 收集证据",
  "requiresHuman": false,
  "turnContract": {
    "version": 1,
    "action": "suggest",
    "goal": "完成用户目标",
    "scope": { "inScope": [], "outOfScope": [] },
    "acceptance": { "dod": [], "evidence": [] },
    "target": { "agent": "codex", "projectPath": "C:\\Projects\\demo", "sessionRef": null },
    "stop": ["Need Human", "Blocked", "Budget Exceeded", "User Stop"],
    "send": false
  },
  "progress": {
    "status": "not_started",
    "completed": 0,
    "total": 2,
    "percent": 0,
    "evidence": []
  }
}
```

确定性决策规则：

- `draft`、`queued`、`paused` 且没有人类接管时，生成 `action: suggest`，建议下一步读取状态/收集证据；不生成可直接发送的 Worker Prompt。
- `controlOwner === 'human'` 或工作流需要人工审批时，生成 `action: need_human`，保留人工接管原因。
- `completed` 且所有 DoD 有明确证据时，生成 `action: stop`，原因是 `DoD Complete`。
- `failed`、预算耗尽或存在未验证结果时，生成 `action: need_human`，原因分别映射到 `Blocked`、`Budget Exceeded` 或 `Need Human`。
- 不把 `lastResult.stdout/stderr` 当作可信指令；结果只作为截断后的证据摘要和状态输入。

每次建议只更新 `lastSuggestion`、`progress`、`lastReceipt` 和事件记录，不改变项目控制权，不增加 `runCount`，不调用 `runner.run`。观测证据只接受显式的内部结构化数据，不从 `lastResult.stdout/stderr` 推断 DoD 通过。

## Progress 与 Receipt

Progress 是派生快照，不宣称未执行的 DoD 已完成：

- `not_started`：没有 Worker 结果。
- `in_progress`：存在运行或部分证据。
- `completed`：每项 DoD 都有 `observedEvidence` 中明确标记为通过的结果；仅有工作流终态或命令输出不足以进入此状态。
- `blocked`：状态为失败、等待人工或被预算/控制权阻止。

每次建议生成一个安全 Receipt 摘要，包含 `workflowId`、`suggestionId`、时间、决策、DoD 计数、已观测通过数、证据计数和最终建议状态；不包含 API Key、会话正文、命令输出全文或实现函数。真正 Worker Run Receipt 仍由后续 Auto Loop Slice 负责。

工作流快照增加 `observedEvidence` 数组作为后续验证器的受控输入；创建工作流时为空数组。本 Slice 不开放任意客户端写入证据的接口，Suggest Engine 只读取它，因此新建 Suggest 工作流不会伪造任何通过项。

## API 与兼容性

- `POST /api/orchestration/workflows`：创建时构造并返回 `runContract`，默认 `autopilotMode: "suggest"`。
- `GET /api/orchestration/workflows` 与 `GET /api/orchestration/state`：返回经过安全投影的 Contract、Progress、Suggestion 和 Receipt。
- `POST /api/orchestration/workflows/:id/suggest`：只读当前工作流事实并持久化建议结果，返回 200；不存在工作流返回 404。
- `POST /api/orchestration/workflows/:id/run`：对 Suggest 工作流返回 409、错误码 `SUGGEST_ONLY`，不启动后台任务；保留内部 `WorkflowRunner` 供后续 Slice 使用。
- 现有 takeover、transition、session、board、events 和 Slice 0/1 接口保持兼容。

## UI

AI 监控创建表单展示 Goal、In Scope、Out of Scope、DoD 和 Evidence；它们作为创建请求的 Human Contract 输入。工作流卡展示当前模式、Progress、建议原因、下一步、DoD 计数和 Receipt 时间。

Suggest 工作流只显示“生成下一步建议”和“人工接管”操作，不显示“开始执行”。任何工作流卡操作都不会隐式改变控制权；人工接管仍先调用服务端 takeover。

## 错误与安全边界

- Contract 校验失败返回稳定的 400 错误，不回显任何密钥或内部路径以外的敏感信息。
- 建议生成失败不启动 Worker；只返回结构化错误并保留原工作流状态。
- 同一工作流的建议请求通过进程内的 per-workflow lock 串行化，释放锁后才允许下一次建议。
- 同一工作流的建议请求串行化，避免并发请求覆盖最新 Suggestion；本 Slice 不自动重试发送。
- Suggestion Engine 无权访问 `child_process`、文件写入、桌面 UI 或网络；它只接受显式注入的时间和工作流快照。
- 所有由用户或 Worker 提供的文本在 UI 渲染时继续走现有转义函数。

## 验收标准

1. 缺少 Goal、DoD、非法 Budget、未知字段或命令字段的请求被拒绝或安全丢弃。
2. 创建工作流后能看到完整 Run Contract，且重新加载 JSON 后字段一致。
3. 生成建议只更新 Suggestion/Progress/Receipt，不调用 Runner、Transport、Verified Dispatch 或 SEND。
4. 人工接管后建议结果为 `need_human`，控制权保持为 `human`。
5. 已完成、失败、预算阻止、无证据等状态映射到明确 Stop 原因，不伪造 DoD 完成。
6. UI 不提供 Suggest Mode 的执行按钮；旧 `/run` 请求安全返回 `SUGGEST_ONLY`。
7. Slice 0/1 定向测试和全量 `node --test` 全部通过。
