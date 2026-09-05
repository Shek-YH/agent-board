# AutoPilot 低置信度自动资料补全修改方案

## 1. 背景与目标

当前 Task Contract 在分析置信度不足时，直接进入 `NEED_HUMAN`，提示用户人工补充范围和验收条件。这不符合全自动托管目标。

目标是将逻辑调整为：

```text
任务输入
  → AI 分析
  → 置信度足够：生成合同并执行
  → 置信度不足：AI 自动收集资料并补全合同
  → 重新评估
  → 足够明确：自动开始
  → 多次补全仍失败或触碰安全边界：NEED_HUMAN
```

核心规则：

- 用户计划详细时，按用户计划执行，不做不必要的推断。
- 用户计划不完整但可以研究时，AI 自动读取项目资料和公开参考资料。
- 低置信度本身不能直接触发人工门禁。
- 高风险、权限不足、身份不确定、资料冲突或研究耗尽时，才进入 `NEED_HUMAN`。
- 研究过程是只读的，不能修改项目、安装依赖、部署或发送外部消息。

## 2. 当前问题

重点检查：

```text
lib/orchestrator/task-intake.js
lib/orchestrator/api.js
lib/orchestrator/http.js
public/autopilot-ui.js
public/app.js
lib/orchestrator/auto-loop.js
lib/orchestrator/workflow-store.js
lib/orchestrator/run-contract.js
lib/orchestrator/policy-gate.js
```

现有问题包括：

1. `validateTaskContract()` 的低置信度结果与真正的人工门禁混在一起。
2. `applyValidationHumanGate()` 会把可通过研究解决的缺失字段直接转成 `NEED_HUMAN`。
3. 没有独立的资料研究状态、研究预算、研究来源和研究失败原因。
4. 没有自动读取 README、项目文档、代码结构和公开参考案例的流程。
5. UI 把“等待 AI 补全”错误展示成“等待人工补充”。

## 3. 新的决策模型

### 3.1 置信度、风险和权限分离

```text
confidence           是否足够理解任务
riskLevel            执行风险
permissionState      当前快照是否允许所需操作
researchCapability   是否能够继续收集资料
```

决策表：

| 条件 | 结果 |
|---|---|
| 置信度足够、风险低、权限完整 | `READY` |
| 置信度不足且存在可研究字段 | `RESEARCH_REQUIRED` |
| 研究完成且置信度达到阈值 | `READY` |
| 外部资料需要未授权权限 | `NEED_HUMAN_PERMISSION` |
| 资料冲突且无法自动消除 | `NEED_HUMAN_AMBIGUITY` |
| 高风险操作 | `NEED_HUMAN_RISK` |
| 研究预算、次数或超时耗尽 | `NEED_HUMAN_RESEARCH_EXHAUSTED` |

### 3.2 状态流转

```text
NOT_STARTED
  ↓
ANALYZING
  ├─ 置信度足够 → READY
  ├─ 置信度不足且可研究 → RESEARCH_REQUIRED
  └─ 高风险/权限不足/目标冲突 → NEED_HUMAN

RESEARCH_REQUIRED
  ↓
RESEARCHING
  ↓
REGENERATING
  ↓
ANALYZING
  ├─ 置信度足够 → READY
  ├─ 仍不足且预算未耗尽 → RESEARCHING
  └─ 仍无法安全确定 → NEED_HUMAN
```

## 4. 新增 Researcher 模块

新增文件：

```text
lib/orchestrator/researcher.js
lib/orchestrator/researcher.test.js
```

### 4.1 职责

Researcher 只负责：

- 根据 Goal 生成研究主题；
- 判断哪些缺失字段可以通过资料补全；
- 优先读取允许的本地资料；
- 必要时搜索公开参考资料；
- 提取结构化事实、假设和设计参考；
- 返回来源摘要、置信度变化和未解决问题；
- 不创建 Session、Workflow 或 Run；
- 不直接派发任务；
- 不修改项目文件。

### 4.2 依赖注入

```js
createResearcher({
  readLocal,
  searchExternal,
  fetchSource,
  now,
})
```

测试必须使用 fake reader、fake search 和 fake fetch，不启动真实浏览器，不执行真实 Claude Code、WorkBuddy 或其他 Agent。

### 4.3 研究结果

```js
{
  status: 'completed',
  confidenceBefore: 0.42,
  confidenceAfter: 0.86,
  attempts: 1,
  sources: [
    {
      type: 'local',
      title: 'README.md',
      path: 'README.md',
      sourceId: 'sha256:...'
    },
    {
      type: 'external',
      title: '参考博客标题',
      domain: 'example.com',
      urlHash: 'sha256:...'
    }
  ],
  findings: [
    {
      topic: 'homepage_structure',
      summary: '个人介绍、最新文章、系列导航适合放在首页'
    }
  ],
  generatedAssumptions: [],
  unresolvedQuestions: []
}
```

不得持久化：

- 原始网页全文；
- 完整模型 Prompt；
- Token、Cookie、密码和完整 `.env`；
- 未过滤的外部响应；
- 不受长度限制的用户输入和 URL。

## 5. 资料来源策略

### 5.1 本地资料优先级

```text
用户 Goal 和历史对话
  → PRD / README / 设计文档
  → 项目目录结构
  → 现有页面和组件
  → 现有测试
  → Git 状态和已有实现
  → 外部公开资料
```

所有本地路径必须经过现有 Project Context 和允许根目录校验。

### 5.2 外部参考资料

以个人 AI 博客任务为例，可以搜索：

- 个人 AI 博主博客；
- 独立技术作者博客；
- AI 工具评测网站；
- 编辑型数字杂志设计；
- 长文阅读体验；
- Newsletter 和专题内容组织方式。

外部资料只能用于提炼结构、交互和视觉方向，不能直接复制文章、品牌文案或代码。

禁止自动注册、登录、提交表单、联系第三方、下载并执行外部脚本。

### 5.3 网络权限

在已有 Permission Snapshot 中增加只读研究权限：

```js
researchRead: boolean,
allowedResearchDomains: string[]
```

要求：

- 权限必须进入不可变快照；
- 研究过程不能临时升级网络权限；
- 未授权网络时仍可继续本地资料研究；
- 确实需要外部资料但无权限时，进入 `NEED_HUMAN_PERMISSION`；
- 搜索和抓取使用注入式 HTTP 能力，不拼接 shell 命令。

## 6. Task Contract 扩展

修改：

```text
lib/orchestrator/task-intake.js
lib/orchestrator/run-contract.js
```

### 6.1 研究元数据

```js
{
  generationStatus: 'ready',
  confidence: 0.86,
  confidenceLevel: 'high',
  research: {
    required: true,
    status: 'completed',
    attempts: 1,
    sourceCount: 5,
    startedAt: 0,
    completedAt: 0,
    budgetUsed: 0,
    sourceSummary: []
  },
  generationSources: [
    'user_goal',
    'inferred',
    'local_project_docs',
    'external_reference'
  ],
  unresolvedQuestions: [],
  needsHumanReason: ''
}
```

### 6.2 缺失字段分类

```js
{
  researchableFields: ['inScope', 'dod', 'evidence'],
  humanRequiredFields: [],
  missingFields: []
}
```

规则：

- 可通过研究补全的字段进入 `researchableFields`；
- 只能由用户决定的字段进入 `humanRequiredFields`；
- `researchableFields` 非空时，不得直接设置 `humanGate.required = true`。

### 6.3 详细任务与模糊任务

详细任务：

```text
读取用户合同
  → 跳过不必要研究
  → 最终校验
  → READY
```

模糊任务：

```text
初次分析
  → 找出可研究字段
  → 读取本地资料
  → 搜索参考资料
  → 生成结构化结论
  → 自动补全合同
  → 重新评估置信度
```

## 7. 研究预算与终止条件

默认配置：

```js
{
  maxResearchAttempts: 2,
  maxSources: 8,
  maxResearchRuntimeMs: 60_000,
  maxExternalPages: 5
}
```

达到任一限制后停止研究，并返回明确原因：

```text
RESEARCH_TIMEOUT
RESEARCH_BUDGET_EXCEEDED
RESEARCH_SOURCE_LIMIT
RESEARCH_PERMISSION_REQUIRED
RESEARCH_CONFLICT
```

不得无限研究，也不得将研究失败伪装成高置信度或完整合同。

## 8. API 修改

修改：

```text
lib/orchestrator/api.js
lib/orchestrator/http.js
```

保留现有：

```http
POST /api/orchestration/intake/preview
```

新增分析响应：

```js
{
  taskContract: {},
  analysis: {
    status: 'researching',
    confidenceBefore: 0.42,
    confidenceAfter: null,
    stages: [
      { name: 'analyze_goal', status: 'completed' },
      { name: 'read_local_context', status: 'completed' },
      { name: 'research_references', status: 'running' },
      { name: 'regenerate_contract', status: 'pending' },
      { name: 'validate_contract', status: 'pending' }
    ]
  },
  research: {
    status: 'running',
    sourceCount: 0
  },
  requiresHuman: false
}
```

如果研究异步执行，增加：

```http
GET /api/orchestration/intake/research/:draftId
```

研究阶段不得调用：

- `provisionSession`；
- `WorkflowStore.create`；
- `dispatchVerifiedMessage`；
- 真实 Agent CLI；
- 项目写入命令。

确认阶段仍必须按以下顺序执行：

```text
最终合同校验
  → Project Context 校验
  → Permission Snapshot 校验
  → capability 校验
  → Session 创建
  → Workflow 创建
  → AutoLoop / dispatch
```

## 9. UI 修改

修改：

```text
public/autopilot-ui.js
public/app.js
public/index.html
```

### 9.1 分析阶段

显示：

```text
校验项目目录
读取项目资料
分析任务目标
搜索参考资料
整理研究结论
生成 Task Contract
应用安全边界
校验 Task Contract
```

### 9.2 低置信度提示

替换：

```text
任务分析置信度较低，需要人工补充范围和验收条件
```

为：

```text
当前任务信息较少，AI 正在自动补充项目资料和参考案例
```

研究成功后显示：

```text
AI 已根据项目资料和参考案例补全任务计划
```

### 9.3 人工门禁

只有以下情况显示人工门禁：

- 外部研究权限未授权；
- 资料存在无法消除的冲突；
- 任务涉及高风险操作；
- 项目或 Session 目标不唯一；
- 研究预算、次数或超时耗尽；
- capability、identity 或 delivery 无法验证。

普通低置信度不得展示人工补充提示。

## 10. AutoLoop 与 handoffChain 集成

修改：

```text
lib/orchestrator/auto-loop.js
lib/orchestrator/workflow-store.js
lib/orchestrator/run-contract.js
lib/orchestrator/policy-gate.js
```

### 10.1 单 Agent Workflow

首次派发前：

```text
读取 Workflow
  → 检查 generationStatus
  → research_required 则自动研究
  → 重新生成合同
  → capability / identity / policy / delivery 校验
  → 派发
```

### 10.2 handoffChain

每个 Step 必须拥有独立研究状态：

```js
{
  id,
  order,
  agent,
  goal,
  dod,
  evidence,
  dependsOn,
  status,
  sessionRef,
  attempts,
  startedAt,
  completedAt,
  result,
  evidenceSnapshot,
  researchStatus,
  confidence,
  researchAttempts,
  researchSources,
  needsHumanReason
}
```

每一步执行顺序：

```text
研究当前 Step
  → 生成当前 Step 合同
  → capability 校验
  → identity 校验
  → policy 校验
  → 创建必要 Session
  → Verified Dispatch
  → delivery 验证
  → Supervisor 判定 DONE
  → DoD/Evidence 验证
  → 解锁下一 Step
```

不得：

- 跳过研究失败的 Step；
- 自动切换到其他 Agent；
- 在前一步未 DONE 时解锁下一步；
- 在 SEND 不确定时自动重发。

## 11. 安全要求

研究必须是只读能力，不能：

- 修改项目文件；
- 安装依赖；
- 执行任意 shell；
- Git Push；
- 部署或发布；
- 读取 Token、Cookie、密码或完整 `.env`；
- 自动提高权限。

本地检查必须使用：

- 固定命令白名单；
- 参数数组；
- `shell: false`；
- 经过校验的工作目录；
- 注入式 fake runner / fetch 测试依赖。

## 12. 持久化与迁移

修改：

```text
lib/orchestrator/workflow-store.js
```

增加：

```js
researchState: {
  status,
  attempts,
  confidenceBefore,
  confidenceAfter,
  sourceCount,
  budgetUsed,
  startedAt,
  completedAt,
  failureCode
}
```

兼容规则：

- 旧 Workflow 缺少 `researchState` 时默认为 `not_started`；
- 旧低置信度字段不应阻止新一轮自动研究；
- 已确认的 Task Contract 继续不可变；
- `handoffChain` 为空时继续走旧版单 Agent 逻辑；
- 旧 Codex/Hermes 派发行为不改变。

## 13. TDD 测试计划

### 13.1 Task Contract

文件：

```text
lib/orchestrator/task-intake.test.js
```

覆盖：

- 详细 Goal 跳过外部研究；
- 模糊 Goal 自动进入研究；
- 低置信度不会直接进入 `NEED_HUMAN`；
- 研究结果补全 Scope、DoD、Evidence；
- 研究后置信度提升并进入 `READY`；
- 研究次数耗尽后才进入人工门禁；
- 原始网页正文和敏感字段不进入合同。

### 13.2 Researcher

文件：

```text
lib/orchestrator/researcher.test.js
```

覆盖：

- 本地 README 和项目文档优先；
- 外部搜索使用 fake provider；
- 不调用真实网络；
- 不执行 shell；
- 来源数、超时和预算限制生效；
- 外部权限不足返回稳定错误；
- 资料冲突返回 `RESEARCH_CONFLICT`；
- Token、Cookie、密码等字段被过滤。

### 13.3 API 与 UI

文件：

```text
lib/orchestrator/http.test.js
lib/orchestrator/api.test.js
public/autopilot-v23-intake-ui.test.js
public/autopilot-ui.test.js
```

覆盖：

- 低置信度预览自动研究；
- 研究中不创建 Session、Workflow 或 Run；
- 研究完成后才能确认；
- UI 显示“AI 正在补充资料”；
- 不显示“需要人工补充范围和验收条件”；
- 研究阶段禁止重复提交；
- 只有真实人工原因才显示人工门禁。

### 13.4 AutoLoop 与 handoffChain

文件：

```text
lib/orchestrator/auto-loop.test.js
lib/orchestrator/workflow-store.test.js
lib/orchestrator/policy-gate.test.js
```

覆盖：

- AutoLoop 派发前自动研究；
- 研究失败不 dispatch；
- 研究成功后继续派发；
- 研究预算耗尽后暂停；
- 服务重启后恢复研究状态；
- 每个 handoff Step 独立研究和校验；
- 上一步未 DONE 时下一步不可启动。

## 14. 实施顺序

1. 先为低置信度与人工门禁的区分补失败测试。
2. 实现本地资料 Researcher。
3. 实现外部只读研究适配器和权限检查。
4. 接入 Task Contract 自动重生成与置信度重评估。
5. 更新 API、草稿状态和 UI 分析阶段。
6. 接入单 Agent AutoLoop。
7. 接入 handoffChain 的逐步研究和状态恢复。
8. 运行完整回归和敏感字段审查。

## 15. 验收标准

- 详细任务不进行不必要研究。
- 模糊任务会自动收集允许的本地和外部资料。
- 低置信度不会直接进入 `NEED_HUMAN`。
- AI 能自动生成 Scope、DoD、Evidence 和 Assumptions。
- 研究失败、权限不足或高风险时才进入人工门禁。
- 研究阶段不创建 Session、Workflow 或 Run。
- 研究状态可在服务重启后恢复。
- 所有来源可追溯但不泄漏敏感内容。
- 单 Agent Workflow 与 handoffChain 都保持旧版兼容。
- Codex/Hermes 既有行为不回归。
- Claude/WorkBuddy capability 不完整时仍报告 unsupported。
- 默认测试不执行真实外部 Agent 命令。
- 不安装依赖、不部署、不发布、不 Git Push。

## 16. 验证命令

```bash
npm test
git diff --check
```

如修改打包相关内容，再运行对应的 package verify；不自动生成或提交构建产物。
