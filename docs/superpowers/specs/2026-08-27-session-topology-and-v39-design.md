# Agent Board：Session 拓扑与 v3.9 探测修复设计

日期：2026-08-27  
状态：已确认，进入实施

## 1. 目标

让 Agent Board 的 session 卡一眼区分主会话、独立子代理和暂时无法确认的会话，并为后续 AI 托管提供一个不会误选子代理的主会话定位入口。同时完成 `反馈\\v3.9` 中应用探测、手动路径配置和启动链路修复，并把 session 卡的项目路径改为只显示最后一级文件夹。

## 2. 现状与关键判断

当前看板把会话身份压缩为 `agent:session_id`，状态与拓扑关系没有分开。Claude 适配器已经读取 `isSidechain`，但只用它排除子代理的回合结束信号；Claude 的子代理文件位于父会话目录下的 `subagents/agent-*.jsonl`，文件中的 `sessionId` 仍可能是父会话 ID，因此现有解析会把子代理消息并入主会话。ZCode 的数据源已经有 `task_type=interactive|subagent_child`，但当前扫描直接过滤掉了子代理。Codex、DeepSeek、WorkBuddy、Marvis、Pi、Hermes 当前适配器没有可靠的子代理关系字段，不能假装已经完成精确识别。

因此本设计区分三件事：

- `session_role`：这个卡是 `main`、`child` 还是 `unknown`；
- `child_detection`：当前 Agent 是否有已验证的子代理识别能力；
- `control_eligibility`：未来 AI 是否允许把它作为指令目标。状态 `active/done/failed` 仍保持现有含义，不与拓扑角色混用。

## 3. 拓扑模型

在现有 JSON session 存储上增加向后兼容字段：

```json
{
  "session_role": "main|child|unknown",
  "parent_session_ref": "claude:parent-id",
  "root_session_ref": "claude:root-id",
  "topology_source": "explicit|structural|unsupported|manual",
  "topology_confidence": 1,
  "child_detection": "verified|unsupported",
  "control_eligibility": "eligible|manual_only|blocked|unknown"
}
```

`session_role=child` 只在来源给出明确证据时使用；无法确认时使用 `unknown`，不能靠标题、最近活跃时间或 session ID 命名猜测。`session_role=main` 表示当前来源把该记录视为顶层可恢复会话；若该 Agent 尚未支持子代理识别，仍要在 `child_detection=unsupported` 中明确暴露限制，自动控制默认降级为 `manual_only`。

对 Claude 这类“子代理可能是独立日志文件，也可能是主日志中的 sidechain 片段”的来源，解析层要保留两种形态：独立 `subagents/agent-*.jsonl` 生成 child session；同一主文件内的 `isSidechain` 只累计为主卡的 sidechain 活动，不把整张主卡错误标成 child。独立 child 的 `parent_session_ref` 从日志中的父 `sessionId` 得到，child 自己的稳定 ID 使用父 ID 与 `agentId` 组合生成。

## 4. 各 Agent 的识别能力

| Agent | 当前证据 | 本轮行为 | 自动控制 |
|---|---|---|---|
| Claude Code | `subagents/` 文件路径、`agentId`、`isSidechain` | 独立子代理拆成 child；主会话保留 sidechain 统计 | 主会话可用，child 禁止 |
| ZCode | SQLite `session.task_type` | `interactive` 标 main，`subagent_child` 标 child，其余 unknown；不再过滤 child | 主会话可用，child 禁止 |
| Codex | 当前 rollout 文件是顶层 session，但适配器没有稳定 parent/child 字段 | 标 main，同时声明 `child_detection=unsupported` | `manual_only` |
| DeepSeek Harness | 当前 session 文件格式无 parent/child 字段 | 标 main，声明 unsupported | `manual_only` |
| WorkBuddy | 当前项目日志/心跳格式无 parent/child 字段 | 标 main，声明 unsupported | `manual_only` |
| Marvis | 当前 SQLite conversation 记录无 parent/child 字段 | 标 main，声明 unsupported | `manual_only` |
| Pi | 当前 JSONL session 文件无 parent/child 字段 | 标 main，声明 unsupported | `manual_only` |
| Hermes | 当前 SQLite session 记录无 parent/child 字段 | 标 main，声明 unsupported | `manual_only` |

这张表不是永久结论，而是适配器能力声明。后续某个 Agent 出现稳定字段时，只改它自己的 adapter 和测试，不把供应商差异塞进前端。

## 5. 看板展示

每张 session 卡的第一行增加文字徽标：

- `◎ 主会话`：绿色；
- `↳ 子代理`：紫色，并显示父会话标题或 ID；
- `? 未确认`：灰色，并提示不能作为自动控制目标。

颜色只做辅助，文字和关系线是主要信息。主卡显示 `子代理 N · 运行中 M` 汇总；独立 child 卡保留在看板中，但用缩进、关系线和父会话信息表达层级。详情抽屉展示完整拓扑字段。非 Claude/ZCode 的卡片继续可见，但显示“子代理识别未支持”的提示，避免用户误以为已完成全量识别。

项目路径显示从完整路径改为最后一级目录名，完整路径继续放在 `title` 属性和复制项目路径操作中。根目录、末尾分隔符、Windows 驱动器根和 POSIX 路径都要有稳定结果。

## 6. 主会话严格定位接口

新增纯函数 `resolveControlTarget`，输入项目路径、可选 Agent、可选指定 session ref 和当前 session 集合，输出以下状态之一：

```json
{
  "status": "resolved|ambiguous|not_found|blocked",
  "target": { "sessionRef": "claude:...", "role": "main" },
  "candidates": [],
  "evidence": [],
  "reason": "..."
}
```

解析顺序是：先拒绝 child 目标；再使用显式 root/parent 关系；再按规范化项目路径和 Agent 过滤；最后只允许唯一的 `control_eligibility=eligible` 主会话。多个候选返回 `ambiguous`，不使用现有 `resolveAgentRef` 那种“最近活跃会话”兜底，因为该兜底适合 hook 兼容，不适合 AI 自动控制。当前只提供只读定位能力和测试，不向 Agent 发送真实指令。

未来发送指令时，命令必须携带 `targetSessionRef`、`expectedLastSeen`、`evidenceSessionRefs`、`requestedBy` 和幂等键；人工接管、控制租约和版本变化会使命令失效。子代理只作为证据和结果汇总来源，默认不能接收主任务指令。

## 7. v3.9 应用管理修复

保留 `tool-paths.json` 旧的 string/array CLI 格式，同时支持 `{cli:[], desktop:[]}`。桌面端手动路径和 CLI 路径分开探测、保存和展示；手动路径优先于内置路径，并提供清除后恢复自动探测的入口。

具体修复包括：

- DeepSeek Desktop 增加自定义路径、注册表线索和可执行文件名；解析不到真实文件时不再返回一个不存在的候选路径；启动解析读取桌面端手动覆盖；
- Marvis 增加真实安装目录、注册表线索和 `Marvis.exe` 探测；启动路径候选补充 `Program Files` 与 `Program Files (x86)`；
- 新增 `POST /api/agents/:id/override-path`，支持 `cli`/`desktop`，绝对路径和 `.exe/.cmd/.bat` 校验，不存在的路径允许保存但返回警告；
- 应用管理卡片展示手动配置来源，支持填写、保存、清除，并可选同步已有桌面启动覆盖；
- 现有自动配置、重新探测、模型端口设置和官方下载流程保持兼容。

## 8. 验证标准

必须通过：session 拓扑归一化、Claude child 文件拆分、ZCode child 不丢失、主会话严格定位的单元测试；项目路径最后一级显示测试；各 Agent 能力声明测试；v3.9 中 DeepSeek/Marvis 自动探测和手动路径覆盖测试；应用管理前端契约测试；最后运行完整 `npm test` 和 `git diff --check`。不会把真实用户路径或密钥写入测试配置。
