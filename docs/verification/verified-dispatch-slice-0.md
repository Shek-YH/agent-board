# Verified Dispatch Slice 0 验证记录

日期：2026-08-30

## 自动化验证

- Node.js：`v24.11.0`。
- 定向测试：
  `node --test lib/verified-dispatch.test.js lib/codex-desktop-uia.test.js lib/hermes-desktop-uia.test.js lib/codex-delivery.test.js lib/hermes-delivery.test.js server-verified-dispatch.test.js`
  ——通过。
- 全量测试：`node --test` —— `684` passed，`0` failed。
- 额外覆盖：Verified target enrichment/alias serialization 测试通过。
- 语法检查：Verified Dispatch、Codex/Hermes UIA、Codex/Hermes delivery、`server.js` 均通过
  `node --check`。

## Slice 0 证据边界

- 编排阶段已固定为：
  `Resolve → Verify → Activate → Re-verify → Write → Draft Verify → Send → Delivery Verify`。
- 只允许 Codex Desktop 与 Hermes Desktop；不包含 Claude Code、模型路由或真实 API 调用。
- UIA 写入使用 ValuePattern + 读回；不使用剪贴板；发送后不自动重试，只返回 reconciliation 状态。
- Codex 送达证据限定为发送后目标 session JSONL 的新 user row；Hermes 限定为只读
  `state.db` 的目标 session 新 user message。
- Codex 桌面传输会把下划线记录为 `\\_`；送达校验只对该已观察到的转义做规范化，仍要求
  session、时间边界和完整消息精确匹配。

## 真实桌面验证

- Hermes Desktop 真实闭环成功，目标：
  `hermes:20260829_223353_ba2838`（标题：`Agent Board Hermes setup`）。
  二次复测使用唯一消息 `AGENT_BOARD_SLICE0_REAL_20260830_HERMES_RECHECK_OK`，窗口强锚点为
  `uia-session:20260829_223353_ba2838;window:1576004`，完成 `Write → Draft Verify →
  Send → Delivery Verify → Commit`，只发送一次，数据库送达 `messageId=4748`。
- Codex Desktop 真实闭环已执行一次，目标：
  `codex:01a0509c-0fc5-78f1-a593-b0abe1a01939`。UIA 写入、草稿回读和 Enter 发送成功；发送后
  JSONL 已出现目标 session 的 user row，Codex 也返回了确认。该 row 的下划线使用桌面传输
  转义 `\\_`，修复后的只读校验已确认 `delivered=true`、`transportNormalized=true`，没有重复发送。
- 本轮未使用 Claude Code；Slice 0 不需要模型推理调用，因此未调用阿里百炼 API。真实验证针对
  Codex Desktop/Hermes Desktop 的窗口、输入和本地持久化记录执行。
- 自动化测试失败或送达状态不确定时，编排器仍禁止重发，并返回 reconciliation 状态。
