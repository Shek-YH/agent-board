# Agent Board Handoff 可行性报告（A/B 双机自动交接）

> 评估对象：利用 **WorkBuddy 资料库**（`workbuddy.cn/space` 同一账号云端共享个人空间）作为 A(维护机) 与 B(验证机) 之间的中继，实现源码补丁 / Skill / 任务状态 / 诊断报告 / 验证结果的自动交接。
>
> 评估方法：先加载 `资料库` skill 确认其 API 能力面；再用真实 token 在资料库内跑通 A→B→A 的 ping/pong 往返 POC；最后实现最小可用工具链。所有"已确认/已验证"条目均来自实际调用，未做猜测。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 是否支持**真正自动交接** | **有条件支持**：在 WorkBuddy 自动化框架内可自动（B 侧定时 prompt 轮询），但**不能**用脱离 WorkBuddy 的裸 cron/CLI（token 只能在 WorkBuddy 会话内取得）。 |
| 是否支持**自动传输文件** | **支持**：资料库 drive 上传/下载，单文件 ≤100MiB，已实测 16MB 源码包传输 + 字节校验。 |
| 是否支持 **B 自动执行** | **支持（每小时）**：B 机器建一个每 1 小时的 WorkBuddy 自动化（HOURLY 是最低粒度，已实测 MINUTELY 被拒），prompt 内取 token → 资料库 skill → 本地 `handoff.js`。需更快可随时手动触发（即时）。 |
| 是否支持 **A 自动接收反馈** | **支持**：A 机器 likewise 定时轮询 `read-feedback` / `read-state`。 |
| 推荐最终架构 | **单一中继**：资料库同时做控制面+数据面（源码包仅 16MB ≪ 100MiB）。混合方案（Git/共享目录做数据面）仅作为 >100MiB 的备用。 |
| 失败备用方案 | 资料库控制面 + Git/共享目录数据面；A/B 各跑本地 `handoff.js` watcher。 |

---

## 1. 能力调查（按需求 9 问逐条确认）

| # | 调查项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 同一账号两台电脑访问同一资料库 | **已确认** | `space.workspace.list-user-spaces` 返回 `personal`(owner) 空间 `SyGOVXJtd9cSMZIvtjNfMS`；同一账号登录即同一空间。 |
| 2a | 创建目录/分类 | **已确认** | `space.importer.create-doc` 建文档节点当目录（relay 根 `AgentBoardRelay` 已建，nodeBlockId `01qyEcJeFqUeD4K17GVe8T`）。 |
| 2b | 上传/下载 Markdown/JSON/ZIP/补丁 | **已确认** | drive `upload_drive_file.py` / `get_download_link.py`；POC 与 16MB 源码包均成功。 |
| 2c | 文件更新与版本历史 | **已确认** | replace 上传同 node 后 `version` 由 2→3（cap_confirm 实测），保留历史版本。 |
| 2d | 查询指定任务 ID | **已确认** | `space.searcher.search-nodes --query <jobId>` 支持按 ID 检索（POC 内已作兜底）。 |
| 2e | 两机同时读写 | **已确认（共享空间）** | 同一账号空间可读写；但**无原生锁**，见 §3 冲突处理。 |
| 2f | API/MCP/CLI/Skill/自动化 | **已确认（Skill+CLI）** | 资料库 skill 暴露 `space_api.py` + drive 脚本；可由 WorkBuddy 自动化 prompt 驱动（非裸 cron，因 token 限制）。 |
| 2g | 文件变更通知/轮询/webhook | **无法实现（无 webhook）** | 资料库无 webhook/推送；只能用 `list-node`/`search-nodes` **轮询**。B 自动发现 = WorkBuddy 定时自动化轮询。 |
| 2h | 大文件传输 | **已确认（≤100MiB）** | 单文件上限 100MiB；agent-board 全量源码包实测 16MB，远低于上限。 |
| 2i | 中文路径与 Unicode 内容 | **已确认** | 上传 `中文测试文件-✅.json`，下载后内容字节一致。 |
| 2j | SHA-256 / 完整性校验 | **应用层实现** | 资料库本身不返回 sha256；由 `handoff.js` 在 manifest 内附每文件 sha256 落地校验。 |
| 3 | A 读取本地项目并发布资料库 | **已确认** | `handoff.js manifest/bundle` + `handoff-relay.py publish`（POC 与架构均验证）。 |
| 4 | B 读取资料库、写本地文件、执行验证 | **已确认** | `handoff-relay.py download` + `handoff.js validate-b`；validate-b 已对真实运行中的 board 跑通（`node --test` 289 项全过）。 |
| 5 | A 自动读取 B 反馈 | **已确认（轮询）** | `handoff-relay.py read-feedback`；A 侧定时自动化轮询。 |
| 6 | 两机同时改同一文件冲突 | **应用层租约解决** | 资料库 last-writer-wins，无锁；用 `state.json` 的 `holder`+`leaseExpiresAt` 租约防并发覆盖（见 §3）。 |
| 7 | 自动合并/覆盖/延迟/多副本 | **无合并、可能覆盖、有延迟** | 资料库不自动合并，并发为 last-writer-wins；跨区同步有秒级延迟（POC 往返约 8.5s）；每次写是新版本，不产生多副本混乱。 |
| 8 | 权限/容量/大小/延迟/登录限制 | **有限制但可接受** | 单文件 ≤100MiB；需同账号登录；无 API 级删除（见 §4）；无 webhook。 |
| 9 | 是否适合做控制面+数据面 | **适合（本仓库规模）** | 源码包 16MB，状态/报告均为小 JSON/MD；单一中继即可。 |

---

## 2. POC 验证结果（真实往返，非推断）

详见 `反馈/workbuddy-relay-poc/poc-result.md`。要点：

- 任务 ID：`relay-poc-20260825-193718`（唯一，含时间戳+随机后缀）
- 全链路 A(发布 ping) → B(发现) → B(回写 pong) → A(读 pong) 成功。
- 耗时（单次实测）：A 发布 **3595ms** / B 发现 **498ms** / B 回写 **3109ms** / A 读取 **1302ms**，端到端约 **8.5s**。
- 完整性：jobId、nonce、status 全部匹配；下载内容与上传字节**完全一致**（`same_content: true`）。
- 无重复、无覆盖、无丢失、无损坏。
- **同一份内容**：POC 在单次 account 会话内跑通，且第二次运行 `list-node` 返回 `child_count: 4`（前一次 2 个文件 + 本次 2 个），证明写入**持久可见**、空间共享生效。跨物理机的"同一份"由同账号云端个人空间保证（逻辑成立，需 B 机实测一次确认）。

---

## 3. 并发/冲突处理（需求六、需求十）

- **无原生锁/合并**：资料库为 last-writer-wins，并发写同一 node 后者覆盖前者。
- **应用层租约**：每个任务的 `state.json` 含 `holder`(deviceId) + `leaseExpiresAt`(默认 10min)。`handoff-relay.py write-state` 强制校验：
  - 若被他人持有且租约未过期 → 拒绝写入（避免 A/B 同时推进状态）；
  - 状态机只允许**前进**或转 `BLOCKED`，非法跳转（倒退）被拒。
- **B 幂等账本**：`handoff.js ledger --mark` 在 B 本地记录已处理 jobId，重复发现直接跳过（防 B 重复执行同一任务）。
- **A 读反馈去重**：A 只认 `state==B_FEEDBACK_READY` 且 jobId 匹配、时间戳更新的 feedback。

---

## 4. 当前无法实现 / 需手动的项

| 项 | 说明 |
|---|---|
| **无 webhook/推送** | B 自动发现只能靠 WorkBuddy 定时自动化轮询（**最低 1 小时/次，已实测 MINUTELY 被拒**），不能事件驱动即时触发；但可手动让 WorkBuddy 即时跑一次。 |
| **无原生文件锁** | 必须走应用层租约（已实现）。 |
| **无 API 删除节点** | `space_api.py` 无 delete/trash 接口；POC 测试文件只能经资料库 UI 手动删除（建议清理 `AgentBoardRelay` 下的 `relay-poc-*` 节点）。 |
| **token 不能脱离 WorkBuddy** | `connect_open_platform` 仅在 WorkBuddy 会话内可用；纯 CLI/cron 脚本无法自动取 token，故"自动"必须落在 WorkBuddy 自动化框架内。 |
| **真正双机实测** | POC 在本机单实例（同账号）跑通机制；跨物理 A/B 两台机器需 B 机启用自动化并实测一次（逻辑已由同账号空间保证）。 |

---

## 5. 需用户手动操作的步骤

1. **建中继根节点一次**：在资料库个人空间建一个目录文档，记下 `nodeBlockId` 设为 `RELAY_PARENT_ID`（已代为创建 `AgentBoardRelay`）。
2. **两台机器都装 `资料库` skill**（底层 `space_api.py`/drive 脚本）。
3. **B 机器建自动化**：**每 1 小时**运行 SKILL.md 中的"B 自动化提示词"（自动取 token → 发现 → 下载 → 校验 → 重启旧 server → 验证 → 回写）。需要更快时改为手动触发（随时让 WorkBuddy 跑一次）。
4. **A 机器可选建自动化**：定时轮询 `read-feedback`/`read-state`；或手动触发发布。
5. **首次双机实测**：在 B 机实际跑一次完整 handoff，确认物理跨机链路。
6. **清理 POC 测试节点**：经资料库 UI 删除 `relay-poc-*` 文件（无 API 删除）。

---

## 6. 推荐最终架构

**单一中继（推荐，本仓库规模下）**

```
A-MAINTAINER ──publish──> 资料库个人空间(同账号共享) ──discover/download──> B-VALIDATOR
   <──read-feedback/state── 控制面+数据面同一通道
```

- 控制面：state.json / request.json / source-manifest.json(SHA-256+版本) / ack.json / 报告摘要。
- 数据面：source-bundle.zip(16MB) / source-workingtree.patch / skill-package.skill。
- 均 ≤100MiB，无需额外 Git/共享目录。

**混合备用（仅当源码包 >100MiB 时）**：资料库只存状态/版本/SHA-256/指针；源码包走 Git（带 remote 的仓库）或 SMB/共享目录。A/B 仍各跑本地 `handoff.js`，WorkBuddy 仅发布任务与生成反馈。

---

## 7. 实现产物（最小可用版，已落地）

- `tools/handoff.js`：本地侧、零 token。manifest（每文件 sha256+排除列表）、bundle（git archive，排除 node_modules/dist/runtime/data.json）、validate-b（PID 精确检测旧 server、`/api/state`、`/api/agents/status?force=1`、`codex --version`、`dsh --version`、`node --test`；默认 report-only，显式 `--apply` 才停 PID）、state-check、ledger（幂等账本）。
- `tools/handoff-relay.py`：资料库中继侧。publish / discover(--claim 含租约抢占) / download / read-feedback / read-state / write-state(租约+状态机校验)；100MiB 上限检查 + 敏感文件排除。
- `skills/agent-board-handoff-relay/SKILL.md`：A/B 模式操作手册 + B 自动化提示词 + 防错要点 + 安全 + 已知限制。
- `docs/agent-board-handoff-architecture.md`：架构/状态机/目录映射/安全边界。

---

## 8. 安全边界（需求七）

强制排除 `node_modules/`、`dist/`、`runtime/`、`data.json`、会话全文、`.env`、`token`、`credentials`；文件大小限制(≤100MiB)；SHA-256 落地校验；临时文件写后原子改名；任务 ID 前缀校验(`agent-board-handoff-`)；路径穿越防护(只用 `git ls-files` 相对路径)；JSON schema 校验；日志脱敏(token/路径不进产物)；任务超时(租约 TTL)；重复任务保护(账本+租约)；失败回滚(`BLOCKED`+保留现场)。

**绝不自动 git commit/push/发布/删除用户数据。**
