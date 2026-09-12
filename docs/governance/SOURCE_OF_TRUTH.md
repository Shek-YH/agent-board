# Agent Board Source of Truth

## Active request

按 `Agent_Board_Architecture_Hardening_PRD.md` 分阶段开发 Agent Board，优先完成仍存在且可自动验证的 P0/P1 根因；不删除用户数据，不降低会话识别和 AutoPilot fail-closed 安全语义。

## Authoritative inputs

- Product requirements: `Agent_Board_Architecture_Hardening_PRD.md`（工作区外部输入）
- Execution constraints: `Agent_Board_Codex_Execution_Prompt.md`（工作区外部输入）
- Repository source of truth: 当前分支源码、测试与 `package.json`
- Current baseline: branch `codex/agent-board-architecture-hardening`, base HEAD `9f5d4be`

## Decisions

- 采用渐进式 Work Item，每个阶段独立测试和提交。
- 当前先做 watcher Range Read；不先迁移 JSON Store，不重写前端框架，不改 AutoPilot 安全语义。
- Storage backend 在没有备份、迁移 dry-run、回滚和真实 Windows 验证前保持 JSON 默认实现。
- 无法由当前环境证明的 Electron、Windows 安全软件和真实用户数据行为标记为人工验收，不宣称已验证。
