# 模型端口设置：自动识别与手动桌面端切换设计

日期：2026-08-25

## 目标

把当前“每个 Agent 填一条自定义启动命令”的设置改成可直接点击的启动方式切换：系统优先为每个 Agent 自动找到 CLI 和桌面端的目标位置/协议/命令，用户只需要点击要用的端口；当某个 Agent 存在多个桌面端时，用户可以勾选手动方式并填写指定目标。

## 现状与约束

- 项目是 `agent-board`，使用 Node.js 内置 HTTP 服务和原生 JavaScript 前端，无构建步骤、无新增 npm 依赖。
- 当前已经存在 `lib/detect.js` 的 CLI/桌面安装探测，以及 `lib/*-desktop-path.js`、协议和启动脚本等 Agent 专用启动逻辑。
- 当前 `~/.agent-board/launch-overrides.json` 以 `{ agent: command }` 保存自定义启动命令。本次保留文件位置，并兼容旧格式。
- 用户明确要求方法 1 与方法 2 互斥，方法 2 的优先级高于方法 1。

## 用户界面

“设置 → 模型端口设置”打开一个可滚动面板。每个 Agent 使用一张紧凑卡片，结构如下：

```text
● Codex
已找到 CLI：codex.cmd  ·  未找到桌面端
[切换到 CLI] [桌面端未找到]
────────────────────────────
□ 手动指定桌面端
[目标位置或运行指令________________]
[保存并切换到桌面端]
```

### 方法 1：自动识别

- 卡片直接展示“切换到 CLI”和“切换到桌面端”两个入口。
- 按钮下方展示已解析出的实际目标，例如 CLI 路径、桌面端 exe、协议或启动命令的简短说明；不要求用户理解命令格式。
- 自动目标可用时按钮可点击；目标不可用时按钮置灰并显示“未找到”。
- 对只有一个可用方式的 Agent，只让这一方式可点击，并显示“当前只找到一种启动方式”；不人为制造第二个配置项。
- 点击自动按钮时，前端只提交 `{ agent, target: 'cli' | 'desktop' }`，目标解析和启动全部由服务端完成。

### 方法 2：手动指定桌面端

- 在“手动指定桌面端”文字前放勾选框。
- 未勾选时：方法 2 不生效，方法 1 的按钮可用。
- 勾选时：方法 2 立即成为该 Agent 的唯一生效方式，方法 1 的两个按钮置灰；如果目标为空，显示“请先填写桌面端路径或命令”，不执行任何启动。
- 手动目标输入框支持：
  - Windows `.exe` 路径，例如 `C:\Users\Administrator\AppData\Local\Programs\DSH Desktop\DSH Desktop.exe`；
  - `.cmd` / `.bat` 脚本路径；
  - 可以由 `cmd.exe /c` 执行的命令行。
- 点击“保存并切换到桌面端”时保存目标并立即执行；保存后再次打开面板，勾选状态和目标原样回显。
- 取消勾选只关闭方法 2，不删除已保存的目标；再次勾选仍可恢复使用。
- 手动方式的执行优先级在服务端强制实现，不能只依赖前端禁用按钮。

## 自动目标解析

新增统一的启动目标解析层，复用现有实现，不把 Agent 专用逻辑复制到前端：

- CLI 目标：调用现有 adapter 探测器，返回真实命中路径；对于 `.cmd` shim，保留用 `cmd.exe /c` 执行的兼容方式。
- 桌面端目标：按 Agent 使用已有的协议、exe 路径解析器、注册表协议解析或启动脚本。当前映射为：
  - Claude Code、Codex、WorkBuddy：使用现有协议启动方式；
  - DeepSeek Harness：使用现有 Desktop exe 解析器；
  - Marvis、ZCode：使用现有启动器/启动脚本；
  - Pi Agent、Hermes Agent：使用现有 Desktop exe 解析器。
- 每个目标返回统一结构：`available`、`label`、`detail`、`kind` 和内部启动所需的安全参数。前端只展示 `label/detail`，不拼接命令。
- 目标探测失败只影响对应按钮，不阻塞整个设置面板；接口仍返回其他 Agent 的结果。

建议新增 `GET /api/launch-targets`，返回全部 Agent 的自动目标和手动配置状态：

```json
{
  "targets": {
    "hermes": {
      "cli": { "available": true, "label": "CLI", "detail": "hermes-agent" },
      "desktop": { "available": true, "label": "桌面端", "detail": "Hermes.exe" },
      "manualDesktop": { "enabled": false, "target": "" }
    }
  }
}
```

## 数据与接口

继续使用 `%USERPROFILE%\.agent-board\launch-overrides.json`，新格式按 Agent 保存：

```json
{
  "hermes": {
    "manualDesktop": {
      "enabled": true,
      "target": "C:\\Program Files\\Hermes\\Hermes.exe"
    }
  }
}
```

读取时兼容旧值 `{ "pi": "some-command" }`：将其解释为 `manualDesktop.enabled = true` 且 `target = "some-command"`。保存新值时使用对象格式，不影响其他 Agent 的配置。

保留现有接口路径，但扩展请求格式：

- `GET /api/launch-overrides`：返回归一化后的手动配置，供兼容调用方使用。
- `POST /api/launch-overrides`：接收 `{ agent, enabled, target }`；`enabled=false` 只取消优先级，保留 `target`；`target` 为空时清除该 Agent 的手动配置。
- `POST /api/launch-agent`：接收 `{ agent, target }`。服务端先检查该 Agent 的手动桌面端是否启用且目标非空；是则无条件执行方法 2，忽略请求中的自动目标；否则执行请求指定的方法 1。

手动目标执行规则：目标是已存在的 exe/脚本文件时直接启动；否则作为命令交给隐藏的 `cmd.exe /c` 执行。子进程使用 `stdio: 'ignore'`、`windowsHide: true`、`detached: true`，避免残留控制台窗口。

## 错误处理

- 自动探测不到目标：按钮置灰，显示原因；不弹出复杂错误堆栈。
- 手动勾选但目标为空：不保存为可执行状态，不启动，提示用户先填写目标。
- 手动目标路径当前不存在：允许保存为命令/未来安装路径，但点击执行时返回明确的“目标无法启动”提示；服务端不执行任意 URL 或拼接未经处理的参数。
- 文件读取、JSON 损坏或字段类型不正确：降级为空手动配置，不能阻塞首页和其他 Agent。

## 测试

- `lib/launch.test.js`：覆盖旧字符串格式归一化、新对象格式读写、只取消 enabled 不删除 target、空目标清除配置。
- 新增启动目标测试：覆盖 CLI 命中路径、桌面端路径/协议目标、只有一种目标、探测失败不影响其他 Agent。
- 启动优先级测试：手动启用时自动请求也必须执行手动目标；手动关闭时恢复自动目标；手动目标为空时不启动。
- 前端静态测试：覆盖每个 Agent 的两个自动按钮、手动勾选框、方法 2 优先文案、取消勾选恢复方法 1 的交互绑定。
- 最终运行 `node --test`，并人工验证：
  1. 未勾选时点击 CLI/桌面端，走自动目标；
  2. 勾选 Hermes Agent 的手动桌面端，填写一个可验证的 exe，保存后点击只走手动目标；
  3. 取消勾选后点击自动按钮，确认恢复自动目标；
  4. 清空手动目标并保存，确认配置可恢复默认。

## 不在本次范围

- 不增加通用的进程管理器或后台常驻检测。
- 不改变会话卡片已有的深链接逻辑；只统一顶栏/设置面板的启动目标选择，并让共享服务端入口尊重手动优先级。
- 不把用户输入的路径上传到网络或写入项目仓库。
