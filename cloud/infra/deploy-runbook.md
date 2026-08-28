# Agent Board 生产部署 Runbook

本 Runbook 只描述经过确认后的生产部署步骤。不要把它当作授权去连接 ECS、宝塔或生产数据库；生产执行必须由有权限的管理员单独确认。

## 1. 部署前确认

1. 确认 ECS 上实际的 Docker、Docker Compose、Nginx、宝塔、Node/镜像运行时、PostgreSQL 镜像版本和当前站点规则；不要用本地版本推断服务器状态。
2. 确认域名：`admin.example.com` 指向 Admin，`api.example.com` 指向 API。
3. 确认 `/etc/agent-board` 只由服务器安全环境提供生产 `.env` 和 `LICENSE_SIGNING_PRIVATE_KEY`，权限最小化；这些内容不进入 Git、镜像、Admin 页面或日志。
4. 执行 [安全组清单](security-group-checklist.md)，确认公网只能访问 80/443，不能访问 5432/3100/3200。
5. 检查本次 Prisma migration SQL，并先在测试数据库执行核心 API 回归。

## 2. 备份后再迁移

在服务器安全 shell 中执行，确保 `DATABASE_URL`、`BACKUP_DIR` 来自受保护环境：

```sh
BACKUP_DIR=/var/backups/agent-board/postgres \
  ./infra/scripts/backup-postgres.sh
STACK_DIR=/srv/agent-board/cloud \
  BACKUP_DIR=/var/backups/agent-board/config \
  ./infra/scripts/backup-stack-config.sh
```

把数据库备份复制到独立存储（例如加密 OSS），不要只留在同一台 ECS。备份后检查 `pg_restore --list` 成功，并按计划在测试数据库实际恢复。

## 3. Compose 部署

```sh
cd /srv/agent-board/cloud
docker compose config --quiet
docker compose build --pull
docker compose up -d postgres
docker compose run --rm api npx prisma migrate deploy
docker compose up -d api admin
docker compose ps
```

迁移是显式步骤；应用容器重启不会自动修改生产 Schema。禁止用 `prisma db push` 代替受控 migration。

生产 `.env` 至少应设置生产 HTTPS origin、随机的 `BETTER_AUTH_SECRET`、`REDEMPTION_PEPPER`、数据库配置、`ADMIN_API_URL` 和 `LICENSE_SIGNING_PRIVATE_KEY`；不要把真实值写入命令行、工单或日志。

## 4. 宝塔反代与 TLS

1. 在宝塔分别建立 Admin/API 站点并申请/配置 HTTPS 证书。
2. 保留宝塔自动维护的 SSL Include、证书路径和 BEGIN/END 标记。
3. 仅把 `infra/nginx-examples/admin-location.conf` 和 `api-location.conf` 中的 `location /` 片段合并进对应站点，不覆盖整个 server 配置。
4. 开启 HTTP 到 HTTPS 跳转，确认 `X-Forwarded-Proto` 被转发；生产 Desktop 只配置 HTTPS API origin。
5. 重载 Nginx 后检查证书链、域名、Cookie 的 Secure/SameSite 行为和 CORS trusted origins。

## 5. 三重验收

页面、API、数据库必须同时验收，不能只看页面显示成功：

```sh
API_URL=https://api.example.com ADMIN_URL=https://admin.example.com \
  ./infra/scripts/verify-stack.sh
```

- 页面：Admin Login、Agent Portal 可打开。
- API：`/health/live` 和 `/health/ready` 为 healthy；未授权 protected API 返回 401/403；授权请求返回 200。
- 数据库：用测试账号实际完成注册/登录、Device 注册、License Lease、兑换、Grant、Audit 写入，并在数据库中核对记录。
- 网络：从公网探测确认 5432、3100、3200 不可达。
- TLS：Admin/API HTTPS 可用，HTTP 跳转 HTTPS，证书未过期。

## 6. 回滚与恢复

1. 应用回滚优先使用上一个已验证镜像/代码版本；不要未经评估回滚 Prisma migration。
2. 恢复到测试库前先验证备份清单；恢复脚本要求显式 `CONFIRM_RESTORE=YES`。
3. 生产恢复前暂停写入、确认目标数据库和备份时间点，并由数据库管理员执行：

```sh
BACKUP_FILE=/var/backups/agent-board/postgres/agent_board_YYYYMMDDTHHMMSSZ.dump \
TARGET_DATABASE_URL='postgresql://...' \
CONFIRM_RESTORE=YES \
  ./infra/scripts/restore-postgres.sh
```

4. 恢复后重新执行 migration 状态检查、三重验收和审计记录核对。
