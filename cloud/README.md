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

公开注册由 `REGISTRATION_MODE` 控制：`OPEN` 允许公开注册，`INVITE_ONLY` 禁止公开注册并仅保留受控后台流程创建用户，`DISABLED` 关闭公开注册。三种模式都保留 Better Auth 的密码验证和管理员创建用户能力；邀请实体与邀请链接流程需在业务侧另行接入。

密码找回由 Better Auth 生成一次性链接，并通过 `PASSWORD_RESET_WEBHOOK_URL` 投递给邮件服务；Webhook 使用 `PASSWORD_RESET_WEBHOOK_SECRET` 对原始 JSON 请求体计算 HMAC-SHA256，签名放在 `X-Agent-Board-Signature`。生产环境必须配置 HTTPS Webhook 和至少 32 位签名密钥，API 不记录重置链接、Token 或密码。

## API / Admin E2E

在已完成 Migration、并准备好独立测试管理员账号的测试环境中执行真实 HTTP 验收。脚本不会读取 `.env`，也不会输出密码、Cookie 或 Token；缺少变量时会直接失败，不会跳过测试：

```bash
E2E_API_URL=https://api.test.example.com \
E2E_ADMIN_URL=https://admin.test.example.com \
E2E_ADMIN_EMAIL=admin@test.example.com \
E2E_ADMIN_PASSWORD='仅注入测试进程' \
  npm run e2e:smoke
```

它会验证 live/ready、匿名请求的 401、Better Auth 登录、用户接口、Admin 权限接口和 Admin 页面。生产验收仍须在受控窗口执行，并继续按部署 Runbook 做页面/API/数据库三重核对。

具备隔离 PostgreSQL 测试库时，可运行完整页面/API/数据库验收脚本。它使用唯一测试数据，不会清空数据库；除显式注入的 API 地址、管理员凭据和数据库连接串外，不读取任何 `.env`，也不会输出凭据：

```bash
E2E_API_URL=http://127.0.0.1:3200 \
E2E_ORIGIN=http://127.0.0.1:3100 \
E2E_ADMIN_EMAIL=admin@example.com \
E2E_ADMIN_PASSWORD='仅注入测试进程' \
E2E_DATABASE_URL='postgresql://agent_board:password@127.0.0.1:5432/agent_board?schema=public' \
  npm run e2e:acceptance
```

该脚本会真实覆盖注册、Admin 目录与人工授权、兑换幂等、同一码 20 并发、设备签名、Lease/Heartbeat、`KICK_OLDEST`、Refresh Token Reuse，以及 Audit/SecurityEvent 的 PostgreSQL 持久化核对。

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
POST  /v1/admin/users/:id/suspend
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
GET   /v1/admin/agents/:id/move-preview
GET   /v1/admin/agents/:id/ledger
POST  /v1/admin/agents/:id/ledger-adjustment
POST  /v1/admin/agents/:id/users/:userId
POST  /v1/devices/enroll
GET   /v1/devices/me
POST  /v1/devices/:id/revoke
POST  /v1/devices/:id/reset
GET  /v1/license/status
POST /v1/license/acquire
POST /v1/license/heartbeat
POST /v1/license/release
GET   /v1/admin/version-policies
POST  /v1/admin/version-policies
GET   /v1/admin/version-policies/:id
PATCH /v1/admin/version-policies/:id
GET   /v1/admin/security-events
POST  /v1/admin/security-events/:id/resolve
GET   /v1/admin/devices
POST  /v1/admin/devices/:id/revoke
POST  /v1/admin/devices/:id/reset
GET   /v1/admin/online-sessions
GET   /v1/admin/dashboard
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
POST  /v1/desktop/auth/login
POST  /v1/registration/register
POST  /v1/desktop/auth/refresh
POST  /v1/desktop/auth/bind-device
POST  /v1/desktop/auth/logout
```

代理 Portal 路由为 `/agent/dashboard`、`/agent/codes`、`/agent/batches`、`/agent/users`、`/agent/sub-agents`、`/agent/ledger` 和 `/agent/profile`；对应 API 只允许访问当前代理及其下级体系的数据。Agent 使用 `parentAgentId` 邻接表，API 在修改上级时防止循环；代理额度只通过不可变 `AgentLedgerEntry` 计算余额，发码时按 Plan 的 `agentCostCredits` 在同一事务中扣减，余额不足或 Plan 不在白名单时拒绝。

Migration `0015_integrity_constraints` 额外在数据库边界约束账本余额非负、兑换批次数量为正，并为兑换请求建立 `codeId` 唯一索引，和服务层的并发保护形成双重约束。

计划的 `durationSeconds`、设备限制、心跳策略、Feature JSON 和代理成本均来自数据库配置，不在代码中硬编码。人工授权会在同一事务中更新 Entitlement、创建 EntitlementGrant 并写入 AuditLog；有效授权从现有 `expiresAt` 叠加，已过期授权从服务端当前时间计算。

兑换批次会将兑换码以 HMAC-SHA256（服务端 `REDEMPTION_PEPPER`）存储，数据库不保存完整明文。明文只在创建批次的响应中出现一次，并可当次导出 CSV；兑换使用 `Idempotency-Key`（或 body `requestId`），同一码通过状态 CAS 防止并发双花。

桌面版注册使用 `POST /v1/registration/register`，请求必须同时包含邮箱、密码和激活码。服务端先校验激活码，再创建 Better Auth 账号并兑换权益，最后返回桌面端短期访问令牌；无效激活码不会创建账号。`REGISTRATION_MODE=DISABLED` 时该入口也会关闭。

设备注册使用安装标识和 Ed25519 公钥建立设备身份；服务端只保存公钥、指纹摘要和设备元数据，不接收或记录私钥。相同安装标识重复注册会更新最后在线信息而不重复占用设备名额，撤销或封禁设备不能重新接管；设备名额由有效 Plan 的 `maxRegisteredDevices` 控制。用户可查看并撤销自己的设备，管理员可在 `/admin/devices` 查看和撤销全局设备。

在线授权使用 `LicenseLease`。Acquire 与 KICK_OLDEST 在 Serializable 事务中检查并发设备/实例限制，旧租约被撤销后下一次 Heartbeat 返回 `LEASE_REVOKED`。Heartbeat 使用设备 Ed25519 私钥签名的规范化请求体、时间窗口和数据库原子序列号 CAS 防重放；正常心跳只更新租约，不写 AuditLog。租约 TTL、心跳间隔、并发策略和 Feature 均来自 Plan。

Admin Web 的 P0 页面包括 `/admin/dashboard`、`/admin/users`、`/admin/users/:id`、`/admin/agents`、`/admin/agents/:id`、`/admin/products`、`/admin/plans`、`/admin/redemption-batches`、`/admin/redemption-codes`、`/admin/entitlements`、`/admin/devices`、`/admin/online-sessions`、`/admin/security-events`、`/admin/audit-logs`、`/admin/client-versions` 和 `/admin/settings`；旧的 `/admin/version-policies` 保留为兼容入口。

桌面端使用独立的 Desktop Auth：密码校验仍委托 Better Auth，登录后发行 15 分钟访问凭证和设备绑定的 opaque Refresh Token；Refresh 只在数据库保存 HMAC，轮换后的旧令牌再次使用会撤销整个 Token Family 并记录 `REFRESH_TOKEN_REUSE`。Electron 通过 `Authorization: Bearer` 调用业务 API，不把浏览器 Cookie 暴露给渲染层。桌面端需要向运行环境注入 `AGENT_BOARD_CLOUD_URL`、`AGENT_BOARD_PRODUCT_ID` 和 `AGENT_BOARD_LICENSE_SIGNING_PUBLIC_KEY`；私钥仍只保存在 Windows 安全存储中。

Phase 8 的 Offline Grant 使用独立的 `LICENSE_SIGNING_PRIVATE_KEY`（仅 API 进程环境变量）签发，桌面端只需配置对应的 Ed25519 公钥验签。离线可用截止时间取授权到期时间与 `offlineValidUntil` 的较小值；没有离线宽限时不签发凭证。`ClientVersionPolicy` 支持 latest/minimum/force-upgrade，低于最低版本的客户端不能获取或续租。

首次建立管理员时，先通过 Better Auth 注册一个用户，再在测试环境显式执行 `BOOTSTRAP_ADMIN_EMAIL=... npm run admin:promote`；该脚本不会读取密码，也不会自动提升任何账号。

## 安全边界

- `.env`、数据库密码和生产密钥不入库；使用环境变量注入。
- Compose 的 PostgreSQL 和 API 端口都只绑定 `127.0.0.1`；PostgreSQL 只在内部 backend 网络可达，API 另接入不承载其他服务的 egress 网络，用于投递密码找回 Webhook。
- 生产环境要求 HTTPS origin 与至少 32 字符的 `BETTER_AUTH_SECRET`。
- 生产离线授权必须注入 Ed25519 `LICENSE_SIGNING_PRIVATE_KEY`，私钥不进 Git、Admin Web 或日志。
- `SecurityEvent` 记录签名失败、重放、设备/并发超限、版本阻断和限流；Admin 可在 `/admin/security-events` 查看并处置。
- `RATE_LIMITS_JSON` 可按 route 配置 `max` 与 `windowSeconds`，默认覆盖登录、注册、找回密码、刷新、兑换、设备注册、获取租约和心跳。
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
