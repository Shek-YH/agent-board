# Agent Board Cloud

Phase 1 的独立云端基础服务，负责身份、数据库连接和健康检查。它不进入现有 Electron 桌面包，也不读取桌面端会话正文。

## 本地启动

1. 复制 `.env.example` 为 `.env`，只填入本地开发值。
2. 启动 PostgreSQL：`docker compose up -d postgres`。
3. 安装依赖：`npm ci`。
4. 生成 Prisma Client：`npm run prisma:generate`。
5. 应用迁移：`npm run prisma:migrate:deploy`。
6. 启动 API：`npm run dev`。

API 默认监听 `127.0.0.1:3200`，健康检查为：

```text
GET /health/live
GET /health/ready
```

Better Auth 的 Web 身份路由由 NestJS 模块挂载；业务角色、Entitlement、Device、Lease 等不放入 Better Auth user 表，后续阶段逐步增加。

## 安全边界

- `.env`、数据库密码和生产密钥不入库；使用环境变量注入。
- Compose 的 PostgreSQL 和 API 端口都只绑定 `127.0.0.1`。
- 生产环境要求 HTTPS origin 与至少 32 字符的 `BETTER_AUTH_SECRET`。
- 当前阶段不包含宝塔配置、生产 Migration 或生产部署操作。
