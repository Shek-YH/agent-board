---
name: agent-board-handoff-relay
description: Agent Board A/B 双机自动交接中继。利用 WorkBuddy 资料库作为控制面+数据面，实现源码补丁/Skill/任务状态/诊断报告/验证结果的自动交接，防止旧源码、旧 Skill、旧反馈、重复执行、并发覆盖、旧 server 进程等问题。触发词：agent board 交接、A/B 双机、relay、handoff、资料库中继。
---

# Agent Board Handoff Relay（A/B 双机自动交接）

> 用 WorkBuddy **资料库**（同一账号云端共享的个人空间）作为 A(维护机) 与 B(验证机) 之间的中继。
> 已通过 POC 验证：A 发布 → B 发现 → B 回写 → A 读取 全链路往返成功，内容字节一致、无重复/覆盖/损坏。

## 前置条件

1. A、B 两台电脑**登录同一个 WorkBuddy 账号**，资料库个人空间自动共享（同账号 → 同 `personal` 空间）。
2. 两台机器都装了 `资料库` skill（本 Skill 依赖它底层的 `space_api.py` / `drive` 脚本）。
3. 中继根节点：在资料库个人空间建一个目录节点（用 `space.importer.create-doc` 建文档当目录），记下其 `nodeBlockId` 设为环境变量 `RELAY_PARENT_ID`。
4. 本仓库 `tools/handoff.js`（本地、零 token）与 `tools/handoff-relay.py`（资料库中继、token 来自 `connect_open_platform`）就位。
5. **安全红线**：绝不传 `node_modules/`、`dist/`、`runtime/`、`data.json`、会话全文、`.env`、token、credentials。已在 `handoff.js` 的 manifest/bundle 与 `handoff-relay.py` 的 publish 中强制排除。

## 设备标识

- `A-MAINTAINER`：源码维护机（发布方）
- `B-VALIDATOR`：新环境验证机（消费方，自动发现 + 验证 + 回写）

## 任务目录结构（映射到资料库节点）

```
RELAY_PARENT_ID/
└── <jobId>/                       # doc 节点当目录（标题 = jobId）
    ├── request.json               # 发布意图（drive）
    ├── source-manifest.json       # commit/workingTreeHash/每文件 sha256/排除列表
    ├── source-bundle.zip          # git archive 源码包（≤100MiB）
    ├── source-workingtree.patch   # 若有未提交改动，git diff 补丁
    ├── skill-package.skill        # Skill 包
    ├── state.json                 # 状态机 + 租约(holder/leaseExpiresAt)
    └── feedback/                  # B 回写
        ├── diagnostics.json
        ├── initialization-report.md
        ├── test-result.json
        └── ack.json
```

## 状态机（状态只能前进或进入 BLOCKED，禁止倒退）

`CREATED → SOURCE_PUBLISHED → B_VALIDATING → B_FEEDBACK_READY → A_PATCHING → PATCH_PUBLISHED → B_REVALIDATING → VERIFIED`
任意状态可转 `BLOCKED`；`BLOCKED` 可复位重跑。

## A 模式（维护机，手动或定时触发）

```bash
cd <agent-board>
# 1. 生成 manifest（排除大目录/敏感文件，含每文件 sha256）
node tools/handoff.js manifest .
# 2. 生成源码包 + 补丁（git archive / git diff）
node tools/handoff.js bundle . ./out
# 3. 发布到资料库（token 来自 connect_open_platform，由 agent 注入）
TOKEN=$TOKEN node tools/handoff-relay.py publish . A-MAINTAINER
# 4. 轮询 B 状态
TOKEN=$TOKEN node tools/handoff-relay.py discover B-VALIDATOR
TOKEN=$TOKEN node tools/handoff-relay.py read-feedback <jobId> ./in
# 5. 判断是否需要下一轮修复（读 feedback/ack.json + test-result.json）
```

## B 模式（验证机，自动发现 + 验证 + 回写）

### 自动发现机制
资料库**没有 webhook**，采用**轮询**。WorkBuddy 自动化的**最低粒度是 1 小时（HOURLY）**（已实测 `FREQ=MINUTELY` 被拒绝），故在 B 机器的 WorkBuddy 里建一个**每 1 小时**运行的定时自动化（automation），运行下方 B 提示词。自动化在 WorkBuddy 内执行，可调用 `connect_open_platform` 取 token → 资料库 skill → 本地 `handoff.js`。

> **需要更快？** 自动化只能 hourly，但你可以**随时手动**让 WorkBuddy 跑一次 B 检查（直接说"执行 B 交接检查"），我会立即取 token 并跑 discover→download→validate→回写，无需等整点。

**B 自动化提示词（复制到 automation 的 prompt 字段）：**
```
你是 Agent Board 验证机(B-VALIDATOR)。执行：
1. 用 资料库 skill 的 connect_open_platform 取 token；
2. 运行 TOKEN=<token> python3 tools/handoff-relay.py discover B-VALIDATOR --claim 发现并抢占新任务（租约防并发）；
3. 对抢到的 jobId 运行 TOKEN=<token> python3 tools/handoff-relay.py download <jobId> ./in 下载产物；
4. 校验 source-manifest.json 的 commit/workingTreeHash/每文件 sha256 是否与本地一致（node tools/handoff.js sha256 比对），不符则写 BLOCKED 并停止；
5. 应用源码包/补丁到本地 projectRoot（勿动 node_modules/dist/runtime/data.json）；
6. 运行 HANDOFF_DEVICE=B-VALIDATOR SOURCE_COPY_TIME=<复制时间戳ms> node tools/handoff.js validate-b <projectRoot> --apply：
   - 检测 4876 端口 server PID/启动时间/命令行/工作目录/Node runtime；
   - 若 server 启动早于源码复制时间 → 仅按 PID 精确 Stop-Process（绝不 taskkill /IM node.exe，绝不碰 watchdog），等看门狗拉起新版后重验；
   - 验证 /api/state、/api/agents/status?force=1、codex --version、dsh --version、node --test（必须从项目根、不带路径参数）；
   - DSH Desktop 已装但未打 Agent Board 补丁 → 标记 installed-but-unpatched / environment-test-skipped，不误报服务故障、不删测试、不改 DSH 安装文件；
   - 写 feedback/{diagnostics.json,initialization-report.md,test-result.json,ack.json}；
7. 回写 feedback 到资料库：TOKEN=<token> 上传 feedback/* 到该 job 的 feedback 节点，并把 state 推进到 B_FEEDBACK_READY（write-state 带租约）；
8. 任何失败 → state 置 BLOCKED 并写 diagnostics，等待人工介入，不自动删除用户数据、不自动 git/push。
```

### validate-b 默认 report-only
本地验证**默认只报告不停止进程**；真正停旧 server PID 需显式 `--apply`。这是有意的双保险（防误杀用户正在用的看板）。

## 防错要点（对应需求九大类）

1. **B 用旧源码** → manifest 携带 commit + workingTreeHash + 每文件 sha256，B 校验一致才应用。
2. **B 用旧 Skill** → skillVersion + skill-package.skill 的 sha256，B 校验版本。
3. **A 误读旧反馈** → feedback 带 jobId + state + 时间戳；A 只读 state==B_FEEDBACK_READY 且 jobId 匹配。
4. **B 重复执行** → 本地账本 `handoff.js ledger --mark` + state.json holder 去重，幂等。
5. **A/B 并发覆盖** → state.json 租约（holder + leaseExpiresAt），非持有者写入被拒。
6. **旧 server 进程** → B 比 server 启动时间 vs 源码复制时间，旧则按 PID 精确重启（看门狗拉起）。
7. **大文件重复传输** → manifest/bundle 强制排除 node_modules/dist/runtime/data.json/会话数据。
8. **状态倒退** → `handoff.js state-check` 与 relay `write-state` 双重校验状态机。
9. **同步成功但内容损坏** → 每文件 sha256 落地校验，B 应用前比对。

## 安全

- 文件大小限制：资料库单文件 ≤100MiB；超了 publish 直接报错，改 Git/共享目录做数据面。
- SHA-256：manifest 内每文件哈希，B 落地校验。
- 临时文件写后原子改名；任务 ID 校验（前缀 `agent-board-handoff-`）；路径穿越防护（只用 git ls-files 相对路径）。
- JSON schema 校验；日志脱敏（token/路径不进产物）；任务超时（租约 TTL）；重复任务保护（账本+租约）；失败回滚（状态置 BLOCKED，保留现场）。
- **绝不自动 git commit/push/发布/删除用户数据。**

## 已知限制

- 跨物理机的"同一份内容"是依据**同账号云端个人空间**推断（POC 在本机单实例跑通往返）；真正双机需在 B 机器上启用上述自动化并实测一次。
- 资料库无原生文件锁/合并，并发靠应用层租约；冲突为 last-writer-wins，故必须走租约。
- token 无法在脱离 WorkBuddy 的纯 CLI 脚本里获取，故"自动"依赖 WorkBuddy 自动化（prompt 内取 token），不是裸 cron。
- 若 agent-board 源码包未来超 100MiB，需切换混合方案：资料库只存状态/SHA/指针，源码走 Git/共享目录。

## 失败时的备用方案

资料库作为控制面 + Git/共享目录作为数据面的混合架构；A/B 仍各跑本地 `handoff.js` watcher，WorkBuddy 只负责发布任务与生成反馈。
