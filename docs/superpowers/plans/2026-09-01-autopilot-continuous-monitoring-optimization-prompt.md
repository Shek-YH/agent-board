# AutoPilot 多轮任务持续监控优化提示词

请帮我优化 Agent Board 的 AI 托管多轮任务功能。

现在有一个问题：托管状态下，Agent Board 已经成功把第一条信息发送给 Codex，Codex 也已经回复了第一轮，但中控没有继续给它发送下一轮指令。看板上能看到最新的 Agent 回复，可是 Workflow 一直停在“等待 Agent”，没有继续推进。

请重点排查并修复这条链路：

`Agent 回复 → 对话采集 → 回复被识别 → AutoLoop 复核 → 生成下一轮指令 → 验证发送 → 再次等待回复`

不要只修复页面显示。要确认后端真的能够在收到新回复后继续执行下一轮，并且重启服务后仍然可以恢复。

请先阅读项目根目录的 `AGENTS.md`、`README.md`、`docs/HANDOFF.md`，以及现有 AutoPilot、Verified Dispatch、Completion Detector、Hosted Agent 和 Workflow 相关实现。先检查当前工作区和测试结果，不要覆盖已有用户改动，也不要修改或加入任何 `.workbuddy`、`Microsoft`、`dist-*` 等未跟踪目录。

这次只使用现有架构，不要重新引入消息队列、WebSocket 框架或新的监控框架。优先复用现有的 Agent adapter、store、SSE、AutoLoop、定时 reconcile 和 Completion Detector。

需要确认以下问题：

1. Agent adapter 是否已经把最新 assistant 回复写入 store。
2. 对话采集成功后，是否会触发 AutoLoop 的 reconcile，还是只有 UI 收到 SSE 更新。
3. AutoLoop 是否只执行了一次 `run`，之后没有被再次唤醒。
4. `lastAgentMessageId`、`lastHandledAgentMessageId`、`lastSentMessageId` 是否正确更新。
5. 回复的 `source_id`、指纹和时间是否能用来判断这是当前发送之后的新回复。
6. Codex 没有显式 `task_complete` 或 `runtime_status` 时，是否会错误地一直等待。
7. 当前运行的后端是否可能是旧实例，或者定时器启动后异常被静默吞掉。

正确的行为应该是：

- 发送第一轮指令后，Workflow 进入 `WAITING_AGENT`。
- 中控持续读取绑定的同一个 Agent、同一个 Session、同一个项目的最新状态。
- 发现发送之后出现新的 assistant 回复时，必须执行一次安全的 reconcile。
- 普通问题、页面布局、文案、功能取舍等问题，不需要人工确认时，由 Supervisor 采用最小可验证方案自动生成下一轮指令。
- 普通问题被处理后，必须标记 `lastHandledAgentMessageId`，防止同一条回复重复触发发送。
- 下一轮指令发送成功且送达验证通过后，`runCount` 增加，Workflow 继续等待下一条回复。
- 当前回复已经被处理过、回复不是当前发送之后产生的、目标 Session 不唯一、身份无法验证、权限不足、送达结果不确定或发送结果不确定时，必须停止继续发送，不能自动重试。
- Agent 明确报告 `WAITING_FOR_HOST`、安全边界、需要人工确认、权限不足或不可验证风险时，Workflow 必须进入暂停或 `NEED_HUMAN`，不能自动绕过。
- Agent 报告普通问题时，不要把它误判成最终完成，也不要因为它提出问题就无限等待人工回复。
- 只有 Supervisor 判定完成，并且 DoD 和 Evidence 都验证通过时，才能进入 `DONE`。
- “Session 已完成”只是看板中的会话活跃状态，不能直接当作 Workflow 完成；两者必须分开处理。

建议采用“事件触发 + 定时兜底”的方式：

- Agent adapter 采集到新的 assistant 消息后，可以触发一个经过防抖和串行锁保护的 Workflow reconcile。
- 保留现有的周期性 reconcile，防止文件监听丢事件、服务重启或进程异常。
- 同一个 Workflow 同时只能有一个 reconcile/run 在执行。
- reconcile 失败时不能静默丢失，应持久化安全的错误码和阻塞原因，但不得记录完整 Prompt、Agent 回复、Token、Cookie、密码或 `.env` 内容。
- 只允许匹配当前 Workflow 的精确 `sessionRef`、Agent 和项目路径，不能因为找不到目标就选择最近的其他 Session。
- 任何新回复都必须经过身份、权限、策略、发送记录和送达状态校验。

请优先检查这些位置：

- `lib/store.js`
- `lib/adapters/codex.js`
- `lib/orchestrator/auto-loop.js`
- `lib/orchestrator/completion-detector.js`
- `lib/orchestrator/hosted-agent.js`
- `lib/orchestrator/workflow-store.js`
- `lib/orchestrator/runtime.js`
- `lib/orchestrator/http.js`
- `server.js` 中的 watcher、scan、SSE 和 AutoPilot 初始化代码

请按 TDD 完成：先写能够复现“第一轮回复已经入库，但下一轮没有触发”的失败测试，再实现修复。测试必须使用 fake store、fake adapter、fake completion detector、fake runner 或 fake timer，不要启动真实 Codex、Claude Code、WorkBuddy 或其他外部 Agent。

至少补充这些测试：

- 最新 assistant 回复已经入库时，绑定的 Workflow 能被 reconcile。
- 第一轮回复被识别后会自动生成并发送第二轮指令。
- 普通 Agent 问题会自动决策，不会一直等待人工。
- `WAITING_FOR_HOST`、安全边界和权限问题会暂停，不会继续发送。
- 没有新回复时不会发送下一轮。
- 同一条回复被重复采集时不会重复 reconcile 或重复发送。
- 历史旧回复不会触发当前 Workflow 的下一轮。
- 多个 Agent 或多个 Session 存在时不会误匹配其他目标。
- 发送成功但送达无法验证时不会重发。
- 发送状态不确定时不会自动重试。
- AutoLoop 定时器异常不会让 Workflow 永久无声失败，状态中要保留安全阻塞原因。
- 服务重启后，处于 `WAITING_AGENT` 的 Workflow 仍能恢复监控并继续推进。
- 旧版单 Agent Workflow、handoffChain、Codex 和 Hermes 现有行为不回归。
- 日志、UI、Workflow 持久化数据和模型输入中都不会出现完整回复、Prompt、Token、Cookie、密码或完整 `.env` 内容。

验收时请使用一个与当前问题相同的测试流程：

1. 创建一个开启 AI 托管的 Codex Workflow。
2. 发送第一轮指令。
3. fake Agent 写入一条 assistant 回复，回复内容可以是一个普通问题。
4. 确认中控能够发现这条新回复，并且只发送一次下一轮指令。
5. 再次重复采集同一条回复，确认不会重复发送。
6. 重启或重新创建 AutoLoop，再确认 Workflow 可以继续监控。

完成后请报告：

- 发现的真正断点是什么；
- 修改了哪些文件；
- 下一轮触发采用了事件、定时器还是两者结合；
- 如何保证不重复发送；
- 如何处理普通问题、NEED_HUMAN、送达不确定和目标不唯一；
- 新增和执行了哪些测试；
- 是否验证了服务重启恢复；
- 仍然存在的限制和安全风险。

不要部署、发布、Git push、自动安装依赖，也不要执行真实外部 Agent 命令。完成代码后运行 `npm test` 和 `git diff --check`，如果修改了打包相关内容，再运行对应的 package verify。
