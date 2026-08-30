# Slice 2 Suggest Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Agent Board 编排基础上实现 PRD V2.2 的 Suggest Mode：创建带 Run Contract 的工作流，生成结构化建议、Progress、Turn Contract 和 Receipt，且任何 Suggest 路径都不会调用 Worker 或发送消息。

**Architecture:** 采用纯数据层 `run-contract.js`、`progress.js` 和 `suggestion-engine.js`，由 `WorkflowStore` 持久化安全快照，由编排 HTTP 层提供 Suggest API。现有 `WorkflowRunner` 和 `HeadlessTransport` 保留给后续 Auto Loop，但所有 Suggest 工作流的 `/run` 请求明确拒绝；AI 监控 UI 只展示和生成建议。

**Tech Stack:** Node.js CommonJS、Node 内置 `node:test`、现有 JSON WorkflowStore、现有 HTTP/SSE 编排接口、原生 HTML/CSS/JavaScript；不引入第三方依赖，不调用真实 Supervisor API。

---

## 文件边界

- Create: `lib/orchestrator/run-contract.js` — 校验并冻结 Goal、Scope、DoD、Evidence、Budget、Stop Contract。
- Create: `lib/orchestrator/run-contract.test.js` — Contract 合法性、边界、未知字段和命令字段测试。
- Create: `lib/orchestrator/progress.js` — 从工作流快照和显式观测证据派生进度。
- Create: `lib/orchestrator/progress.test.js` — 进度状态、DoD 计数和预算/证据边界测试。
- Create: `lib/orchestrator/suggestion-engine.js` — 无副作用的 Suggestion、Turn Contract 和 Receipt 生成器，以及按工作流串行化的持久化服务。
- Create: `lib/orchestrator/suggestion-engine.test.js` — 建议决策矩阵和“不发送”边界测试。
- Modify: `lib/orchestrator/workflow-store.js` — 保存 Suggest Contract、观测证据、Progress、Suggestion 和 Receipt，并为旧快照提供安全默认值。
- Modify: `lib/orchestrator/workflow-store.test.js` — 验证新字段持久化和旧快照迁移。
- Modify: `lib/orchestrator/api.js` — 创建请求接收并校验 Run Contract。
- Modify: `lib/orchestrator/api.test.js` — 覆盖 Contract 输入、未知字段过滤和缺少 DoD 拒绝。
- Modify: `lib/orchestrator/runtime.js` — 注入 Suggestion Service。
- Modify: `lib/orchestrator/http.js` — 增加 Suggest API，并阻断 Suggest 工作流的 `/run`。
- Modify: `lib/orchestrator/http.test.js` — 覆盖 Suggest API、`SUGGEST_ONLY` 和 runner 不被调用。
- Modify: `lib/jarvis-voice.js`、`lib/jarvis-voice.test.js` — 为保持独立 Voice MVP，补齐其内部工作流的最小 DoD Contract，不改变其执行行为。
- Modify: `public/index.html` — 增加 Scope、DoD、Evidence 输入，并去除 Suggest 模式的执行按钮。
- Modify: `public/app.js` — 创建 Contract、展示 Suggestion/Progress/Receipt、调用 Suggest API。
- Modify: `public/ai-monitor-contract.test.js` — 验证 UI 只显示建议入口，不出现 Suggest 执行入口。
- Modify: `lib/orchestrator/runner.test.js`、其他现有编排测试 — 补齐显式 DoD 输入，保持 runner 单元测试独立。

不修改：Slice 0/1 Capability Layer、Verified Dispatch、Codex/Hermes UIA/Delivery、数据库 schema、Model Router。

## Task 1: 以 TDD 实现 Run Contract

**Files:**

- Create: `lib/orchestrator/run-contract.test.js`
- Create: `lib/orchestrator/run-contract.js`

- [ ] **Step 1: 编写失败测试**

测试必须覆盖：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeRunContract } = require('./run-contract');

const valid = {
  autopilotMode: 'suggest',
  goal: '完成登录模块',
  scope: { inScope: ['src'], outOfScope: ['部署'] },
  verify: { dod: ['测试通过'], evidence: ['node --test'] },
  budget: { maxIterations: 3, maxRuntime: 60_000, supervisorCostLimit: 0 },
  command: 'rm -rf /',
};

test('normalizes a safe suggest contract and drops command fields', () => {
  const contract = normalizeRunContract(valid);
  assert.equal(contract.version, 1);
  assert.equal(contract.autopilotMode, 'suggest');
  assert.deepEqual(contract.verify.dod, ['测试通过']);
  assert.equal('command' in contract, false);
  assert.equal(Object.isFrozen(contract), true);
});

test('rejects empty goal, missing DoD, unsupported mode, and invalid budget', () => {
  assert.throws(() => normalizeRunContract({ ...valid, goal: '' }), /goal/);
  assert.throws(() => normalizeRunContract({ ...valid, verify: { evidence: ['x'] } }), /DoD/);
  assert.throws(() => normalizeRunContract({ ...valid, autopilotMode: 'auto' }), /suggest/);
  assert.throws(() => normalizeRunContract({ ...valid, budget: { maxIterations: 0 } }), /maxIterations/);
});

test('deduplicates and trims lists without retaining mutable input', () => {
  const input = { ...valid, scope: { inScope: [' src ', 'src'], outOfScope: [] } };
  const contract = normalizeRunContract(input);
  input.scope.inScope[0] = 'tampered';
  assert.deepEqual(contract.scope.inScope, ['src']);
});
```

- [ ] **Step 2: 运行失败测试**

运行：

```powershell
node --test lib/orchestrator/run-contract.test.js
```

预期：因 `./run-contract` 不存在而失败；不要在此步骤修改其他模块。

- [ ] **Step 3: 实现最小 Contract**

`normalizeRunContract(input)` 必须：

- 固定 `version: 1`、`autopilotMode: 'suggest'` 和完整 Stop 列表。
- `goal` 必须是去空白后 1–20,000 字符的字符串。
- `scope.inScope`、`scope.outOfScope`、`verify.dod`、`verify.evidence` 是去空白、去重后的字符串数组，每项 1–2,000 字符；`verify.dod` 至少一项。
- Evidence 未提供时复制 DoD 文本作为待收集描述，不标记为已通过。
- Budget 默认 `{ maxIterations: 3, maxRuntime: 1_800_000, supervisorCostLimit: 0 }`；分别限制为 1–100、1,000–86,400,000 毫秒和不小于 0 的有限数字。
- 只构造白名单字段，永远不保留 `command`、`shell`、`transport`、`args`、`url` 或任意未知字段。
- 返回深度冻结的独立对象，不冻结调用方传入的实现对象，因为本模块不接收实现对象。

导出 `STOP_REASONS`、`DEFAULT_BUDGET` 和 `normalizeRunContract`。

- [ ] **Step 4: 运行 Contract 测试**

运行：

```powershell
node --test lib/orchestrator/run-contract.test.js
git diff --check
```

预期：全部测试通过。

- [ ] **Step 5: 提交 Contract 层**

```powershell
git add -- lib/orchestrator/run-contract.js lib/orchestrator/run-contract.test.js
git commit -m "feat: add suggest mode run contract"
```

## Task 2: 实现 Progress 派生器

**Files:**

- Create: `lib/orchestrator/progress.test.js`
- Create: `lib/orchestrator/progress.js`

- [ ] **Step 1: 编写失败测试**

使用以下显式观测证据形状：`{ dodIndex, passed, summary, source }`。测试：新工作流为 `not_started`；部分通过为 `in_progress`；全部 DoD 明确通过为 `completed`；失败、等待人工或预算超限为 `blocked`；只有 stdout 没有 observed evidence 时不能完成。

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateProgress } = require('./progress');
const { normalizeRunContract } = require('./run-contract');

const contract = normalizeRunContract({
  goal: '完成目标', verify: { dod: ['测试通过', '检查完成'], evidence: ['测试结果'] },
});

function workflow(fields = {}) {
  return {
    id: 'wf-1', status: 'draft', controlOwner: null, runCount: 0,
    createdAt: 1_000, runContract: contract, lastResult: null,
    observedEvidence: [], ...fields,
  };
}

test('starts without claiming any DoD evidence', () => {
  assert.deepEqual(calculateProgress({ workflow: workflow(), now: 2_000 }), {
    status: 'not_started', completed: 0, total: 2, percent: 0, evidence: [], stopReason: null,
  });
});

test('counts only explicit passed evidence and never parses stdout', () => {
  const result = calculateProgress({ workflow: workflow({
    lastResult: { stdout: '测试通过\n检查完成' },
    observedEvidence: [{ dodIndex: 0, passed: true, summary: '测试通过', source: 'test' }],
  }), now: 2_000 });
  assert.equal(result.status, 'in_progress');
  assert.equal(result.completed, 1);
});

test('marks complete only when every DoD has explicit passed evidence', () => {
  const result = calculateProgress({ workflow: workflow({
    status: 'completed',
    observedEvidence: [
      { dodIndex: 0, passed: true, summary: 'ok', source: 'test' },
      { dodIndex: 1, passed: true, summary: 'ok', source: 'git' },
    ],
  }), now: 2_000 });
  assert.equal(result.status, 'completed');
  assert.equal(result.percent, 100);
});

test('stops progress at blocked or budget exceeded states', () => {
  assert.equal(calculateProgress({ workflow: workflow({ status: 'failed' }), now: 2_000 }).stopReason, 'Blocked');
  assert.equal(calculateProgress({ workflow: workflow({ runCount: 3 }), now: 2_000 }).stopReason, 'Budget Exceeded');
});
```

- [ ] **Step 2: 运行失败测试**

```powershell
node --test lib/orchestrator/progress.test.js
```

预期：因模块不存在而失败。

- [ ] **Step 3: 实现 Progress**

`calculateProgress({ workflow, now = Date.now() })` 读取 `runContract`、`observedEvidence`、`status`、`runCount`、`createdAt` 和 `lastResult` 的存在性；不读取 stdout/stderr 内容来判断 DoD。返回固定字段：

```js
{ status, completed, total, percent, evidence, stopReason }
```

证据只保留合法 DoD 索引、布尔 passed、截断后的 summary/source；忽略非法条目。优先级为：全部 DoD 通过 → `completed`；预算或明确阻止状态 → `blocked`；有运行/结果/部分证据 → `in_progress`；否则 `not_started`。

- [ ] **Step 4: 运行测试并提交**

```powershell
node --test lib/orchestrator/progress.test.js
git diff --check
git add -- lib/orchestrator/progress.js lib/orchestrator/progress.test.js
git commit -m "feat: derive suggest progress safely"
```

## Task 3: 实现 Suggestion、Turn Contract 和 Receipt

**Files:**

- Create: `lib/orchestrator/suggestion-engine.test.js`
- Create: `lib/orchestrator/suggestion-engine.js`

- [ ] **Step 1: 编写失败测试**

测试建议矩阵：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeRunContract } = require('./run-contract');
const { buildSuggestion, createSuggestionService } = require('./suggestion-engine');

function draftContract() {
  return normalizeRunContract({ goal: '完成目标', verify: { dod: ['检查完成'] } });
}

function draftWorkflow(fields = {}) {
  return {
    id: 'wf-1', projectPath: 'C:\\Projects\\demo', agent: 'codex', status: 'draft',
    controlOwner: null, runCount: 0, createdAt: 1_000, lastResult: null,
    observedEvidence: [], runContract: draftContract(), ...fields,
  };
}

function completedWithEvidence() {
  return draftWorkflow({
    status: 'completed',
    observedEvidence: [{ dodIndex: 0, passed: true, summary: '检查完成', source: 'test' }],
  });
}

function fakeStore(initial) {
  let current = { ...initial };
  return {
    get(id) { return id === current.id ? { ...current } : null; },
    updateFields(id, fields) {
      if (id !== current.id) throw new Error('workflow not found');
      current = { ...current, ...fields };
      return { ...current };
    },
  };
}

test('suggests a read-and-verify next step without a sendable prompt', () => {
  const result = buildSuggestion({ workflow: draftWorkflow(), now: 2_000, suggestionId: 'sug-1' });
  assert.equal(result.action, 'suggest');
  assert.equal(result.requiresHuman, false);
  assert.equal(result.turnContract.send, false);
  assert.equal('prompt' in result.turnContract, false);
  assert.equal(result.receipt.suggestionId, 'sug-1');
});

test('requires human after takeover, failure, or budget exhaustion', () => {
  assert.equal(buildSuggestion({ workflow: draftWorkflow({ controlOwner: 'human' }) }).action, 'need_human');
  assert.equal(buildSuggestion({ workflow: draftWorkflow({ status: 'failed' }) }).reason, 'Blocked');
  assert.equal(buildSuggestion({ workflow: draftWorkflow({ runCount: 3 }) }).reason, 'Budget Exceeded');
});

test('stops only with explicit evidence for every DoD', () => {
  const workflow = completedWithEvidence();
  const result = buildSuggestion({ workflow, suggestionId: 'sug-done' });
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'DoD Complete');
});

test('service serializes same-workflow suggestions and persists only safe fields', async () => {
  const store = fakeStore(draftWorkflow());
  const service = createSuggestionService({ store, now: () => 2_000, id: () => 'sug-serial' });
  const [first, second] = await Promise.all([service.suggest('wf-1'), service.suggest('wf-1')]);
  assert.equal(first.lastSuggestion.suggestionId, 'sug-serial');
  assert.equal(second.lastSuggestion.suggestionId, 'sug-serial');
  assert.equal('implementation' in JSON.parse(JSON.stringify(first)), false);
});
```

- [ ] **Step 2: 运行失败测试**

```powershell
node --test lib/orchestrator/suggestion-engine.test.js
```

预期：因模块不存在而失败。

- [ ] **Step 3: 实现无副作用 Suggestion Engine**

导出 `buildSuggestion({ workflow, now, suggestionId })` 和 `createSuggestionService({ store, now, id })`。

`buildSuggestion` 必须生成：

```js
{
  suggestionId, action, reason, nextStep, requiresHuman,
  turnContract: {
    version: 1, action, goal, scope, acceptance, target,
    stop, send: false,
  },
  progress,
  receipt: {
    workflowId, suggestionId, generatedAt, action,
    dodTotal, dodPassed, evidenceCount, state,
  },
}
```

规则：

- Human 控制权、`failed`、`waiting_user`、预算超限或完成但证据不足 → `need_human`。
- 所有 DoD 有显式通过证据 → `stop` / `DoD Complete`。
- 其余状态 → `suggest`，下一步只能是读取状态和收集 Evidence。
- Turn Contract 永远 `send: false`，不包含 `prompt`、command、transport 或实现对象。
- Engine 不能 `require('child_process')`、访问文件、访问网络或调用 runner。

`createSuggestionService.suggest(id)` 使用 per-workflow Promise lock；成功后只调用 `store.updateFields` 更新 `lastSuggestion`、`progress`、`lastReceipt`，事件类型为 `suggestion_created`，不改变状态、控制权或 runCount。

- [ ] **Step 4: 运行测试并提交**

```powershell
node --test lib/orchestrator/suggestion-engine.test.js
git diff --check
git add -- lib/orchestrator/suggestion-engine.js lib/orchestrator/suggestion-engine.test.js
git commit -m "feat: add safe suggest engine"
```

## Task 4: 扩展 WorkflowStore 和工作流创建 API

**Files:**

- Modify: `lib/orchestrator/workflow-store.js`
- Modify: `lib/orchestrator/workflow-store.test.js`
- Modify: `lib/orchestrator/api.js`
- Modify: `lib/orchestrator/api.test.js`
- Modify: `lib/jarvis-voice.js`
- Modify: `lib/jarvis-voice.test.js`
- Modify: `lib/orchestrator/runner.test.js`

- [ ] **Step 1: 先增加失败断言**

在现有测试中增加：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeRunContract } = require('./run-contract');

test('stores the immutable run contract and empty observed evidence', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({
    projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex',
    executionPlan: { goal: '完成目标' },
    runContract: normalizeRunContract({
      goal: '完成目标', verify: { dod: ['测试通过'] },
    }),
  });
  const loaded = new WorkflowStore(store.filePath).get(workflow.id);
  assert.equal(loaded.autopilotMode, 'suggest');
  assert.deepEqual(loaded.runContract.verify.dod, ['测试通过']);
  assert.deepEqual(loaded.observedEvidence, []);
  assert.equal(loaded.lastSuggestion, null);
});
```

在 API 测试中断言：缺少 DoD、`autopilotMode: 'auto'`、非法 Budget 被拒绝；`commands`、`transport` 不进入快照。更新既有 `createWorkflowRequest` 测试和 runner 测试，为每个请求传入 `verify.dod`。

- [ ] **Step 2: 实现 Store 字段和旧快照迁移**

`WorkflowStore.create` 增加 `autopilotMode` 和 `runContract` 参数，工作流新增：

```js
autopilotMode: 'suggest',
runContract,
observedEvidence: [],
lastSuggestion: null,
progress: null,
lastReceipt: null,
```

`load()` 对没有这些字段的旧 JSON 工作流补齐安全默认值：从 `executionPlan.goal` 取 Goal；DoD 使用 `['完成用户目标']`；Evidence 使用该 DoD 描述；模式固定为 `suggest`。不执行命令、不修改会话数据。

- [ ] **Step 3: 接入 API Contract**

`createWorkflowRequest` 接收 `autopilotMode`、`scope`、`verify`、`budget`，先调用 `normalizeRunContract`，再把结果传给 `store.create`。未知字段只停留在请求体中，不进入 WorkflowStore。内部 Jarvis Voice 创建请求补传：

```js
verify: { dod: ['返回天气查询结果'], evidence: ['WorkBuddy workflow result'] },
```

不改变 Voice MVP 的 runner 执行流程。

- [ ] **Step 4: 运行编排测试并提交**

```powershell
node --test lib/orchestrator/run-contract.test.js lib/orchestrator/progress.test.js lib/orchestrator/suggestion-engine.test.js lib/orchestrator/workflow-store.test.js lib/orchestrator/api.test.js lib/orchestrator/runner.test.js lib/jarvis-voice.test.js
git diff --check
git add -- lib/orchestrator/workflow-store.js lib/orchestrator/workflow-store.test.js lib/orchestrator/api.js lib/orchestrator/api.test.js lib/orchestrator/runner.test.js lib/jarvis-voice.js lib/jarvis-voice.test.js
git commit -m "feat: persist suggest run contracts"
```

## Task 5: 接入 Runtime、HTTP Suggest API 并关闭 Suggest `/run`

**Files:**

- Modify: `lib/orchestrator/runtime.js`
- Modify: `lib/orchestrator/http.js`
- Modify: `lib/orchestrator/http.test.js`

- [ ] **Step 1: 写失败 HTTP 测试**

新增：

```js
test('suggest endpoint returns a structured suggestion without running transport', async () => {
  const { dir, runtime } = setup();
  let ran = false;
  runtime.runner = { run: async () => { ran = true; } };
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: {
      projectPath: path.join(dir, 'app'), goal: '完成目标', agent: 'codex',
      verify: { dod: ['检查完成'] },
    },
  });
  const id = created.body.workflow.id;
  const suggestion = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${id}/suggest`, runtime, body: {},
  });
  assert.equal(suggestion.status, 200);
  assert.equal(suggestion.body.suggestion.turnContract.send, false);
  assert.equal(ran, false);
});

test('suggest mode rejects run without creating a background task', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'x', verify: { dod: ['完成'] } },
  });
  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${created.body.workflow.id}/run`, runtime, body: {},
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SUGGEST_ONLY');
  assert.equal('background' in result, false);
});
```

- [ ] **Step 2: 运行失败测试**

```powershell
node --test lib/orchestrator/http.test.js
```

预期：Suggest Service 未注入、路由未实现时新增断言失败。

- [ ] **Step 3: 注入 Service 并增加路由**

`createOrchestrationRuntime` 创建 `suggestion = createSuggestionService({ store })` 并返回它。

`handleOrchestrationRequest` 在 `/run` 前增加：

```js
const suggestId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/suggest$/);
if (suggestId && verb === 'POST') {
  const workflow = await runtime.suggestion.suggest(decodeURIComponent(suggestId));
  if (!workflow) return { status: 404, body: { error: 'workflow not found' } };
  runtime.notify(workflow);
  return { status: 200, body: { ok: true, workflow, suggestion: workflow.lastSuggestion } };
}
```

`/run` 查到工作流后，若 `workflow.autopilotMode === 'suggest'`，直接返回：

```js
{ status: 409, body: { ok: false, code: 'SUGGEST_ONLY', error: 'Suggest Mode 只生成建议，不自动执行', workflow } }
```

不得创建 `background` Promise。原 `WorkflowRunner` 代码保留不动。

- [ ] **Step 4: 修正现有禁用 headless 测试并运行**

原“run endpoint accepts work”测试改为断言 `SUGGEST_ONLY`；再运行：

```powershell
node --test lib/orchestrator/http.test.js lib/orchestrator/runner.test.js
git diff --check
git add -- lib/orchestrator/runtime.js lib/orchestrator/http.js lib/orchestrator/http.test.js
git commit -m "feat: expose suggest workflow API"
```

## Task 6: 更新 AI 监控 UI 为 Suggest-only

**Files:**

- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/ai-monitor-contract.test.js`

- [ ] **Step 1: 添加失败 UI 断言**

断言页面和脚本包含：

```js
assert.match(html, /id="ai-in-scope"/);
assert.match(html, /id="ai-out-of-scope"/);
assert.match(html, /id="ai-dod"/);
assert.match(html, /id="ai-evidence"/);
assert.match(app, /autopilotMode: 'suggest'/);
assert.match(app, /\/suggest/);
assert.doesNotMatch(app, /data-action="run"/);
assert.match(app, /SUGGEST_ONLY|Suggest Mode/);
```

- [ ] **Step 2: 修改创建表单和请求**

在现有 Goal 后增加四个输入：In Scope、Out of Scope、Definition of Done、Evidence；每个 textarea 按换行拆成字符串数组。创建请求固定发送：

```js
autopilotMode: 'suggest',
scope: { inScope: lines($('ai-in-scope').value), outOfScope: lines($('ai-out-of-scope').value) },
verify: { dod: lines($('ai-dod').value), evidence: lines($('ai-evidence').value) },
```

DoD 为空时在前端提示，不发送请求。

- [ ] **Step 3: 修改工作流卡片展示和动作**

`renderAIMonitor` 展示：模式、Goal、Scope 摘要、`progress.completed/total`、Suggestion reason、nextStep 和 Receipt 时间。对 Suggest 工作流只生成：

```html
<button data-action="suggest">生成下一步建议</button>
<button data-action="takeover">人工接管</button>
```

`runOrchestrationAction` 将 `suggest` 映射为 `/suggest`；不保留 `run` 作为 UI action。所有动态文本继续使用现有 `esc()`。

- [ ] **Step 4: 运行 UI 定向测试并提交**

```powershell
node --test public/ai-monitor-contract.test.js
git diff --check
git add -- public/index.html public/app.js public/ai-monitor-contract.test.js
git commit -m "feat: make AI monitor suggest-only"
```

## Task 7: 语法、Slice 回归和最终范围审计

**Files:**

- Verify all Slice 2 files and existing Slice 0/1 files.

- [ ] **Step 1: 运行语法检查**

```powershell
node --check lib/orchestrator/run-contract.js
node --check lib/orchestrator/progress.js
node --check lib/orchestrator/suggestion-engine.js
node --check lib/orchestrator/workflow-store.js
node --check lib/orchestrator/api.js
node --check lib/orchestrator/http.js
node --check public/app.js
```

- [ ] **Step 2: 运行 Slice 2 定向测试**

```powershell
node --test lib/orchestrator/run-contract.test.js lib/orchestrator/progress.test.js lib/orchestrator/suggestion-engine.test.js lib/orchestrator/workflow-store.test.js lib/orchestrator/api.test.js lib/orchestrator/http.test.js public/ai-monitor-contract.test.js
```

预期：全部通过；`SUGGEST_ONLY` 测试证明没有后台任务。

- [ ] **Step 3: 运行 Slice 0/1 回归测试**

```powershell
node --test lib/capability-layer.test.js lib/verified-dispatch.test.js lib/codex-desktop-uia.test.js lib/hermes-desktop-uia.test.js lib/codex-delivery.test.js lib/hermes-delivery.test.js server-verified-dispatch.test.js
```

- [ ] **Step 4: 运行全量测试**

```powershell
node --test
```

记录实际测试数量、失败数和取消数，不引用旧文档数字。

- [ ] **Step 5: 检查 Suggest 安全边界和工作区**

```powershell
rg -n "suggest|SUGGEST_ONLY|runner\.run|transport\.run|dispatchVerifiedMessage|send" lib/orchestrator public/app.js
git diff --check
git status --short --branch
git log -8 --oneline --decorate
git diff HEAD~6..HEAD --stat
git diff HEAD~6..HEAD --name-only
```

确认 Suggest 路径没有 `runner.run`、`transport.run`、Verified Dispatch 或 SEND 调用；只读并保留所有既有 `dist-*` 未跟踪目录，不将其加入提交。

- [ ] **Step 6: 完成计划并报告**

交付报告必须包含：修改文件和关键行为、每组测试结果、当前 `main` 提交、保留的未跟踪目录、未实现的 Slice 3/模型路由边界，以及下一步真实桌面 smoke 验证建议。
