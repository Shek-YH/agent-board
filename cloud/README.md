# Agent Board Cloud

Phase 1–9 的独立云端服务，负责身份、Admin 用户管理、RBAC、审计、产品计划目录、授权、兑换、分级代理、额度账本、设备注册、在线授权租约、离线宽限、客户端版本策略和部署运行手册。它不进入现有 Electron 桌面包，也不读取桌面端会话正文。

## 本地启动

1. 复制 `.env.example` 为 `.env`，只填入本地开发值。
2. 安装依赖：`npm ci`。
3. 生成 Prisma Client：`npm run prisma:generate`。
4. 先启动 PostgreSQL：`docker compose up -d postgres`。
5. 应用迁移：`npm run prisma:migrate:deploy`。
6. 启动 API 和 Admin Web：`docker compose up -d api admin`。

只运行 API 源码进行调试时，在迁移完成后执行 `npm run dev`；不要同时启动 Compose API 和源码 API。

仅开发 Admin Web 时，在另一个终端运行：

```bash
cd apps/admin
cp .env.example .env
npm ci
npm run dev
```

Admin Web 默认访问 `http://127.0.0.1:3100`。

API 默认监听 `127.0.0.1:3200`，健康检查为：

```text
GET /health/live
GET /health/ready
```

Better Auth 的 Web 身份路由由 NestJS 模块挂载；业务角色、Entitlement、Device、Lease 等不放入 Better Auth user 表，后续阶段逐步增加。

当前管理员 API：

```text
GET   /v1/admin/users
POST  /v1/admin/users
GET   /v1/admin/users/:id
PATCH /v1/admin/users/:id
POST  /v1/admin/users/:id/disable
POST  /v1/admin/users/:id/enable
GET   /v1/admin/audit-logs
GET   /v1/admin/products
POST  /v1/admin/products
PATCH /v1/admin/products/:id
GET   /v1/admin/plans
POST  /v1/admin/plans
PATCH /v1/admin/plans/:id
GET   /v1/admin/entitlements
POST  /v1/admin/users/:id/grants
GET   /v1/admin/agents
POST  /v1/admin/agents
GET   /v1/admin/agents/:id
PATCH /v1/admin/agents/:id
POST  /v1/admin/agents/:id/ledger-adjustment
POST  /v1/admin/agents/:id/users/:userId
POST  /v1/devices/enroll
GET   /v1/devices/me
POST  /v1/devices/:id/revoke
GET  /v1/license/status
POST /v1/license/acquire
POST /v1/license/heartbeat
POST /v1/license/release
GET   /v1/admin/version-policies
POST  /v1/admin/version-policies
GET   /v1/admin/version-policies/:id
PATCH /v1/admin/version-policies/:id
GET   /v1/admin/devices
POST  /v1/admin/devices/:id/revoke
GET   /v1/agent/me
GET   /v1/agent/profile
GET   /v1/agent/batches
POST  /v1/agent/batches
GET   /v1/agent/codes
GET   /v1/agent/users
GET   /v1/agent/sub-agents
POST  /v1/agent/sub-agents
GET   /v1/agent/ledger
POST  /v1/agent/users/:id/grants
GET   /v1/admin/redemption-batches
POST  /v1/admin/redemption-batches
GET   /v1/admin/redemption-codes
POST  /v1/admin/redemption-codes/:id/revoke
POST  /v1/redemptions/redeem
```

代理 Portal 路由为 `/agent/dashboard`、`/agent/codes`、`/agent/batches`、`/agent/users`、`/agent/sub-agents`、`/agent/ledger` 和 `/agent/profile`；对应 API 只允许访问当前代理及其下级体系的数据。Agent 使用 `parentAgentId` 邻接表，API 在修改上级时防止循环；代理额度只通过不可变 `AgentLedgerEntry` 计算余额，发码时按 Plan 的 `agentCostCredits` 在同一事务中扣减，余额不足或 Plan 不在白名单时拒绝。

计划的 `durationSeconds`、设备限制、心跳策略、Feature JSON 和代理成本均来自数据库配置，不在代码中硬编码。人工授权会在同一事务中更新 Entitlement、创建 EntitlementGrant 并写入 AuditLog；有效授权从现有 `expiresAt` 叠加，已过期授权从服务端当前时间计算。

兑换批次会将兑换码以 HMAC-SHA256（服务端 `REDEMPTION_PEPPER`）存储，数据库不保存完整明文。明文只在创建批次的响应中出现一次，并可当次导出 CSV；兑换使用 `Idempotency-Key`（或 body `requestId`），同一码通过状态 CAS 防止并发双花。

设备注册使用安装标识和 Ed25519 公钥建立设备身份；服务端只保存公钥、指纹摘要和设备元数据，不接收或记录私钥。相同安装标识重复注册会更新最后在线信息而不重复占用设备名额，撤销或封禁设备不能重新接管；设备名额由有效 Plan 的 `maxRegisteredDevices` 控制。用户可查看并撤销自己的设备，管理员可在 `/admin/devices` 查看和撤销全局设备。

在线授权使用 `LicenseLease`。Acquire 与 KICK_OLDEST 在 Serializable 事务中检查并发设备/实例限制，旧租约被撤销后下一次 Heartbeat 返回 `LEASE_REVOKED`。Heartbeat 使用设备 Ed25519 私钥签名的规范化请求体、时间窗口和数据库原子序列号 CAS 防重放；正常心跳只更新租约，不写 AuditLog。租约 TTL、心跳间隔、并发策略和 Feature 均来自 Plan。

Phase 8 的 Offline Grant 使用独立的 `LICENSE_SIGNING_PRIVATE_KEY`（仅 API 进程环境变量）签发，桌面端只需配置对应的 Ed25519 公钥验签。离线可用截止时间取授权到期时间与 `offlineValidUntil` 的较小值；没有离线宽限时不签发凭证。`ClientVersionPolicy` 支持 latest/minimum/force-upgrade，低于最低版本的客户端不能获取或续租。

首次建立管理员时，先通过 Better Auth 注册一个用户，再在测试环境显式执行 `BOOTSTRAP_ADMIN_EMAIL=... npm run admin:promote`；该脚本不会读取密码，也不会自动提升任何账号。

## 安全边界

- `.env`、数据库密码和生产密钥不入库；使用环境变量注入。
- Compose 的 PostgreSQL 和 API 端口都只绑定 `127.0.0.1`。
- 生产环境要求 HTTPS origin 与至少 32 字符的 `BETTER_AUTH_SECRET`。
- 生产离线授权必须注入 Ed25519 `LICENSE_SIGNING_PRIVATE_KEY`，私钥不进 Git、Admin Web 或日志。
- 当前阶段不包含宝塔配置、生产 Migration 或生产部署操作。

## Phase 9 部署材料

- [生产部署 Runbook](infra/deploy-runbook.md)：受控迁移、宝塔/TLS、三重验收与恢复流程。
- [ECS 安全组清单](infra/security-group-checklist.md)：公网端口与主机安全边界。
- `infra/nginx-examples/`：只包含宝塔 `location /` 反代片段，不覆盖宝塔 SSL/Include 配置。
- `infra/scripts/backup-postgres.sh`：PostgreSQL custom-format 备份并校验 `pg_restore --list`。
- `infra/scripts/backup-stack-config.sh`：备份 Compose、Dockerfile、Schema 和 Migration，不包含 `.env`。
- `infra/scripts/restore-postgres.sh`：恢复前要求 `CONFIRM_RESTORE=YES`，避免误覆盖目标数据库。
- `infra/scripts/verify-stack.sh`：检查 live/ready、Admin 页面和未授权 API 的 401。

生产容器重启不会自动执行 Prisma migration；必须先备份、检查 SQL、在测试库回归，再按 Runbook 显式执行 `docker compose run --rm api npx prisma migrate deploy`。
