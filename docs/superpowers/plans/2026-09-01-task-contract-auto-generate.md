# Task Contract 自动生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户只提供项目目录、Goal 和可选 PRD，就能得到可审核的完整 Task Contract，并在安全校验和人工确认后创建真实 Session。

**Architecture:** 保留现有 `task-intake.js`、`api.js`、`http.js`、`autopilot-ui.js` 和 `app.js` 的职责边界。扩展现有确定性解析器，分别计算复杂度与风险，按 PRD → Goal → 安全策略生成字段；在确认入口复用后端最终校验，已有 Settings/Permission Snapshot、重复 Session、NEED_HUMAN 和 Verified Dispatch 逻辑不另起实现。

**Tech Stack:** Node.js CommonJS、Node built-in `node:test`、Electron renderer 原生 DOM、Markdown PRD、electron-builder。

---

### Task 1: 固定当前接口与失败基线

**Files:**
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/lib/orchestrator/task-intake.test.js`
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/lib/orchestrator/http.test.js`
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/public/autopilot-v23-intake-ui.test.js`

- [x] **Step 1: 写自动生成和安全边界失败测试**

为 `task-intake.test.js` 增加以下断言：仅有“修改登录按钮并补充测试”的 Goal 时，预览合同包含非空 `inScope/outOfScope/dod/evidence/assumptions`、`complexity`、`riskLevel`、`generationSources`；没有 PRD 时来源说明为 `goal-only`，默认禁止删除、安装、网络、Push、Secrets 和项目外路径；明确删除生产数据的目标标为高风险并需要人工确认；多行 PRD 字段去重后仍为字符串数组。

为 `http.test.js` 增加确认一个缺失合同字段时的断言：响应码为 422，保留 `TASK_CONTRACT_INCOMPLETE`，并同时返回全部 `missingFields`、中文 `missingFieldLabels`、`reasons` 和 `suggestedActions`，且 Session provisioner、Workflow store、发送回调均未调用。

为 `public/autopilot-v23-intake-ui.test.js` 增加静态回归断言：按钮文案为“分析目标并生成 Task Contract”，包含六个分析阶段、复杂度/风险/来源/假设/所需权限/具体中文缺失字段展示，并且加载期间禁用重复分析。

- [x] **Step 2: 运行失败基线**

Run: `node --test lib/orchestrator/task-intake.test.js lib/orchestrator/http.test.js public/autopilot-v23-intake-ui.test.js`

Expected: 新增断言因当前合同没有自动补全字段/API 细节/UI 文案而失败；先保留失败输出作为实现边界。

### Task 2: 扩展确定性 Task Contract 生成器

**Files:**
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/lib/orchestrator/task-intake.js`
- Test: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/lib/orchestrator/task-intake.test.js`

- [x] **Step 1: 增加稳定枚举、安全默认和多行数组解析**

新增并只接受 `simple|standard|complex`、`low|medium|high|critical` 和 `user_goal|prd|safety_policy|inferred|user_edited`。将 Goal/PRD 数组及多行文本统一按换行、列表前缀、空白、去重和敏感内容过滤处理。安全默认写入 `outOfScope`，但不把默认策略转成任何允许权限。

- [x] **Step 2: 分别计算复杂度和风险**

保留原 `classification.kind` 兼容字段，同时在 classification 中返回 `complexity`、`riskLevel`、`riskReasons` 和置信度。复杂度由子目标、模块/目录、UI/API/数据/Worker、测试/多阶段/协同等信号计算；风险由删除/覆盖/迁移、网络、安装、Git Push/发布、Secrets、跨目录、外部副作用、无法验证和权限升级等信号计算。简单目标仍必须走完整合同；风险独立于复杂度。

- [x] **Step 3: 按优先级生成合同字段并标记来源**

在 `buildTaskContract` 的 hosted/preview 路径中按 `prd → goal → safety/inferred` 合并 `goal`、`inScope`、`outOfScope`、`dod`、`evidence`、`assumptions` 和 `requiredPermissions`。Goal 必须保留原意；DoD/Evidence 使用可验证描述；默认补全不足时留下 `missingFields` 和具体原因，不能用“成功”占位绕过校验。返回 `generationSources`、`sourceSummary`、`requiresHumanConfirmation` 和 `needsHumanReason`，并保留旧字段 `inferredFields`。

- [x] **Step 4: 增加后端可复用的最终合同校验**

导出 `validateTaskContract`，检查 Goal、非空 inScope、高风险的 outOfScope/DoD/Evidence、DoD 可验证词、Evidence 可执行/可检查词、来源枚举和 requiredPermissions。校验失败返回 `missingFields`、中文标签、原因和建议；低置信度或无法安全补齐时令合同进入 `NEED_HUMAN`，不创建 Session/Run/发送。

- [x] **Step 5: 运行核心测试**

Run: `node --test lib/orchestrator/task-intake.test.js`

Expected: 自动生成、风险隔离、无 PRD 来源、字段解析和旧 direct/light/project 兼容测试全部 PASS。

### Task 3: 接通预览/确认 API 的详细错误和权限保护

**Files:**
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/lib/orchestrator/api.js`
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/lib/orchestrator/http.js`
- Test: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/lib/orchestrator/http.test.js`

- [x] **Step 1: 预览只做上下文和合同分析**

沿用 `validateProjectContext`、允许根目录、PRD 读取和重复 Session 查询；预览响应增加生成阶段所需的 `analysis` 元数据和合同校验结果，但不调用 `provisionSession`、`store.create`、任务发送或执行器。

- [x] **Step 2: 确认前调用最终校验并返回结构化错误**

在 `createConfirmedTask` 进入 Session provision 前调用 `validateTaskContract`。错误对象带 `missingFields`、`missingFieldLabels`、`reasons`、`suggestedActions`；`http.js` 原样透传这些字段，同时保留旧 `error` 文案和错误码。错误或 NEED_HUMAN 时先结束，不创建 Session/Run。

- [x] **Step 3: 保留快照、重复 Session 和 SEND 安全语义**

确认成功继续使用现有 `createSettingsSnapshot`、`buildPermissionSnapshot`、新建默认和继续已有两条路径；requiredPermissions 只用于审阅/人工门禁，不能反向扩大 Permission Snapshot。保留 `sessionChoice=new` 默认、Session Identity/Project Binding 重验、SEND 后不重发和验证失败 Fail Closed。

- [x] **Step 4: 运行 API 测试**

Run: `node --test lib/orchestrator/http.test.js lib/orchestrator/api.test.js`

Expected: 新错误结构、无确认保护、目录/PRD 校验、快照、重复 Session、NEED_HUMAN 和既有 API 测试全部 PASS。

### Task 4: 更新 Task Contract 预览界面

**Files:**
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/public/autopilot-ui.js`
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/public/app.js`
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/public/autopilot-v23-intake-ui.test.js`

- [x] **Step 1: 扩展纯视图适配器**

让 `taskContractView` 返回复杂度、风险等级/原因、系统假设、所需权限、字段来源、中文 missing labels、NEED_HUMAN 原因和无 PRD 文案；数组为空统一映射为“未能自动生成，确认前需要人工处理”，不渲染 `undefined`。

- [x] **Step 2: 更新 hosted task 分析状态机**

将按钮改为“分析目标并生成 Task Contract”。分析开始按“校验项目目录 → 读取 PRD → 分析任务复杂度和风险 → 生成 Task Contract → 应用安全边界 → 校验 Task Contract”展示阶段；请求中禁用分析和确认按钮，失败后恢复分析按钮且保留明确错误。

- [x] **Step 3: 展示完整审阅摘要**

在现有预览区展示 Goal、Scope、Out of Scope、DoD、Evidence、Assumptions、所需权限、允许/禁止操作、复杂度、风险原因、来源、置信度和状态；无 PRD 显示“本合同仅根据任务目标生成，未读取 PRD。”；后端错误展示具体中文字段、原因和建议。

- [x] **Step 4: 运行 UI 静态测试**

Run: `node --test public/autopilot-v23-intake-ui.test.js public/autopilot-ui.test.js public/autopilot-fast-path.test.js`

Expected: 新旧 Agent 导航、空 Session 入口、目录选择、快照确认、中文错误和无重复提交断言全部 PASS。

### Task 5: 同步 PRD 并完成验证与打包

**Files:**
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/Agent_Board_AutoPilot_PRD_V2.3.md`
- Modify: `C:/Users/Administrator/WorkBuddy/2026-08-20-03-52-10/agent-board-main/README.md` only if the implemented endpoint behavior needs a concise compatibility note

- [x] **Step 1: 在 V2.3 追加自动生成补充**

补充用户输入、无 PRD、复杂度/风险分离、完整字段生成、来源、默认安全边界、NEED_HUMAN、结构化错误、确认前保护和验收矩阵；不改写无关原章节，并在版本变更记录追加本次实现。

- [x] **Step 2: 执行完整测试和静态检查**

Run: `node --test`

Run: `npm run desktop:verify -- dist-merged-20260901/win-unpacked` only when the new build output exists.

Run: `git diff --check`

Expected: 全部现有和新增 Node 测试 PASS，若项目没有独立 lint/typecheck 脚本则在最终报告明确说明；不安装依赖。

- [x] **Step 3: 构建可分发 EXE 并验证产物**

Run: `npx electron-builder --win nsis --config.directories.output=dist-task-contract-autogen-20260901`

Run: `node tools/verify-package.js dist-task-contract-autogen-20260901/win-unpacked`

Expected: 生成 `Agent Board Setup 0.2.0.exe` 和可运行的 `win-unpacked`，报告绝对路径与 SHA256；不发布、不 push。
