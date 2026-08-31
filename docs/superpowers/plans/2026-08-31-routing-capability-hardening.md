# Plan: harden routing capability discovery and verified dispatch

## Goal

让 Agent Board 在执行前以运行时真实返回的 Agent/Codex 模型目录为准，持久化模型版本与每个模型支持的推理强度，避免把不支持的值发送给子代理；同时修复真实联调暴露的发送后送达竞态，并隔离测试/多实例工作流数据。

## Steps

1. **Add failing tests for capability metadata and validation**
   - Extend catalog fixtures with model version and alternate reasoning-field shapes.
   - Verify normalized catalog preserves the model version and exact supported reasoning values.
   - Verify profile resolution rejects or safely falls back from an unsupported reasoning value instead of emitting it.

2. **Implement runtime capability discovery and safe profile selection**
   - Normalize the native `model/list` response using real model version and supported reasoning fields.
   - Make profile resolution select only a value supported by the selected model, with deterministic fallback to the model default or first supported value.
   - Keep catalog metadata persisted and visible to the existing settings/read APIs.

3. **Add failing test for post-send delivery visibility race**
   - Simulate the Codex JSONL user message becoming readable shortly after SEND.
   - Verify delivery verification waits within a bounded timeout and does not resend.

4. **Implement bounded delivery verification**
   - Add condition-based polling around the existing evidence reader.
   - Keep the existing single-read API behavior available for callers that need an immediate snapshot.

5. **Add failing test for workflow data-directory isolation**
   - Verify a runtime using `AB_DATA_DIR` writes to that directory instead of the process user profile.

6. **Implement data isolation and provider-key compatibility**
   - Resolve the default workflow path from `AB_DATA_DIR`.
   - Treat `ZHIPU_API_KEY` as the documented alias for `ZAI_API_KEY` in provider discovery and PRD generation.
   - Preserve explicit PRD path-boundary failures instead of silently reading another project’s PRD.

7. **Verify and package only if needed**
   - Run targeted tests, then the full test suite.
   - Run a read-only live Codex capability probe and report the discovered agent/model/reasoning metadata without exposing secrets.
   - Review the diff, commit only the tracked implementation/test/plan files, and leave historical untracked distribution directories untouched.
