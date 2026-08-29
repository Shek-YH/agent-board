# Jarvis 语音 MVP

## 目标

先跑通一条可验收链路：浏览器录音开关 → 国内 ASR → Jarvis 白名单意图判断 → WorkBuddy headless CLI → 简短摘要 → 国内 TTS 音频。

示例输入：

> 用 WorkBuddy 查一下明天深圳的天气

人工监控面板和 AI 监控面板仍然是两个独立导航目标。语音入口只出现在 AI 监控面板，不会打开桌面窗口，也不会模拟点击 WorkBuddy 输入框；它调用 WorkBuddy 自带的 `codebuddy/cbc --print --output-format json` 非交互入口。

## MVP 配置

建议先准备并配置以下变量：

```text
ZAI_API_KEY=你的智谱 API Key
AGENT_BOARD_ALLOWED_ROOTS=C:\Users\你的用户名\WorkBuddy
AGENT_BOARD_HEADLESS_EXECUTION=1
```

可选变量：

```text
AGENT_BOARD_WORKBUDDY_CLI=F:\Program Files (x86)\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy
JARVIS_STT_MODEL=glm-asr-2512
JARVIS_SUPERVISOR_MODEL=glm-4.7-flash
JARVIS_TTS_MODEL=glm-tts
JARVIS_TTS_VOICE=tongtong
AGENT_BOARD_JARVIS_PROJECT_PATH=C:\Users\你的用户名\WorkBuddy\某个项目
```

WorkBuddy CLI 路径通常可以从已探测到的 WorkBuddy 桌面端自动推导；只有自动探测失败时才需要手动设置。WorkBuddy 本身需要已经登录并具备可用的联网工具能力。

## 运行结果

- 前端只显示识别文本、简短摘要和返回音频。
- 完整转写、Jarvis 结构化意图、WorkBuddy 执行提示词和完整返回，写入目标项目：`.agent-board/sessions/<session-id>/session.md`。
- TTS 音频保存到 Agent Board 的本地数据目录，并通过本地 API 播放；不会把录音原文件长期存到项目中。
- 当前只允许 `weather_lookup`，执行 Agent 固定为 WorkBuddy；不接受模型输出的 shell 命令或其它 action。

## 当前边界

- 录音是“按下开始、再次按下结束”的非流式模式。
- 只支持今天、明天、后天的天气查询。
- 当前语音工作流按单项目执行；全局 AI 接管、单项目持续监控、多轮验收循环留到后续阶段。
- 没有配置 TTS 时，仍保留文字摘要和详细 session；浏览器会尝试使用本地语音合成作为临时 fallback。
- AI 监控默认仍然关闭 headless 执行，必须显式设置 `AGENT_BOARD_HEADLESS_EXECUTION=1`。

## 后续 API Key 准备

MVP 只需要 `ZAI_API_KEY`，同一个 Key 覆盖本阶段的 ASR、Jarvis 文本判断和 TTS。为了后续扩展，建议提前申请但不要在没有功能需求时全部启用：

- `DASHSCOPE_API_KEY`：后续可接 Qwen ASR、实时语音、TTS、声音复刻和视频能力。
- `ARK_API_KEY`：后续可接火山方舟的文本、语音、视觉、图像和视频模型。
- `MINIMAX_API_KEY`：后续可接语音、声音克隆、图像和视频能力。

这些 Key 只由服务端读取，能力面板只显示是否配置，不回传 Key 内容。
