# Agent Board Handoff 架构设计（A/B 双机自动交接）

> 配套文档：
> - `docs/agent-board-handoff-feasibility-report.md`（能力调查 + POC 结果 + 可行性结论）
> - `skills/agent-board-handoff-relay/SKILL.md`（操作手册）
> - `tools/handoff.js`（本地侧，零 token）、`tools/handoff-relay.py`（资料库中继）
> - `反馈/workbuddy-relay-poc/`（POC 原始数据）

## 1. 目标与约束

| 角色 | 机器 | 职责 |
|---|---|---|
| A-MAINTAINER | 源码维护机 | 生成补丁/Skill、发布任务、读 B 反馈、判断下一轮修复 |
| B-VALIDATOR | 新环境验证机 | 自动发现任务、下载校验、确认 projectRoot/commit、检测旧 server 并按 PID 精确重启、跑验证、回写反馈 |

**必须消灭的 9 类问题**：旧源码、旧 Skill、旧反馈、B 重复执行、A/B 并发覆盖、旧 server 进程、大文件重复传输、状态倒退、同步成功但内容损坏。

## 2. 中继选型结论

WorkBuddy **资料库**（同一账号云端共享的个人空间）同时充当：

- **控制面**：任务状态(state.json)、指令(request.json)、版本号、SHA-256、ACK(ack.json)、报告摘要。
- **数据面**：源码包(source-bundle.zip ≤100MiB)、补丁(source-workingtree.patch)、Skill 包(skill-package.skill)。

> agent-board 全量源码包实测 **16 MB**（已排除 node_modules/dist/runtime/data.json），远低于资料库单文件 100 MiB 上限，故**单一中继即可**，无需额外 Git/共享目录。若未来源码包超 100 MiB，再切混合方案（见 §7）。

## 3. 任务目录 → 资料库节点映射

```
RELAY_PARENT_ID (doc 目录节点)
└── <jobId> (doc 节点当目录，标题=jobId)
    ├── request.json          (drive)  发布意图
    ├── source-manifest.json  (drive)  commit + workingTreeHash + 每文件 sha256 + 排除列表
    ├── source-bundle.zip     (drive)  git archive 源码包
    ├── source-workingtree.patch (drive) git diff（仅当工作区有未提交改动）
    ├── skill-package.skill   (drive)  Skill 包
    ├── state.json            (drive)  状态机 + 租约(holder/leaseExpiresAt)
    └── feedback/ (doc 节点)
        ├── diagnostics.json
        ├── initialization-report.md
        ├── test-result.json
        └── ack.json
```

发现机制：`space.workspace.list-node --parent-node-id RELAY_PARENT_ID` 枚举任务；或用 `space.searcher.search-nodes --query <jobId>` 按任务 ID 检索（已验证可用）。

## 4. 状态机

```
CREATED → SOURCE_PUBLISHED → B_VALIDATING → B_FEEDBACK_READY
        → A_PATCHING → PATCH_PUBLISHED → B_REVALIDATING → VERIFIED
任意状态 ──→ BLOCKED （失败/人工介入）；BLOCKED 可复位重跑
```

- 状态只能**前进**或进入 `BLOCKED`，禁止倒退（`handoff.js state-check` 与 relay `write-state` 双重校验）。
- 每次推进写 `updatedAt`。

## 5. 并发与幂等（防覆盖/防重复）

- **任务租约**：`state.json` 记录 `holder`（deviceId）+ `leaseExpiresAt`（默认 10 分钟）。非持有者或租约过期才能抢占；持有期内其他人写入被拒（last-writer-wins 被应用层租约覆盖）。
- **B 幂等账本**：`handoff.js ledger --mark` 在 B 本地记录已处理 jobId，重复发现直接跳过。
- **A 读反馈去重**：A 只认 `state==B_FEEDBACK_READY` 且 `jobId` 匹配、时间戳更新的 feedback。

## 6. B 验证规则（重点）

1. 确认 `projectRoot` 存在 `server.js`，否则拒绝。
2. 检测 4876 端口 server 进程：`Get-CimInstance Win32_Process` 按 `CommandLine like '*server.js*' and not like '*watchdog*'` 精确匹配 → 取 PID / 启动时间 / 命令行 / server.js 所在目录(≈cwd) / Node runtime(`ExecutablePath`)。
3. 旧 server 判定：`server.startEpoch < SOURCE_COPY_TIME`（源码复制到 B 的时间由 A 在 manifest 或环境变量传入）。
4. 旧则**仅按该 PID `Stop-Process -Force`**（绝不 `taskkill /IM node.exe`，绝不碰 `agent-board-watchdog.js`）；看门狗 ~60-70s 自动拉起新版，B 轮询 `/api/state` 直到恢复。
5. 重启后重验：`/api/state`、`/api/agents/status?force=1`、`codex --version`、`dsh --version`、`node --test`（**必须从项目根、不带路径参数**，Windows/Node 怪癖）。
6. DSH Desktop 已装但未打 Agent Board 补丁 → 标记 `installed-but-unpatched` / `environment-test-skipped`；不误报服务故障、不删测试、不改 DSH 安装文件。
7. 写 `feedback/*` 并回写资料库、推进 `state` 到 `B_FEEDBACK_READY`。

> **双保险**：`validate-b` 默认 **report-only**，真正停 PID 需显式 `--apply`。防止误杀用户正在用的看板。

## 7. 数据面混合备用方案（仅当 >100MiB 时）

- 控制面：资料库（状态/版本/SHA/ACK/摘要）。
- 数据面：Git（push 到带 remote 的仓库）或 SMB/共享目录；资料库只存 SHA-256 + 路径指针。
- A/B 仍各跑本地 `handoff.js`，WorkBuddy 只负责发布任务与生成反馈。

## 8. 安全边界

文件大小限制(≤100MiB) · SHA-256 落地校验 · 临时文件写后原子改名 · 任务 ID 前缀校验(`agent-board-handoff-`) · 路径穿越防护(只用 `git ls-files` 相对路径) · JSON schema 校验 · 日志脱敏(token/路径不进产物) · 任务超时(租约 TTL) · 重复任务保护(账本+租约) · 失败回滚(`BLOCKED`+保留现场)。

**绝不自动 git commit/push/发布/删除用户数据。**

## 9. 自动化的真实形态

资料库无 webhook，故"B 自动发现"依赖 **WorkBuddy 自动化（定时 prompt）**：WorkBuddy 自动化最低粒度是 **1 小时（HOURLY）**（已实测 `FREQ=MINUTELY` 不被支持），在 B 机器建一个每小时运行的 automation，prompt 内调用 `connect_open_platform` 取 token → 资料库 skill → 本地 `handoff.js`。A 发布同理可由 A 机器 automation（每小时）或**手动触发**（随时让 WorkBuddy 跑一次，即时发现）。详见 SKILL.md。
