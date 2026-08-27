---
name: agent-board-safe-slimming
description: 安全瘦身 Agent Board 项目工作目录，删除可重建的构建产物、重复发布包、开发缓存和临时文件，同时保留源码、测试、运行资源、许可证和项目正常运行所需内容。只要用户提到 Agent Board 目录变大、项目瘦身、清理 dist/node_modules、删除冗余内容、保留可运行版本或希望以后自动安全清理，就使用此 Skill。先审计和生成删除清单，再执行可回滚清理；严禁未经确认删除用户数据、Agent 会话、配置、凭据或整个工作区。
compatibility: Windows PowerShell 5.1+、Node.js；源码测试使用项目既有的 node --test 命令。
---

# Agent Board 安全瘦身

这个 Skill 的目标是让项目目录变小，同时保持源码运行、测试和用户选定的发布产物可用。它不是“清空目录”工具，也不是通用的磁盘清理器。

## 绝对边界

1. 只操作用户明确指定的 Agent Board 项目根目录。默认项目根目录必须同时包含 `package.json`、`server.js`、`lib/`、`public/` 和 `.git/`；不能把父级 `WorkBuddy` 工作区当作项目根目录。
2. 永远不删除或移动：父级工作区、`.git/`、源码、测试、`lib/`、`public/`、`desktop/`、`tools/`、`skills/`、`LICENSE`、`package.json`、`package-lock.json`、用户明确指定的发布包。
3. 永远不触碰用户运行数据和凭据目录：`%LOCALAPPDATA%\\AgentBoard`、`%USERPROFILE%\\.agent-board`、`.claude`、`.codex`、`.workbuddy`、各 Agent 的会话目录、`.env`、密钥、数据库和日志数据。
4. 不使用针对项目根目录的 `Remove-Item -Recurse`、`rm -rf`、`git clean -fdx` 或通配符递归删除。每个删除目标必须先解析为绝对路径，并验证它位于项目根目录内且不是项目根目录本身。
5. 不结束所有 Node 进程。不为清理强行停止 Agent Board、看门狗或其他 Agent；遇到文件锁就报告并跳过。
6. 删除默认采用“移入项目外隔离目录”的可恢复方式。永久删除必须由用户在看到清单和验证结果后明确要求。

## 保留策略

默认保留：

- 源码、测试、前端资源、桌面端代码和项目脚本；
- `package.json`、`package-lock.json`、`.git/`；
- `README.md`、`LICENSE` 和运行/分发必需文档；
- `runtime/node.exe` 和 `tools/wf.dll`，因为桌面打包流程可能需要它们；
- `public/downloads/*.skill` 等用户明确需要的下载资源；
- 用户指定的最新安装包或发布文件。

可重建但不能默认直接删除，必须列入计划并说明影响：

- `node_modules/`：删除后源码服务和 `node --test` 通常仍可运行，但 `desktop:dev`、`desktop:dist` 需要重新 `npm install`；
- `runtime/`：删除后桌面打包需要重新准备内置 Node；
- `dist/win-unpacked/`：可由桌面构建重新生成，删除后不能直接执行 `desktop:verify`，需要下次重新构建；
- 旧安装包、ZIP、blockmap、builder 调试文件和 `.icon-ico/`：仅在用户确认保留哪个发布版本后清理。

优先识别和清理：

- `dist/win-unpacked/` 与安装包 ZIP 的重复构建产物；
- 旧版本或同版本重复的安装包；
- `.icon-ico/`、`builder-debug.yml` 等可重建构建中间物；
- `coverage/`、`out/`、`build/`、`.cache/`、临时转储和测试生成物；
- 不影响源码运行的开发依赖缓存，但必须明确说明需要重新安装依赖。

不要按文件扩展名删除运行时内容。Electron、Node、DLL、插件、字体、locale、打包资源只能依据构建结构和验证结果处理。

## 工作流程

### 1. 只读审计

执行前记录：

- 项目根目录绝对路径和 Git 状态；
- 顶层目录和每个候选目录的文件数、总大小；
- 最大文件；
- 当前运行方式：源码 server、Electron 开发版、看门狗或已生成的安装包；
- `package.json` 中的测试、开发和构建脚本；
- 已有发布产物的版本、时间、哈希和用户要求保留的文件。

先运行源码测试：

```powershell
node --test
```

如果存在 `dist/win-unpacked/`，在清理前运行：

```powershell
node tools/verify-package.js dist/win-unpacked
```

测试失败时停止瘦身，先报告失败；不要把失败归因于待清理文件。

### 2. 生成清单和影响说明

为每个候选项标记：

- `KEEP_REQUIRED`：运行、测试、构建或合规必需；
- `KEEP_USER_SELECTED`：用户明确要保留；
- `REBUILDABLE`：可重建，但删除后会影响哪些命令；
- `DUPLICATE_ARTIFACT`：与保留产物重复；
- `BLOCKED_LOCKED`：被进程或安全软件锁定；
- `UNKNOWN`：无法证明安全删除，必须保留。

删除清单必须使用明确的绝对路径，不使用未展开的 glob。清单至少包含：路径、大小、分类、删除后影响、恢复位置。

### 3. 获取确认

在用户未明确授权前只做审计，不删除、不移动、不覆盖。确认内容必须包括：

- 要清理的精确目录/文件；
- 预计释放空间；
- 是否保留最新安装包；
- 是否允许删除 `node_modules`；
- 是先隔离还是永久删除。

如果用户只说“清理一下”，默认只隔离 `DUPLICATE_ARTIFACT` 和明确的构建中间物，不动 `node_modules`、`runtime` 和用户选择的安装包。

### 4. 执行可恢复清理

默认把候选项移动到项目外、带时间戳的隔离目录，例如：

```text
<项目父目录>\\agent-board-slimming-quarantine-YYYYMMDD-HHmmss\\
```

隔离目录保存：

- 原始相对路径；
- 文件大小和 SHA-256；
- 移动时间；
- 原始 Git 状态摘要；
- 清理原因。

移动前再次检查目标仍在项目根目录内，且没有新增用户修改。不要移动当前正在运行或被锁定的文件。

### 5. 清理后验证

至少验证：

```powershell
node --test
```

如果保留了 `dist/win-unpacked/`，再次运行 `node tools/verify-package.js dist/win-unpacked`。如果它已被清理，要明确报告“发布目录已清理，未执行清理后打包验证”。

如果删除了 `node_modules/`，验证源码服务和测试即可，并明确说明桌面开发/构建前需要重新安装依赖。不要因为 `node --test` 通过就声称 Electron 构建也已验证。

检查项目根目录中是否残留旧路径、临时文件或意外生成的数据；确认 Git 状态没有出现用户未预期的源码删除。若验证失败，停止进一步清理，并优先从隔离目录恢复导致问题的目标。

### 6. 输出报告

```text
# Agent Board 瘦身报告

项目根目录：<绝对路径>
清理方式：隔离 | 永久删除
清理前大小：<size>
清理后大小：<size>
预计/实际释放：<size>

保留：<源码、运行时、安装包、许可证等>
已清理：<精确路径和分类>
未处理：<被锁定、未知或用户选择保留的内容>

验证：
- node --test：通过/失败
- desktop:verify：通过/未执行/失败
- Git 状态：...

恢复位置：<隔离目录>
后续影响：<例如 desktop:dev 需要 npm install>
```

报告必须区分“已验证”“推断”和“未验证”。不允许用“看起来没问题”代替测试结果。

## 当前 Agent Board 的默认判断

在本项目中，`dist/` 通常是最大的可重建目录；`dist/win-unpacked/`、重复的 ZIP/安装包、`.icon-ico/` 和 `builder-debug.yml` 需要按版本确认后清理。`node_modules/` 是开发构建依赖，不是源码服务的运行依赖；删除前必须说明桌面开发和打包会暂时不可用，直到重新安装依赖。`runtime/node.exe` 不应因为体积大就删除，因为桌面打包脚本会使用它。

## 成功标准

只有同时满足以下条件才能报告完成：

- 只操作了项目根目录内、清单中明确列出的目标；
- 源码、Git、用户数据、配置、凭据和必要运行资源未被删除；
- 用户选定的发布产物仍然存在；
- 清理前后验证结果已记录；
- 被删除内容可从隔离目录恢复，或用户明确确认了永久删除；
- 对 `node_modules`、`runtime`、`dist` 删除造成的后续影响已如实说明。
