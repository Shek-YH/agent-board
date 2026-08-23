# 每 Agent 完成提示音（B 布局）设计

## 目标

在设置中心提供独立的“提示音设置”详细页：左侧列出 AI Agent，右侧配置当前 Agent 在会话由进行中变为完成时播放的本地提示音。用户上传的文件和分配配置均持久化在项目 `public/sounds/`，方便后续再次选择或切换。

## 交互

- 设置中心的“提示音设置”跳转至 B 布局：左侧 Agent 列表，右侧当前 Agent 的声音库和详情。
- 每个 Agent 可选择“不播放”或声音库中任一音频，并可在右侧试听。
- 上传仅接受常见音频格式（wav/mp3/ogg/m4a/aac），文件名服务端重新生成，不能由客户端控制路径。
- 测试素材使用 `F:\360MoveData\Users\Administrator\Desktop\test\audio.wav`。

## 存储与 API

- 音频实体文件：`public/sounds/uploads/<随机文件名>.<扩展名>`。
- 声音索引及 Agent 分配：`public/sounds/sound-settings.json`；不写入令牌或其他用户数据。
- `GET /api/sounds` 返回声音库与每 Agent 分配。
- `POST /api/sounds/upload` 接收 JSON data URL，限制为 8 MiB，校验音频 MIME/扩展名后原子写入项目目录。
- `POST /api/sounds/assign` 仅允许存在的声音 ID 或空值（不播放）。
- 所有文件 API 都只使用服务端生成的文件名，静态资源由 `/sounds/...` 同源提供。

## 完成检测

现有 SSE `active` 快照已经检测“进行中 → 已完成”的迁移。该迁移保持原有绿色高亮，并额外查当前会话 Agent 的已分配提示音；仅对新迁移调用浏览器 `Audio.play()`，首次基线和刷新不会重复播放。

## 不在本轮

- 不同步音频到云端、不播放远程 URL、不实现全局音量/复杂音频编辑。
- 不实现 Electron 打包。
