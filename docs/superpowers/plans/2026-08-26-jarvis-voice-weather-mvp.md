# Jarvis 语音天气查询 MVP

## 目标

在 Agent Board 的 AI 监控面板内跑通一条可验证的最小闭环：

1. 用户打开录音开关并说“用 WorkBuddy 查一下明天深圳的天气”。
2. Agent Board 将录音交给国内语音识别服务，得到文字。
3. Jarvis 将文字解析为受限的结构化意图，只允许天气查询这一种 MVP 动作。
4. Agent Board 通过 WorkBuddy 随附的官方 `codebuddy/cbc` 非交互 CLI 在目标项目目录执行只读查询。
5. 把完整转写、意图、执行提示词、WorkBuddy 原始结果和时间线落到项目目录的 Agent Board session 文件中。
6. 用国内 TTS 生成一段简短汇总音频，返回给前端自动播放；详细结果留在 session 文件及 AI 工作流记录中。

## 边界与安全约束

- 第一版采用“按下开始、再次停止”的非流式录音，不实现实时双工与打断。
- API Key 只在 Node 后端读取，浏览器永不接收密钥。
- Jarvis 输出不得携带 shell 命令；服务端只根据白名单意图拼接固定的 WorkBuddy 查询提示词。
- WorkBuddy CLI 使用固定 executable/参数结构、`shell: false` 和受控项目目录；默认不允许任意 Agent 变成任意命令。
- 项目目录必须落在 `AGENT_BOARD_ALLOWED_ROOTS` 内。新目录可按既有项目生命周期规则创建并初始化 Git；既有项目不修改代码。
- 音频大小、MIME、项目路径、输出文件名均做限制；详细结果只写入目标项目的 session 子目录，不写入前端可执行脚本。
- 人工监控与 AI 监控继续共用会话采集和工作流状态，但录音入口只存在 AI 监控面板，避免两个面板重复触发同一任务。

## 技术方案

- 前端：原生 `MediaRecorder`，录音按钮位于现有 AI 监控面板；复用项目路径字段，展示转写、执行状态、汇总文字和音频播放器。
- ASR：第一实现接入智谱 GLM-ASR 的非流式 multipart HTTP 接口，默认模型 `glm-asr`；保留 provider seam，后续可接百炼 Qwen3-ASR。
- Jarvis：第一实现使用国内 OpenAI-compatible chat API 输出受限 JSON 意图；解析失败或模型未配置时不执行 WorkBuddy。
- 执行层：扩展现有 headless transport，解析 WorkBuddy 安装目录对应的 `resources/app.asar.unpacked/cli/bin/codebuddy`，支持显式路径覆盖。
- TTS：第一实现接入智谱 GLM-TTS 非流式 WAV 接口；未配置时返回文字并提示前端使用浏览器语音兜底，但不伪造“已生成音频”。
- 持久化：新增 Jarvis session 目录和索引字段，不改变人工监控原有 `data.json` 会话采集结构；AI 工作流继续使用现有 `WorkflowStore`，防止两个导航栏产生两套事实源。

## 实现步骤与验证

1. 扩展 WorkBuddy headless profile 和安装路径解析。
   - 验证：单元测试确认固定参数、非 shell、路径覆盖和真实安装目录推导。
2. 新增 Jarvis voice MVP 后端服务。
   - 验证：测试 MIME/base64/路径校验、意图白名单、天气提示词、CLI JSON 结果解析、session 原子落盘和 TTS 响应解析。
3. 接入 `/api/jarvis/voice` 与 readiness 状态。
   - 验证：HTTP 测试确认未配置时安全失败、不泄漏 API Key、成功路径能创建工作流并返回音频元数据。
4. 在 AI 监控面板增加录音开关和结果区域。
   - 验证：前端静态测试确认只调用 Jarvis voice API，不调用桌面打开/跳转接口；按钮状态与音频播放逻辑存在。
5. 更新文档中的最小配置、模型与运行验收清单。
   - 验证：`npm test` 全量通过；在配置 API Key 后再进行一次真实手工验收。

## 暂不纳入 MVP

- 流式 ASR/TTS、语音唤醒词、持续监听、打断与全双工。
- 多 Agent 并行编排、自动验收循环、全局接管策略执行。
- 语音克隆、文生图、视频生成、长期记忆和复杂任务规划。
- 逆向依赖 WorkBuddy 私有 Electron IPC；只使用其随附 CLI 的公开帮助中确认的非交互入口。
