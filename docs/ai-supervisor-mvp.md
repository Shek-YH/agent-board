# Agent Board AI 监控与执行层 MVP

## 目标

Agent Board 保留原有“人工监控”面板，并增加独立的“AI 监控”面板。两个面板共享服务端工作流状态和 SSE 事件，但职责不同：

- 人工监控：查阅会话、筛选项目、打开 Agent 桌面端或具体会话。
- AI 监控：查看 Jarvis 编排的工作流、项目识别结果、执行状态、模型能力和人工接管入口。

AI 监控不会通过桌面端窗口查找输入框。执行链使用 headless transport；当前 transport 默认关闭，只有显式配置后才允许启动已适配的 CLI。

## Jarvis 与执行层边界

Jarvis 是监督层，不应直接输出任意 Shell 命令。它提交结构化请求：

```json
{
  "projectPath": "C:\\Projects\\demo",
  "goal": "完成用户目标并通过项目验收",
  "mode": "project",
  "agent": "codex",
  "requestedBy": "jarvis"
}
```

Agent Board 随后自行读取文件系统并确定项目类型：

1. 路径不存在或为空目录：新项目。
2. 存在 `.git`：已有 Git 项目，进入维护流程。
3. 有项目文件但没有 `.git`：已有未版本化项目，初始化 Git 前必须人工确认。
4. 文件路径或无法访问的路径：拒绝执行。

确定性生命周期协调器负责目录、Git、允许根目录、脏工作树和控制租约。执行 Agent 只接收目标和受控工作目录，不能改变 transport 的可执行文件或参数结构。

## 两种接管模式

### 单个项目 AI 接管

工作流只绑定一个 `projectPath`。推荐作为 MVP 默认模式。它适合先验证“读取最新会话 → Jarvis 判断 → 执行 → 验收 → 继续/暂停”的闭环。

### 全局 AI 接管策略

全局模式表示策略范围，而不是立即接管电脑上所有历史会话。只有已登记、位于允许根目录、没有人工控制租约的项目才能进入队列。人工点击“接管”后，工作流状态变为 `paused`，AI 不得继续派发。

## 安全默认值

```text
AGENT_BOARD_ALLOWED_ROOTS=C:\\Projects;D:\\Work
AGENT_BOARD_HEADLESS_EXECUTION=0
```

建议先配置允许项目根目录并保持 headless 为 `0`，观察 AI 监控状态和人工接管流程；确认 Agent CLI 的实际参数、输出格式和验收方式后，再单独打开执行能力。

当前已适配 headless profile：`claude`、`codex`。其他 Agent 可以继续被人工监控，但没有 headless profile 时不会被当作可执行目标。

## API Key 准备矩阵：国内供应商优先

应用只在服务端读取环境变量，并在 AI 监控面板显示“可用/未配置”和供应商名称，不显示密钥原文。不要把 Key 粘贴到聊天、项目文件、浏览器 localStorage 或前端代码中。

首选组合是“阿里云百炼作为主供应商 + 智谱/火山/MiniMax 作为专项或故障切换供应商”：百炼的 Model Studio 已覆盖 Qwen 全模态实时/非实时交互、CosyVoice/Qwen TTS 与声音复刻、万相图像和视频；智谱覆盖 GLM-Realtime、GLM-ASR、GLM-TTS/TTS-Clone、视觉、图像和视频；火山方舟适合实时语音与 Seed 图像/视频；MiniMax 适合语音克隆、图像、视频和编程模型。

| 能力槽位 | MVP 是否必需 | 国内优先选型 | 环境变量 | 说明 |
| --- | --- | --- | --- | --- |
| Jarvis 监督模型 | 是，启用真正 AI 编排时 | 百炼 Qwen / 智谱 GLM / 火山方舟 / MiniMax | `DASHSCOPE_API_KEY` / `ZAI_API_KEY` / `ARK_API_KEY` / `MINIMAX_API_KEY` | 负责读取会话、结构化判断和下一步决策 |
| 流式语音转文字 | 语音 Jarvis 才需要 | 百炼 Qwen-Omni Realtime / 智谱 GLM-Realtime / 火山实时语音 | 同上前三项 | 低延迟语音输入，优先使用 WebSocket/WebRTC 服务端接入 |
| 非流式语音转文字 | 可选 | 百炼 Qwen-Omni HTTP / 智谱 GLM-ASR / 火山语音识别 | `DASHSCOPE_API_KEY` / `ZAI_API_KEY` / `ARK_API_KEY` | 上传录音、批量转写、回放校正 |
| 流式文生语音 | 语音 Jarvis 才需要 | 百炼 CosyVoice / 智谱 GLM-TTS / 火山语音 / MiniMax Speech | 四项均可 | 边生成边播放 |
| 非流式文生语音 | 可选 | 百炼 CosyVoice/Qwen-TTS / 智谱 GLM-TTS / MiniMax Speech | 四项均可 | 通知、总结、导出音频 |
| 语音克隆 | 后续能力 | 百炼 CosyVoice/Qwen-TTS-Clone / 智谱 GLM-TTS-Clone / MiniMax Voice Clone | `DASHSCOPE_API_KEY` / `ZAI_API_KEY` / `MINIMAX_API_KEY` | 另需合法音色样本和本人同意证明；不要默认开启 |
| 视觉理解 | 需要截图/界面验收时 | 百炼 Qwen-Omni / 智谱 GLM / 火山方舟 / MiniMax | 四项均可 | 读取截图、构建结果和 UI 验收证据 |
| 文生图 | 后续内容/设计任务 | 百炼万相 / 火山 Seedream / 智谱 CogView / MiniMax Image | 四项均可 | 不影响纯代码项目 MVP |
| 视频生成 | 后续内容/演示任务 | 百炼万相 / 火山 Seedance / 智谱 CogVideo/Vidu / MiniMax Video | 四项均可 | 异步任务、成本和存储要单独控制 |
| Embeddings | 知识库/长历史检索时 | 百炼 / 智谱 / 火山 | `DASHSCOPE_API_KEY` / `ZAI_API_KEY` / `ARK_API_KEY` | MVP 可先使用关键词和结构化索引 |
| Moderation | 对外语音/内容入口时 | 百炼 / 智谱 / 火山 | `DASHSCOPE_API_KEY` / `ZAI_API_KEY` / `ARK_API_KEY` | 对用户输入、语音转写和生成结果做安全审核 |

官方文档显示，百炼的 Qwen-Omni 支持实时音频/图像输入、文本/音频输出和 Function Calling，CosyVoice/Qwen TTS 支持实时与非实时合成和声音复刻，万相覆盖图像与视频生成；智谱的 GLM-Realtime 支持实时音视频和 Function Calling，GLM-ASR/TTS/Clone 覆盖语音链路；MiniMax API 也覆盖文本、视频、语音和图像，并提供音色复刻。[百炼全模态](https://help.aliyun.com/zh/model-studio/omni/)、[百炼实时模型](https://help.aliyun.com/zh/model-studio/realtime)、[百炼语音合成与复刻](https://help.aliyun.com/zh/model-studio/tts-model)、[百炼视频生成](https://help.aliyun.com/zh/model-studio/use-video-generation/)、[智谱模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)、[智谱 GLM-Realtime](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime)、[MiniMax API 准备](https://platform.minimaxi.com/docs/guides/quickstart-preparation)

模型名称不要写死在前端或工作流状态里，按“能力槽位 → provider → model”配置，便于模型下线或价格变化时替换。建议为高成本视频、语音克隆和批量任务设置独立预算/项目 Key。智谱官方示例使用 `ZAI_API_KEY`，火山方舟官方示例使用 `ARK_API_KEY`，MiniMax 官方文档使用 `MINIMAX_API_KEY`，百炼使用 `DASHSCOPE_API_KEY`。

## 已实现与未实现

已实现：

- 项目新建/维护/未版本化分类。
- 结构化执行计划和 JSON 工作流快照/事件记录。
- 项目控制租约、同项目互斥、人工接管暂停。
- 允许根目录、脏工作树、Git 初始化和 headless transport 安全边界。
- 服务端编排 API、SSE 工作流事件和人工/AI 双导航栏。
- API Key 能力探测，不回传密钥。

仍需在后续阶段接入：

- Jarvis 对话/语音入口到结构化请求的真实模型适配。
- 各 Agent 的稳定 headless 参数、流式输出解析和 session resume 适配。
- 验收器：测试、构建、截图、Git diff 和用户验收条件的组合。
- 失败重试上限、预算、超时、敏感操作审批和全局模式的项目登记策略。

当前 MVP 有意把 headless 执行默认关闭，先验证状态、接管和审计链，再开启真实 Agent 进程。
