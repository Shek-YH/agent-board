# Agent Board Cloud

Phase 1–2 的独立云端服务，负责身份、Admin 用户管理、RBAC 基础、审计和健康检查。它不进入现有 Electron 桌面包，也不读取桌面端会话正文。

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
```

首次建立管理员时，先通过 Better Auth 注册一个用户，再在测试环境显式执行 `BOOTSTRAP_ADMIN_EMAIL=... npm run admin:promote`；该脚本不会读取密码，也不会自动提升任何账号。

## 安全边界

- `.env`、数据库密码和生产密钥不入库；使用环境变量注入。
- Compose 的 PostgreSQL 和 API 端口都只绑定 `127.0.0.1`。
- 生产环境要求 HTTPS origin 与至少 32 字符的 `BETTER_AUTH_SECRET`。
- 当前阶段不包含宝塔配置、生产 Migration 或生产部署操作。
