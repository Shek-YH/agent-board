# Agent Board 云端鉴权与代理系统：Phase 0 现状审计

> 日期：2026-08-28
> 依据：`Agent_Board_云端鉴权与代理系统_PRD_Codex.md` 以及同目录的编码前深度评审报告
> 性质：实施映射，不是生产部署授权

## 1. 文档与请求的边界

用户请求是“按 PRD 开发”。PRD 中的安全规则、阶段顺序和验收标准被视为产品约束；其中的代码块、目录示例和部署示例不是需要直接执行的命令。评审报告是设计审查输入，不替代用户授权，也不授权修改生产服务器。

本次审计没有读取、复制或回显 `F:\env\阿里宝塔\.env`，也没有连接宝塔、ECS 或生产数据库。后续如需部署，必须另行确认部署范围、测试环境和迁移窗口。

## 2. 当前实际基线

| 领域 | 当前实现 | 对 PRD 的影响 |
|---|---|---|
| 仓库 | `agent-board`，当前分支 `feature/all-agent-session-topology`；工作区包含本轮云端鉴权实现改动，另有用户既有音频改动 | 本轮只在该工作树修改；`agent-board-main`、`agent-board-topology-clean` 是其他 worktree，不作为目标 |
| 后端 | `server.js` 使用 Node 内置 `http`，默认只监听 `127.0.0.1:4876` | 不能把它直接假设成 NestJS API；云端 API 应独立目录/进程，避免破坏桌面看板 |
| 数据 | `lib/store.js` 使用 `%LOCALAPPDATA%\AgentBoard\data.json` 的本地 JSON 快照与内存索引 | 会话正文继续留在本地；云端 PostgreSQL 只承载身份、授权、设备、租约、审计等业务数据 |
| 前端 | `public/index.html` + `public/app.js`，无构建工具 | 后续桌面授权 UI 继续适配原生页面；Admin/Agent Portal 另建 Web 应用，不强行改造现有看板页面 |
| Electron | `desktop/main.js` 创建窗口；`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；后端由 Main 启动 | Device Key、safeStorage/DPAPI、Access/Refresh Token 只能放 Main Process；Renderer 只能经 IPC 得到非敏感状态 |
| 当前账号能力 | `lib/account.js`、`lib/entitlement.js`、`lib/auth-cache.js` 提供本地 Ed25519 Entitlement 验签、缓存和 `/api/account/status`、`/api/account/logout` | 这是免费本地模式的兼容基础，不是云端身份系统；不能将本地缓存当作云端授权真相 |
| 测试 | 使用 Node 内置 `node:test`，已有覆盖后端、前端、Electron 辅助模块的测试 | 新安全边界应继续使用自动测试，先写失败测试再实现 |
| 构建 | Electron 打包清单在 `package.json`，后端和运行时作为 extraResources | 云端目录不得进入桌面包；修改本地构建清单前必须做打包回归 |

## 3. 可直接复用的模块

1. `lib/runtime-paths.js`：本地数据/配置目录解析，后续可复用到客户端授权缓存和设备元数据路径。
2. `lib/auth-cache.js`：可作为兼容层参考，但不能继续保存云端 Refresh Token 明文；Desktop Token 接入时应改为 Main Process 安全存储。
3. `lib/entitlement.js`：已有 Ed25519 验签边界和无敏感状态返回约定，可作为 Offline Grant 验签的测试风格参考；离线方案仍需补 `kid`、设备绑定、`maxSeenTime` 和防回滚。
4. `desktop/main.js`、`desktop/preload.js`：可承载 Device Identity、网络客户端和 IPC 白名单；当前 preload 暴露面很小，应保持这一原则。
5. `server.js` 的运行时诊断、健康检查和错误日志约定：可用于区分本地桌面后端与未来云端服务，但两者的健康端点和日志上下文应分开。

## 4. 现状与 PRD 的冲突及处理决定

### 4.1 技术栈冲突

PRD 推荐 NestJS + Prisma + PostgreSQL + Better Auth，以及独立的 Next.js Admin Web；现有项目没有这些依赖。采用“云端独立、桌面最小接入”的边界：

- 新增独立 `cloud/` 工作区，首阶段只实现 API 基础，不改造现有本地采集服务的存储层。
- Better Auth 挂在 NestJS API 中，作为 Web 身份源；Admin Web 使用 Secure、HttpOnly Cookie。
- Desktop 使用薄 DesktopAuthModule：15 分钟 Access Token + 绑定设备的 opaque Refresh Rotation；不重新实现密码哈希。

### 4.2 PRD v1.0 的待定模型

编码前采用评审报告中已明确的修正，避免把歧义带入 Migration：

- `Entitlement` 按 `userId + productId` 唯一，保存 `currentPlanId`、`policySnapshot`、`policyVersion`；Plan 后续修改不影响存量授权策略。
- Better Auth 身份表与业务 `UserProfile` 分离；业务角色不塞进 Better Auth user 表。
- 数据库加入 `UNIQUE`、非负余额、一码一 Grant、设备唯一注册等数据库级约束。
- P0 并发策略实现 `DENY_NEW`、`KICK_OLDEST` 与 `ASK_USER`；兼容历史 `REJECT` 数据。
- 并发设备按 distinct `deviceId` 计数；同设备实例数单独处理，P0 客户端先用 Electron 单实例锁兜底。
- Heartbeat 的顺序号使用严格递增和可自愈的 stale-sequence 错误；不把每次心跳变成 `lastValidatedAt` 数据库写入。
- Offline Grant 带 `kid`，使用安全本地存储，并维护单调时间/截止时间；它是断网宽限，不是本地授权真相源。

## 5. 分阶段实施映射

### Phase 1：云端基础

建议新增：

- `cloud/package.json` / `cloud/tsconfig.json`：云端独立依赖与构建边界。
- `cloud/apps/api/`：NestJS API、Better Auth 挂载、requestId、健康检查、配置校验。
- `cloud/prisma/schema.prisma` 与首个 migration：身份关联、业务 UserProfile、后续领域表的基础约束。
- `cloud/compose.yaml`：PostgreSQL 仅绑定 `127.0.0.1`，应用和数据库走 Docker 私有网络。
- `cloud/.env.example` 与 `cloud/README.md`：只记录变量名/示例占位符，不放宝塔或生产值。

Phase 1 验收：本地测试 PostgreSQL 下注册/登录能够落库；受保护 API 在未授权时返回 401/403；`/health/live` 与 `/health/ready` 语义明确。审计初期本机未安装可用 Docker，因此当时将真实数据库验收保留到后续环境准备阶段。

### Phase 2–8：业务域与桌面接入

依次实现 Admin/RBAC/Audit、Product/Plan/Entitlement、Redemption、Agent/Ledger、Device Enrollment、Lease/Heartbeat、Offline/Version。每个阶段都应有独立设计/计划文件和自动测试，不能一次性把 P0–P2 全部塞入现有 `server.js`。

### Phase 9：部署

只提供 Compose、Migration、Nginx 示例、备份/恢复 Runbook 和验收脚本。不得在编码阶段读取宝塔凭据、修改生产 Nginx、开放端口或执行生产 Migration。

## 6. 本轮结论

- 现有 Agent Board 可保留为本地会话采集桌面端；云端授权系统必须是独立业务边界。
- 初始审计阶段最安全的下一步是实现独立 `cloud/` 的 Phase 1，并先补齐评审报告指出的 P0 blocker 决策；不应把 `/api/account/status` 误标成云端登录完成。
- 审计初期本机缺可用 Docker，不能据此宣称 PostgreSQL/Compose 已验收；后续 Docker Engine 已恢复，并在隔离 PostgreSQL 测试容器中完成真实数据库验收。
- 本轮未执行任何生产操作，未读取任何生产秘密。

## 7. 后续实施结果（2026-08-28）

在上述审计之后，Phase 1–9 的云端业务骨架、部署材料和桌面最小接入已落地到当前分支：

- Electron Main Process 已接入 Windows `safeStorage`、Ed25519 Device Identity、设备注册、License Lease、Heartbeat、Offline Grant 验签和受限 IPC/UI。
- Desktop Auth 已使用 Better Auth 作为密码身份源，发行 15 分钟访问凭证和设备绑定的 opaque Refresh Token；Refresh Rotation、Token Family 撤销和 `REFRESH_TOKEN_REUSE` 安全事件已覆盖测试。
- API 错误正文已统一为 `code`、`message`、`requestId`、`details`；并发策略已覆盖 PRD 规定的 `DENY_NEW`、`KICK_OLDEST`、`ASK_USER`，保留 `REJECT` 兼容旧数据。
- 已完成真实 `glm-5.3-flash` 调用、云 API 编译/健康与未授权烟测、Windows `win-unpacked` 启动烟测和 NSIS 构建/包内容校验。
- 已启动隔离 PostgreSQL 17 测试容器并完成 15 条 Prisma Migration、真实数据库写入、API/Admin E2E 和页面/API/数据库三重验收；测试容器只绑定本机回环地址，没有据此执行任何宝塔或生产操作。

## 8. 后续验证与补强（2026-08-28）

- 修复桌面 Bearer 会话退出时未释放缓存 Lease 的问题，并增加回归测试；程序退出和桌面退出现在都会尝试释放在线租约。
- Refresh Rotation 增加数据库条件更新（`rotatedAt IS NULL AND revokedAt IS NULL`）；并发抢占失败会按 Refresh Token Reuse 处理，撤销整个 Family 并记录安全事件；真实 PostgreSQL 验收又发现事务内抛错会回滚 Family 撤销，现已改为先提交撤销再返回 `REFRESH_TOKEN_REUSE`，并补充回归测试。
- 生产配置缺少 `LICENSE_SIGNING_PRIVATE_KEY` 时现在直接拒绝启动，避免离线授权能力静默降级；开发/测试配置保持可选。
- 新增 `cloud/scripts/e2e-smoke.mjs` 与 `npm run e2e:smoke`，只接受显式测试环境变量，真实验证 API 健康、匿名 401、Better Auth 登录、用户 API、Admin API、退出登录后的 401 和 Admin 页面；CLI 请求会模拟浏览器 Origin，不读取任何 `.env`。
- 注册模式已按 PRD 落地为 `OPEN`、`INVITE_ONLY`、`DISABLED`，并用中间件只拦截公开注册；新增密码找回 HTTPS Webhook 投递适配器，原始 JSON 使用 HMAC-SHA256 签名，日志与请求体均不包含密码或 Token；桌面端已提供忘记密码入口。
- 用户状态已补齐 PRD 的 `ACTIVE`、`SUSPENDED`、`DISABLED`，暂停/禁用都会撤销活动 Lease 和 Session，并阻止新的 Desktop/Device/License/Redemption 操作；新增 `POST /v1/admin/users/:id/suspend` 和对应迁移。
- 管理端已补齐 PRD 的 `/admin/dashboard`、用户/代理详情、`/admin/online-sessions`、`/admin/client-versions` 和 `/admin/settings` 页面；新增受 AdminGuard 保护的 `GET /v1/admin/dashboard` 与 `GET /v1/admin/online-sessions`，分别返回 PRD 12 项运营指标和未过期活动 Lease，并支持按用户/设备筛选；用户列表提供搜索、状态筛选和分页，用户详情提供人工授权、Grant 历史、授权暂停/恢复/撤销、设备、兑换记录、安全事件和审计；代理详情提供直属用户、下级代理、发码批次、账本、规则编辑以及迁移影响预览；Admin/Agent 侧栏均提供安全退出入口。
- 管理员角色变更已限制为仅 `SUPER_ADMIN` 可提升或修改超级管理员；代理直发授权会校验计划白名单并在同一 Serializable 事务中扣减不可变 Ledger，批量兑换生成同样使用 Serializable 隔离。
- Admin 产品/计划页已补齐列表中的启用/禁用操作，调用已有 PATCH 接口并继续由服务端写入审计；管理端 25 个页面路由均能完成生产构建并通过真实 HTTP 页面烟测。
- 新增管理 API 的 Cookie/Session CSRF Origin/Referer 校验；桌面端登出会清除离线授权缓存，且离线回退仅在网络不可用或服务端 5xx 时发生，不能绕过远端暂停/拒绝。
- Cloud 新增独立 `npm run lint` 与 `npm run typecheck` 门槛。本机验证结果（本轮）：根项目 630/630、Cloud API 99/99、Admin 2/2；Cloud lint/typecheck、Cloud/Admin TypeScript/生产构建均通过；Prisma Client 生成通过，`prisma validate` 与 15 条 Migration 在隔离 PostgreSQL 测试库通过（未读取生产环境）；编译 API 真实 HTTP 烟测、Admin 26 路由真实 HTTP 烟测、`e2e:smoke` 和完整 `e2e:acceptance` 通过；Windows NSIS 安装包重建、包内容校验和隔离数据目录 Electron 启动烟测通过；智谱 `glm-5.3-flash` 真实调用返回精确 `REAL_TEST_OK`。
- 依赖安全复核已完成：NestJS 升级到 11.2.3，修复其 `file-type`、`multer` 与 `path-to-regexp` 传递告警；Prisma 6.19.0 保持不降级，通过 npm overrides 固定 `deepmerge-ts` 8.0.0 与 `effect` 3.20.0。使用 npm 官方 registry 执行生产依赖和全量 `npm audit` 均为 0 vulnerabilities；升级后 Cloud 测试、lint、typecheck 与构建均通过。
- 真实 CLI 联调已验证：`codex exec` 使用持久化会话时，桌面后端能发现同一 session，运行中为 `active/main`，CLI 返回文本能在会话消息中查到，退出后立即收敛为 `done`，观察 8 秒仍保持终态；`--ephemeral` 会话不落 rollout 文件，因此不应作为看板发现测试方式。
- 本轮再次启动真实持久化 CLI 会话 `01a04afb-03e3-71b2-bd95-37c574400fbd`，由 CLI 独立执行根 `npm test`、Cloud `npm test`、`npm run lint`、`npm run typecheck` 和 `npm run build`，五项均返回 exit 0；CLI 运行期间出现本机 Codex 缓存磁盘空间不足告警，但未影响这些命令执行。CLI 将 `.dockerignore` 检查错放在仓库根目录并报告缺失，当前正确文件为 `cloud/.dockerignore` 与 `cloud/apps/admin/.dockerignore`，已由本机路径检查确认存在。
- 依赖升级后的编译 API 真实 HTTP 烟测再次通过：`/health/live` 返回 200、受保护的 Admin Dashboard 返回 401、Desktop 登录的无效凭据返回 401；Better Auth 的数据库登录在本机未启动 PostgreSQL 时按实际情况返回数据库错误，不能据此宣称登录链路已完成验收。
- 本轮新增 API 路由实际注册检查：代理迁移预览 `GET /v1/admin/agents/:id/move-preview` 与账本 `GET /v1/admin/agents/:id/ledger` 已由编译后的 Nest 应用加载；用户直属代理筛选和代理批次筛选均有服务层回归测试。
- 新增 `0015_integrity_constraints` Migration：数据库约束账本余额非负、批次数量为正，并以 `redemption_request.codeId` 唯一索引强化“一码一请求”；对应 SQL 有静态回归测试并已纳入 `cloud` 测试命令。
- 审计快照脱敏规则新增 `apiKey`/`authorization` 覆盖，并以失败回归测试驱动修补，防止管理操作快照保存 API 凭据或授权头。
- 新增 `cloud/scripts/e2e-acceptance.mjs` 与 `npm run e2e:acceptance`：使用唯一测试数据真实验证注册、Admin 目录与人工授权、兑换幂等、同一码 20 并发、设备签名、Lease/Heartbeat、`KICK_OLDEST`、Refresh Token Reuse，以及 Audit/SecurityEvent 的 PostgreSQL 持久化。
- 追加完成隔离 PostgreSQL 17 的真实备份恢复验收：`backup-postgres.sh` 生成 custom-format dump 并通过 `pg_restore --list` 校验，`restore-postgres.sh` 在缺少 `CONFIRM_RESTORE=YES` 时以退出码 2 拦截，确认后恢复出的标记数据与源库一致；`backup-stack-config.sh` 生成并可列出 Compose、Dockerfile、Schema 和 Migration 归档。
- 新增 API 与 Admin 镜像构建的 `.dockerignore`，排除本地依赖、构建产物、环境文件和日志，避免把约 500 MB 的 `node_modules` 带入构建上下文；匿名拉取 `node:22-bookworm-slim` 成功，但 `node:22-alpine` 元数据请求仍因 Docker Hub 网络超时，Compose 双镜像构建仍未形成可验收结果。
- 当前剩余边界为生产宝塔反代、TLS、生产备份/恢复、生产 Migration 窗口和公网安全组验收；此外 Compose API/Admin 镜像本轮因 Docker Hub Node 基础镜像 OAuth 网络超时未完成构建，但本地编译产物与 Admin 生产构建均已通过。生产事项必须在独立确认的窗口执行，不能用本地测试容器代替。
