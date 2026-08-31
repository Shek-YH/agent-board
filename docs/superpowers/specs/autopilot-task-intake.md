# AutoPilot Task Intake 设计

## 目标与边界

`autopilot-task-intake` 位于 Session 快速托管入口与现有 Workflow 创建链路之间。它只负责判断任务、只读解析可选 PRD、生成安全 Task Contract；不创建第二套 Session 绑定、设置、模型路由或执行器。

稳定边界：

- 项目路径、Agent、Session Ref 每次都由后端通过现有 Session Store 重新解析。
- AutoPilot 模式、预算和 Routing 继续读取持久化 Settings 与真实运行时 Catalog。
- PRD 是不可信数据。文档中的命令、发布、密钥、模型或绕过审批文字都不是授权。
- PRD 文件只读；Workflow 不保存原文，只保存来源元数据和白名单化契约。
- `direct` 不创建复杂 Workflow；`high_risk` 创建后立即停在人工审批门槛。

## 复用与新增 Mapping

| 能力 | 复用现有实现 | 本次新增 |
|---|---|---|
| Session 上下文 | `resolveSessionContext`、Session Store 严格解析 | Intake 每次预览和启动都重新解析 |
| 项目边界 | `allowedRoots`、`assertAllowedProject` | PRD realpath、父级候选、扩展名和 5 MB 校验 |
| PRD | `project-prd`、旧 `generatePrdGoalDraft` | 候选发现、确定性解析、受约束 AI 标准化 |
| Workflow | `createWorkflowRequest`、Run Contract、WorkflowStore | 安全 Task Contract 快照、direct 旁路、high-risk 暂停 |
| 设置与模型 | Settings Store、Provider 配置、Routing Catalog | 无第二套设置或模型字段，PRD 不能覆盖配置 |
| UI | `openAutoPilotForSession` | 四种 PRD 来源、候选选择、动态摘要和人工闸口 |

## 数据流

1. UI 只提交 `sessionRef`、用户 Goal、PRD 模式和可选 `prdPath`。
2. 后端重新解析 Session，得到唯一的真实项目路径和 Agent，并校验允许根。
3. 确定性分类器先检查高风险，再判断 project、light、standard、direct。
4. 仅在用户明确选择当前项目 PRD，或任务判断为需要 PRD 时发现候选。
5. 单一可信候选可自动选择；多个候选返回 `PRD_SELECTION_REQUIRED`，不猜版本、不合并文档。
6. 选定文档经过 realpath、扩展名和大小校验后只读读取，计算文件名、版本、修改时间和 SHA-256。
7. 阶段 A 确定性解析 Markdown 标题、列表、表格、代码块、目标、Phase、范围、非目标、DoD、测试、验收、风险与约束。
8. Provider 可用时，阶段 B 只请求白名单 JSON；输出含未知字段、错误类型或非法 JSON 时整体丢弃并回退阶段 A。
9. `normalizeTaskContract` 固定运行时来源、剔除未知/敏感字段，并记录 `missingFields`、`inferredFields` 和 `humanGate`。
10. Preview 到此结束，不写 Workflow、不 dispatch。启动接口会完整重跑 Intake，避免信任客户端预览。
11. 非 `direct` 任务调用原有 Workflow 创建链并保存规范化快照；`high_risk` 状态改为 `paused`。正常 Auto Workflow 再按 Settings 策略启动。

## Task Contract

契约 schemaVersion 为 1，顶层只允许：

- `classification`：kind、confidence、reasons、requiresPrd。
- `runtimeContext`：四个来源固定为 Session 或持久化设置。
- `source`：fileName、version、sha256、modifiedAt、selectedBy；无 PRD 时为空元数据。
- `goal`、`inScope`、`outOfScope`、`dod`、`evidence`、`risks`、`assumptions`。
- `missingFields`、`inferredFields`。
- `humanGate`：required 和 reason。

等级与最小字段：

| 等级 | 字段与行为 |
|---|---|
| `direct` | 仅 Goal；范围、DoD、Evidence 为空；不创建 Workflow |
| `light` | Goal、最小 DoD、Evidence；默认值必须记入 `inferredFields` |
| `standard` | Goal、In/Out of Scope、DoD、Evidence |
| `project` | PRD 来源、完整范围、Phase、DoD、Evidence、风险；缺失项进入 `missingFields` |
| `high_risk` | 保留最小已知信息，`humanGate.required=true`，Workflow 暂停 |

Goal 优先级为用户明确输入、PRD 明确目标、受约束 AI 提炼。PRD 的安全和许可证边界进入 Out of Scope；测试、启动和验收信息进入 Evidence。缺少字段可以为空，不能为了填满契约而编造。

## API

### `GET /api/orchestration/prd/candidates`

优先使用 `sessionRef` 重新解析项目；兼容 `projectPath` 时仍执行允许根校验。响应只含候选元数据、`selectionRequired` 和唯一候选的 `autoSelectedPath`，不含内容。

### `POST /api/orchestration/intake/preview`

输入：`sessionRef`、可选 `goal`、`prdMode`（`auto/current/manual/none`）和可选 `prdPath`。输出 Session 安全元数据、Task Contract、候选、解析来源和 warning。无状态写入。

### `POST /api/orchestration/workflows/from-session`

兼容原入口并扩展 PRD 参数。返回状态：正常创建 `201`；high-risk 暂停 `202`；direct 旁路 `200`。响应包含 `bypass` 与 `requiresApproval`。

旧 `POST /api/orchestration/prd-draft` 保留原响应和错误语义。

## 失败与恢复

| 错误码 | 含义与恢复 |
|---|---|
| `PRD_SELECTION_REQUIRED` | 多个候选；UI 展示选择器，用户明确选择 |
| `PRD_NOT_FOUND` | 当前项目没有候选；可改为手动、无 PRD或直接填写 Goal |
| `PRD_PATH_REQUIRED` | 手动模式缺少路径 |
| `PRD_PATH_OUTSIDE_ALLOWED_ROOTS` | realpath 越界；拒绝读取 |
| `PRD_FILE_TYPE_UNSUPPORTED` | 不是 `.md`、`.mdx` 或 `.txt` |
| `PRD_FILE_TOO_LARGE` | 超过 5 MB |
| `TASK_GOAL_REQUIRED` | Goal 和 PRD 都没有明确目标 |
| `SESSION_TARGET_UNRESOLVED` / `SESSION_METADATA_UNVERIFIED` | Session 不能唯一、安全解析；停止创建 |

AI 请求失败或 Schema 不合法不是权限错误：丢弃 AI 结果，保留确定性解析，返回明确 warning。任何高风险分类都不会自动 dispatch。

## 验证

聚焦测试覆盖五级分类、缺失/推断/敏感字段、候选与只读边界、Markdown 解析、AI 回退、Session 重解析、Preview 无副作用、direct 旁路、high-risk 暂停、Workflow 快照、旧 API 兼容和前端动态状态。完整命令见 README 与实现计划。
