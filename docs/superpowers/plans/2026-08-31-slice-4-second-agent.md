# Plan: Slice 4 second-agent routing boundary

## Goal

验证 `ExecutionProfileRouter`/路由运行时不依赖 Codex 或 Claude 的专属分支；第二 Agent 由适配器显式声明能力。对于当前 Hermes 适配器已验证但尚无安全模型切换接口的事实，采用“提示词/基础托管可用，模型路由明确跳过”的降级策略，不伪造模型目录或模型切换结果。

## Steps

1. **Add failing tests for capability-based degradation**
   - Verify an injected second-agent capability without model switching is reported as unsupported for execution routing.
   - Verify the router does not call profile detection or profile application for that capability, and keeps the base workflow on `continue`.
   - Verify profile-test API behavior is also fail-closed for a prompt-only capability.

2. **Implement the generic routing boundary**
   - Gate profile routing on the generic capability contract (`applyProfile`/`applyModel`), without agent-name checks.
   - Keep Codex catalog-unavailable behavior unchanged.

3. **Declare Hermes' current routing capability in its adapter**
   - Expose an immutable prompt-only capability declaration from `lib/adapters/hermes.js`.
   - Pass that declaration through `createOrchestrationRuntime` in `server.js`.
   - Keep all Hermes-specific behavior outside the core routing runtime.

4. **Verify and package**
   - Run Hermes and routing tests, then the full `npm test` suite.
   - Rebuild the Windows NSIS package and run `desktop:verify` against the unpacked app.
   - Review the diff, commit only tracked implementation/test/plan files, and leave all historical `dist-*` directories untracked.
