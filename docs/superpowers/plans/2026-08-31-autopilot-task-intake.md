# AutoPilot Task Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Session AutoPilot 启动前完成任务分级、只读 PRD 发现与标准化，并生成最小、安全、可验证的 Task Contract。

**Architecture:** 新增纯逻辑 `task-intake` 层，复用现有 Session 严格解析、`project-prd`、Run Contract、WorkflowStore、Settings 与 Routing。HTTP 预览不写状态；启动接口只在非 `direct` 任务创建现有 Workflow，并把经过白名单规范化的 Task Contract 作为快照保存。

**Tech Stack:** Node.js CommonJS、Node 内置测试运行器、原生 HTML/CSS/JavaScript、现有 JSON WorkflowStore；不新增依赖或数据库。

---

### Task 1: Task Contract 与确定性 Intake

**Files:**
- Create: `lib/orchestrator/task-intake.js`
- Test: `lib/orchestrator/task-intake.test.js`

- [x] 先写覆盖 `direct/light/standard/project/high_risk`、无 PRD、缺失字段、推断字段与敏感字段剔除的失败测试。
- [x] 运行 `node --test lib/orchestrator/task-intake.test.js`，确认因模块或行为缺失失败。
- [x] 实现白名单 Schema、任务分级、字段优先级、安全默认值与 `humanGate`。
- [x] 重跑测试，确认通过后再整理重复逻辑。

### Task 2: 安全 PRD 候选与标准化

**Files:**
- Modify: `lib/orchestrator/project-prd.js`
- Modify: `lib/orchestrator/project-prd.test.js`

- [x] 先写覆盖单个/多个/手动/父级/越界/5 MB/符号链接、标题/列表/表格/DoD/非目标/哈希/原文不变、AI JSON 回退的失败测试。
- [x] 运行 `node --test lib/orchestrator/project-prd.test.js`，确认新断言失败。
- [x] 实现候选元数据、安全根边界、只读读取、确定性结构解析与受约束 AI 草稿校验。
- [x] 重跑测试并确认旧 `generatePrdGoalDraft` 行为兼容。

### Task 3: Session 预览、启动与 Workflow 快照

**Files:**
- Modify: `lib/orchestrator/api.js`
- Modify: `lib/orchestrator/http.js`
- Modify: `lib/orchestrator/workflow-store.js`
- Modify: `lib/orchestrator/http.test.js`
- Modify: `lib/orchestrator/workflow-store.test.js`

- [x] 先写预览不创建/不 dispatch、后端重解析 Session、自动/多版本/手动/越界、direct 旁路、high-risk 暂停、旧 PRD draft 兼容测试。
- [x] 运行聚焦测试并确认失败。
- [x] 新增 candidates/preview 路由；启动入口复用同一 Intake 结果并把安全契约写入现有 WorkflowStore。
- [x] 重跑测试，确认 Session、Settings、Routing 与现有 API 没有第二套状态源。

### Task 4: Session AutoPilot 动态 UI

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/autopilot-fast-path.test.js`

- [x] 先写 PRD 来源选择、候选选择、手动路径、动态摘要、加载/空/错、高风险门槛和不展示敏感字段的契约测试。
- [x] 运行 `node --test public/autopilot-fast-path.test.js` 并确认失败。
- [x] 将快速入口切换为 Intake preview；仅展示对应任务等级的字段，确认后调用现有 Session 启动入口。
- [x] 重跑前端契约测试并确认通过。

### Task 5: 文档、回归与本地提交

**Files:**
- Modify: `README.md`
- Modify: only files above when verification exposes a task-related issue

- [x] 补充 API、启动、测试、故障排查和安全边界说明。
- [x] 运行所有修改 JavaScript 的 `node --check`、`git diff --check`、`npm test` 以及现有聚焦测试；全量套件的既有 `server-account` 启动超时单独记录。
- [ ] 重新计算两份只读 PRD 的 SHA-256，确认未变化；检查历史 `dist-*` 未删除或覆盖。
- [ ] 仅暂存本功能 hunks，保留分支创建前已有的未提交修改，创建本地提交且不 push。
