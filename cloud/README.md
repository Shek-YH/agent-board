# Agent Board Cloud

Phase 1–5 的独立云端服务，负责身份、Admin 用户管理、RBAC、审计、产品计划目录、授权、兑换、分级代理和额度账本。它不进入现有 Electron 桌面包，也不读取桌面端会话正文。

## 本地启动

1. 复制 `.env.example` 为 `.env`，只填入本地开发值。
2. 启动 PostgreSQL、API 和 Admin Web：`docker compose up -d`。
3. 安装依赖：`npm ci`。
4. 生成 Prisma Client：`npm run prisma:generate`。
5. 应用迁移：`npm run prisma:migrate:deploy`。
6. 启动 API：`npm run dev`。

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

首次建立管理员时，先通过 Better Auth 注册一个用户，再在测试环境显式执行 `BOOTSTRAP_ADMIN_EMAIL=... npm run admin:promote`；该脚本不会读取密码，也不会自动提升任何账号。

## 安全边界

- `.env`、数据库密码和生产密钥不入库；使用环境变量注入。
- Compose 的 PostgreSQL 和 API 端口都只绑定 `127.0.0.1`。
- 生产环境要求 HTTPS origin 与至少 32 字符的 `BETTER_AUTH_SECRET`。
- 当前阶段不包含宝塔配置、生产 Migration 或生产部署操作。
