# Agent Board：本地账号与权益令牌基础 —— 设计文档

日期：2026-08-23

## 目标

为将来的云端账号、订阅和计费建立可验证的本地客户端闭环：Agent Board 能读取并校验云端签发的 Ed25519 权益令牌、独立缓存有效令牌、展示账号状态，并为未来付费 API 提供服务端门禁。

## 范围

本轮实现：

- 紧凑签名令牌（`base64url(payload).base64url(signature)`）的 Ed25519 验签与声明校验。
- 独立的本地缓存文件 `%LOCALAPPDATA%\\AgentBoard\\auth.json`，不复用会被全量重扫清理的会话存储。
- `GET /api/account/status` 和 `POST /api/account/logout`；未配置云端时明确返回 `unconfigured`，不影响现有免费功能。
- 一个纯函数形式的 feature 门禁，供后续跨设备/团队聚合等付费端点复用。
- 设置中心的“账户与方案”入口与只读状态页。

本轮不实现：

- 真实注册/登录、邮箱或 OAuth、云端数据库、支付页面、订阅续费、支付 webhook、退款、税务和生产部署。
- 机器指纹、会话正文/项目路径上传，或把现有单机看板能力锁成付费功能。

这些事项需要用户选择身份方式、云服务、域名、商家主体、支付服务商和生产密钥后才能安全上线。

## 令牌与校验

云端将来签发的 payload 使用：

```json
{
  "sub": "user_123",
  "plan": "pro",
  "features": ["team-sync"],
  "iat": 1787510400000,
  "exp": 1787683200000,
  "iss": "https://account.example.com",
  "aud": "agent-board",
  "jti": "token_abc"
}
```

- 签名覆盖 payload 的 base64url 文本；客户端只接收公钥，私钥绝不进入仓库、本地配置或客户端。
- 必填声明：`sub`、`plan`、`features`、`iat`、`exp`、`iss`、`aud`、`jti`；`features` 必须为字符串数组，`exp` 必须晚于 `iat`。
- 仅当配置了 issuer、audience、公钥且验签/声明/到期时间均有效时令牌才是 `active`；否则缓存不会授予任何付费权益。
- 令牌过期、损坏、签名错误和 issuer/audience 不匹配全部降级为免费状态；后续云端刷新可在此基础上加离线宽限策略，但本轮不自行假定宽限天数。

## 本地缓存

`auth.json` 格式：

```json
{
  "token": "<signed-token>",
  "receivedAt": 1787510400000
}
```

- 读取失败、坏 JSON 或字段类型错误视为空缓存，不抛异常。
- 写入使用同目录的临时文件后 rename，避免半写入破坏最后一个可用缓存。
- 登出只删除这个独立缓存；不会触及会话数据、用户工具路径覆盖或启动命令覆盖。

## API 与门禁

`GET /api/account/status` 始终可调用，响应：

```json
{
  "state": "unconfigured | free | active",
  "configured": false,
  "account": null,
  "features": []
}
```

配置完成且令牌有效时，`account` 含 `id`、`plan`、`expiresAt`，但不暴露原始 token。

`POST /api/account/logout` 清空本地缓存，返回同样的免费状态。未来付费路由以 `hasFeature(status, feature)` 为唯一服务端权威；前端隐藏按钮只能改善体验，不能充当安全控制。

## 前端

设置中心增加“账户与方案”。打开后请求 `/api/account/status`：

- `unconfigured`：解释账号服务尚未配置，当前本地单机功能可继续免费使用。
- `free`：显示当前为免费方案，并提供“清除本地登录缓存”按钮（仅在存在缓存但不再有效时显示）。
- `active`：显示方案、到期时间与权益列表，提供“退出登录”按钮。

本轮没有可付费功能，因此不显示购买、订阅或伪造的价格按钮。

## 测试

- `lib/entitlement.test.js`：临时生成 Ed25519 密钥，覆盖有效令牌、签名篡改、过期、issuer/audience 不匹配、声明缺失及 feature 查询。
- `lib/auth-cache.test.js`：覆盖不存在文件、坏 JSON、原子写入读取、清除缓存。
- 前端源文件测试：确保设置中心入口和三种状态文案存在。
- 手工验证：本机未配置云端时 `/api/account/status` 返回 `unconfigured`，设置页显示免费功能不受影响。
