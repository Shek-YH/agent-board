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
| 仓库 | `agent-board`，当前分支 `feature/all-agent-session-topology`，工作区审计时干净 | 本轮只在该工作树修改；`agent-board-main`、`agent-board-topology-clean` 是其他 worktree，不作为目标 |
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
- P0 并发策略先实现 `DENY_NEW` 与 `KICK_OLDEST`；`ASK_USER` 留到 P1。
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

Phase 1 验收：本地测试 PostgreSQL 下注册/登录能够落库；受保护 API 在未授权时返回 401/403；`/health/live` 与 `/health/ready` 语义明确。当前机器未安装 Docker，因此 Docker/真实 PostgreSQL 验收必须在安装 Docker 的开发环境或独立测试 ECS 完成。

### Phase 2–8：业务域与桌面接入

依次实现 Admin/RBAC/Audit、Product/Plan/Entitlement、Redemption、Agent/Ledger、Device Enrollment、Lease/Heartbeat、Offline/Version。每个阶段都应有独立设计/计划文件和自动测试，不能一次性把 P0–P2 全部塞入现有 `server.js`。

### Phase 9：部署

只提供 Compose、Migration、Nginx 示例、备份/恢复 Runbook 和验收脚本。不得在编码阶段读取宝塔凭据、修改生产 Nginx、开放端口或执行生产 Migration。

## 6. 本轮结论

- 现有 Agent Board 可保留为本地会话采集桌面端；云端授权系统必须是独立业务边界。
- 当前最安全的下一步是实现独立 `cloud/` 的 Phase 1，并先补齐评审报告指出的五类 P0 blocker 决策；不应把 `/api/account/status` 误标成云端登录完成。
- 本机缺 Docker，不能宣称 PostgreSQL/Compose 已验收；可以先完成静态配置、单元测试和不依赖 Docker 的边界测试，再在测试环境完成数据库集成验收。
- 本轮未执行任何生产操作，未读取任何生产秘密。

