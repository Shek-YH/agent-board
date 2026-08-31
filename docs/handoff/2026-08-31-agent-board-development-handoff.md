# Agent Board 开发 Handoff

> 更新时间：2026-08-31  
> 用途：供下一次 Codex 会话直接接续开发。本文只总结已验证事实、当前边界和下一步，不替代 PRD。

## 1. 当前仓库状态

- 仓库：`C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10\agent-board-main`
- 分支：`main`
- 当前 HEAD：`25eee74 docs: add development handoff`
- `main` 相对 `origin/main`：ahead 51；本轮没有 push。
- 已跟踪文件：干净。
- 工作树中已有的 `Microsoft/` 和各个历史 `dist-*` 未跟踪目录属于既有产物，本轮没有添加、删除、覆盖或清理。

新会话开始时先执行：

```powershell
cd C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10\agent-board-main
git status --short --branch
git log -1 --oneline --decorate
```

## 2. 已完成的产品能力

### AutoPilot / Task Intake

- Session 卡片的“AI 托管”入口已接入后端 Intake 预览。
- 后端会重新解析 Session 的项目、Agent 和 Session Ref，不信任前端传入的项目身份。
- 任务等级已统一为 `direct`、`light`、`standard`、`project`、`high_risk`。
- `direct` 任务旁路，不创建 Workflow；其他等级沿用现有 Settings、Model Routing 和 WorkflowStore。
- `high_risk` 创建后保持暂停并返回人工审批要求。
- PRD 支持自动判断、当前项目、允许目录内手动文件和“不使用 PRD”。
- PRD 候选只返回文件名、版本、大小、修改时间和可信度；仅读取 `.md`、`.mdx`、`.txt`，大小上限 5 MB，并阻止符号链接越界。
- Workflow 只保存白名单化 Task Contract 和 PRD SHA-256 元数据，不保存 PRD 原文。
- 主要接口：
  - `GET /api/orchestration/prd/candidates?sessionRef=...`
  - `POST /api/orchestration/intake/preview`
  - `POST /api/orchestration/workflows/from-session`
  - `POST /api/orchestration/prd-draft`

### Routing Data Flywheel

- 已加入任务分类、终态 Workflow 结果聚合和只读历史画像。
- 已加入按 Agent + task class 的 Profile 推荐接口。
- 推荐严格要求同 Agent、同任务类型至少 3 条已完成样本。
- 推荐不会修改 Workflow 路由、绕过手动 pin 或自动启动其他 Agent。
- 缺少历史或 Agent 不支持可靠模型切换时会 fail-closed，返回原因而不是伪造推荐。

### Codex 真实交付与能力校验

- Codex Session 标题支持精确匹配和规范化 fallback。
- 请求标题、Workflow、Codex 交付证据之间已绑定，减少“发到了错误会话”的风险。
- Codex app-server `initialize` 已声明 `experimentalApi` 能力。
- 模型目录和推理强度以运行时真实 capability 为准，profile 解析不会发送当前模型不支持的值。
- 交付证据读取增加了有界等待，生产默认等待 10 秒，修复发送成功但 UI/JSONL 写入稍晚导致的竞态。
- `AB_DATA_DIR` 数据目录隔离和 `ZHIPU_API_KEY` / `ZAI_API_KEY` 兼容已保留。

## 3. 真实 Codex Workflow 验证证据

真实测试任务：

- Codex task/thread：`01a057b7-d4dc-7e40-b065-73c3cc69a8eb`
- 使用的是本机真实 Codex Desktop Workflow，模型/推理强度为 `gpt-5.4` / `medium`。
- 临时 Agent Board 服务端口：`http://127.0.0.1:4877`
- 临时数据目录：`C:\Users\Administrator\AppData\Local\Temp\agent-board-real-workflow-20260831-v7`
- 临时服务已停止；不要在没有需要时重启。

三条可计入的干净完成记录：

1. `wf-8fcfc049-7bd7-4079-99ed-7db073aeb438` — `TEST_WORKFLOW_2_OK`
2. `wf-36c788ef-e61c-4224-977c-a5cde3ee82be` — `TEST_WORKFLOW_3_OK`
3. `wf-f1ae80ad-fe0f-4732-94eb-d12be578960d` — `TEST_WORKFLOW_4_OK`

三条记录均满足：dispatch `committed`、Session identity 已验证、delivery evidence 已验证、Workflow 为 `DONE`，且观察到了真实 Codex 回复。

另有一条早期记录 `wf-37838438-27fe-4f46-b4fc-27a0347b326e`，第一次 dispatch 因 Desktop 写入延迟超过 3 秒出现 `DELIVERY_NOT_FOUND`，之后观察到真实回复并恢复为 `DONE`。它可作为竞态修复证据，但不要把它当作干净 dispatch 样本。

本轮 Insights 结果：

- `existing_unversioned`：attempts 4、successes 4、failures 0、successRate 1、averageIterations 1、averageDodCompletionRate 1。
- `taskProfiles` 为空，recommendation 为 `INSUFFICIENT_HISTORY`。

这是预期的安全结果：为了不抢占 Desktop 当前活动 writer，真实 UI Workflow 测试没有强行开启 per-workflow app-server profile routing，因此没有伪造一条模型/推理 profile。下一步若要验证“正向推荐”，必须使用由 app-server 自己拥有 writer 的 Codex 测试会话，再产生至少 3 条同 Agent + 同 task class 的已验证 profile 记录。

## 4. 代码提交与验证记录

当前主要提交（由新到旧）：

```text
25eee74 docs: add development handoff
9f643fa docs: add real autopilot intake smoke test
edebb04 docs: finalize autopilot intake verification
a49d657 feat: simplify autopilot intake and harden real codex delivery
f99be9f feat: add task-aware routing recommendations
5041199 feat: add routing data flywheel insights
```

已验证：

- `npm test`：1082 tests，1081 passed，0 failed，1 skipped。
- 真实 Codex Workflow：3 条干净完成记录，另有 1 条竞态恢复记录。
- 包体验证脚本：已通过；本次构建基于 `25eee74`，未覆盖历史产物。
- 安装包：`C:\Users\Administrator\AppData\Local\Temp\agent-board-exe-20260831-handoff-v1\Agent Board Setup 0.2.0.exe`
- 安装包大小：137,754,629 bytes。
- 安装包 SHA-256：`A9D40C9710F205C01B6CE8DD49E5E4900641B12C6B2CE280A533A9E2DB3AEE61`
- 验证命令：`npm run desktop:verify -- "C:\Users\Administrator\AppData\Local\Temp\agent-board-exe-20260831-handoff-v1\win-unpacked"`

## 5. 明确的后续 TODO（按优先级）

1. **完成正向 Routing Recommendation 真实验证**：创建 app-server-owned Codex writer 会话，获取运行时真实 model/reasoning capability，生成至少 3 条同类型、带 profile 的 `DONE` 记录，确认推荐返回具体 profile；禁止用 fixture 冒充真实结果。
2. **安装包 UI smoke test**：用本次新构建的安装包启动，确认 Session 卡片右上方可看到“AI 托管”，并验证 intake 预览、任务目标输入和启动/停止状态流转。
3. **补齐文档勾选状态**：`docs/superpowers/plans/2026-08-31-routing-data-flywheel-phase2.md` 中仍保留部分实施计划的旧 checkbox 状态；代码已落地，但后续可按真实验证结果更新计划文档，避免文档状态与代码状态不一致。
4. **远端同步**：当前 `main` ahead 51，尚未 push；只有在用户明确要求时再推送。
5. **历史构建产物治理**：现有多个 `dist-*` 和 `Microsoft/` 未跟踪目录未触碰；如需清理，必须先逐项确认目标和可恢复性。

## 6. 下一会话建议启动顺序

```powershell
cd C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10\agent-board-main
git status --short --branch
git log -1 --oneline --decorate
npm test
```

然后优先处理第 1 项正向推荐验证；若继续做 UI，则先运行 `node server.js`，再检查 `http://127.0.0.1:4876`，不要同时启动多个 Electron、`start.bat` 或 watchdog 实例。

## 7. 关键文件索引

- 产品说明：`C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10\Agent_Board_AutoPilot_PRD_V2.2.md`
- Task Intake 设计：`docs/superpowers/specs/autopilot-task-intake.md`
- Task Intake 实施计划：`docs/superpowers/plans/2026-08-31-autopilot-task-intake.md`
- Routing 设计：`docs/superpowers/specs/2026-08-30-intelligent-routing-design.md`
- Routing Flywheel Phase 2 计划：`docs/superpowers/plans/2026-08-31-routing-data-flywheel-phase2.md`
- Routing capability hardening：`docs/superpowers/plans/2026-08-31-routing-capability-hardening.md`
- 本 handoff：`docs/handoff/2026-08-31-agent-board-development-handoff.md`
