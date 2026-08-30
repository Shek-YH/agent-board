# Slice 1 Capability Layer 设计规格

日期：2026-08-30

## 目标

在不改变现有会话扫描、Codex/Hermes Verified Dispatch 和存储行为的前提下，为 Agent Board 建立统一的 Capability Registry。后续 Slice 可以通过统一入口发现 Agent 能力，并复用已有实现；不支持的能力必须显式标记为 unsupported。

## 范围

本 Slice 包含：

- 定义统一 Capability 名称和能力描述结构。
- 为当前 Agent Adapter 注册已有的 Conversation Reader 与 Completion Detector 能力。
- 为 Codex Desktop、Hermes Desktop 注册已有的 Session Locator、Session Activator、Identity Verifier、Message Writer 和 Delivery Verifier 实现。
- 让现有 Verified Dispatch 依赖从 Registry 获取，保持外部 API 和 fail-closed 流程不变。
- 提供只读的能力报告，供后续 UI 或诊断使用。
- 为已支持、未支持、未知 Agent、重复注册和无效描述增加测试。

本 Slice 不包含：

- Supervisor、Run Contract、Suggest/Auto Loop 或 Policy Gate。
- Model Catalog、Model Selector、Reasoning Selector 或任何模型路由。
- 数据库表、Secret Store、Settings UI 或新的 Session Store。
- 重写现有 Adapter、UIA、Deep Link 或 Delivery Reader。
- 为没有现成实现的能力伪造可调用函数。

## 当前实现复用

Registry 只做能力编排和声明，不复制底层逻辑：

| Capability | 现有实现 |
|---|---|
| Session Locator | `store.resolveSessionControlTarget` 与 `resolveVerifiedSession` |
| Session Activator | `activateVerifiedSession` |
| Conversation Reader | 各 Adapter 的 `scanAll`、`poll`、`isSessionFile` 等读取入口 |
| Identity Verifier | `verifyCodexDesktopSession`、`verifyHermesDesktopSession` |
| Message Writer | `createCodexWriter`、`createHermesWriter` |
| Delivery Verifier | `createCodexDeliveryReader`、`createHermesDeliveryReader` |
| Completion Detector | 各 Adapter 已有的完成事件解析和 Store 状态归并入口 |

## Capability Contract

使用 CommonJS 普通对象，不引入 class 或第三方依赖。每个 Agent 返回一个不可变能力集合：

```js
{
  agentId: 'codex',
  capabilities: {
    sessionLocator: {
      name: 'sessionLocator',
      supported: true,
      implementation: Function,
      source: 'core'
    },
    messageWriter: {
      name: 'messageWriter',
      supported: true,
      implementation: { write: Function, send: Function },
      source: 'uia'
    },
    modelSelector: {
      name: 'modelSelector',
      supported: false,
      implementation: null,
      reason: 'Slice 3.5 尚未接入'
    }
  }
}
```

固定 Capability 名称为：

```text
sessionLocator
sessionActivator
conversationReader
identityVerifier
messageWriter
deliveryVerifier
completionDetector
```

Contract 只允许已知名称。`supported: true` 必须有非空实现；`supported: false` 的实现必须为 null，并且必须有可读 reason。Registry 不为缺失字段自动推断支持状态。

能力实现的行为协议如下：

- `sessionLocator`：接收 `{ agent, project, sessionRef }`，返回现有的严格 resolution。
- `sessionActivator`：接收已解析目标，返回现有 activation result。
- `conversationReader`：保留现有 Adapter 的扫描对象，不改变 `scanAll/poll` 参数。
- `identityVerifier`：接收目标并返回现有 UIA identity evidence。
- `messageWriter`：保留现有 `{ write, send }` 方法。
- `deliveryVerifier`：保留现有 `{ snapshot, verify }` 方法。
- `completionDetector`：保留现有 Adapter 的完成事件解析/状态入口，以 capability binding 形式登记，不新造第二套检测器。

## Registry API

`lib/capability-layer.js` 提供：

```js
createCapabilitySet(agentId, definitions)
createCapabilityRegistry(definitions)
```

Registry 提供只读操作：

```js
registry.has(agentId)
registry.get(agentId)
registry.list()
registry.report()
```

`get` 对未知 Agent 返回 null；注册、能力名称、支持状态或实现形状无效时抛出 `TypeError`。`report()` 只返回安全元数据，不暴露函数实现；它包含 Agent、每个 capability 的 supported/source/reason。

## Server 集成

`server.js` 创建一个进程级 Registry：

- 所有现有 Adapter 注册 Conversation Reader 和 Completion Detector。
- Codex/Hermes 另外注册 Verified Dispatch 所需的 session、identity、writer、delivery 实现。
- `createVerifiedDispatchDependencies(agent)` 从 Registry 读取能力，并把能力映射成 `dispatchVerifiedMessage` 当前需要的依赖对象。
- 如果 Agent 缺少 POC 所需 capability，返回现有的 unsupported/invalid 请求结果；不回退到最近会话、不回退到 Prompt 或任意 GUI 点击。

现有 `/api/verified-dispatch` 请求字段、HTTP 状态、阶段顺序、reconciliation 行为和禁止自动重发规则保持不变。

## 错误和安全边界

- 未注册 Agent：只读查询返回 null；Verified Dispatch 继续拒绝。
- unsupported capability：报告为 `supported: false`，不能被当作函数调用。
- 重复 Agent 注册：启动时抛出，避免静默覆盖。
- 重复 Capability 或无效实现：构建 Registry 时抛出。
- Registry 不读取或写入密钥，不执行 Shell，不改变 Session Store。
- 能力报告不包含消息正文、路径之外的敏感数据、令牌或函数源码。

## 测试策略

- Contract 测试：合法能力、unsupported 能力、未知名称、缺少 reason、支持但无实现。
- Registry 测试：注册、查找、列表、只读报告、未知 Agent、重复注册和输入隔离。
- 集成测试：Codex/Hermes 的 Verified Dispatch 依赖来自 Registry，完整阶段顺序和单次 SEND 仍保持。
- 回归测试：现有 Slice 0 定向测试和全量 `node --test` 必须继续通过。
- 不在自动化测试中伪造或修改真实 Agent 安装、会话数据库或用户草稿。

## 验收标准

1. 任何 Agent 能力都通过同一个 Contract/Registry 表达。
2. Codex/Hermes Verified Dispatch 不再直接在依赖工厂中重复拼装具体 writer/delivery 组合。
3. 所有已有 Adapter 至少能通过 Registry 暴露其当前 Conversation Reader 和 Completion Detector binding。
4. 缺失能力不会被伪装成支持，也不会拖垮基础会话扫描。
5. Slice 0 外部行为和现有测试结果不回归。
