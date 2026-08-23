# 本地账号与权益令牌基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不配置真实云端或支付服务的前提下，实现可验签、可缓存、可展示且默认不影响免费本地功能的账号权益基础。

**Architecture:** `lib/entitlement.js` 只处理签名令牌和 feature 判断；`lib/auth-cache.js` 只处理独立缓存；`lib/account.js` 组合环境配置、缓存和校验，供 `server.js` 返回无敏感信息的账号状态。前端只展示状态，未来付费路由必须复用服务端的 feature 判断。

**Tech Stack:** Node.js 内置 `crypto`、`fs`、`path`、`os`、`node:test`；原生前端 JavaScript。

设计文档：[2026-08-23-local-account-entitlement-design.md](../specs/2026-08-23-local-account-entitlement-design.md)

---

### Task 1: 签名权益令牌纯函数

**Files:**
- Create: `lib/entitlement.js`
- Test: `lib/entitlement.test.js`

- [ ] **Step 1: 写失败测试**

测试用 `crypto.generateKeyPairSync('ed25519')` 生成临时密钥，构造 `base64url(payload).base64url(signature)`，断言 `verifyEntitlement()` 返回 payload；再覆盖篡改、过期、issuer/audience 不匹配和缺失 `features`。

- [ ] **Step 2: 运行失败测试**

Run: `node --test lib/entitlement.test.js`

Expected: `Cannot find module './entitlement'`。

- [ ] **Step 3: 最小实现**

导出 `verifyEntitlement(token, config, now)` 和 `hasFeature(entitlement, feature)`。使用 `crypto.verify(null, Buffer.from(encodedPayload), publicKey, signature)`，并且只接受 `sub`、`plan`、`features`、`iat`、`exp`、`iss`、`aud`、`jti` 完整且类型正确的 payload。

- [ ] **Step 4: 验证通过**

Run: `node --test lib/entitlement.test.js`

Expected: 所有令牌校验分支 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/entitlement.js lib/entitlement.test.js
git commit -m "feat: 新增 Ed25519 权益令牌校验"
```

### Task 2: 独立账号缓存

**Files:**
- Create: `lib/auth-cache.js`
- Test: `lib/auth-cache.test.js`

- [ ] **Step 1: 写失败测试**

覆盖文件不存在、坏 JSON、保存后读取、清除缓存；测试路径全部使用临时目录。

- [ ] **Step 2: 运行失败测试**

Run: `node --test lib/auth-cache.test.js`

Expected: `Cannot find module './auth-cache'`。

- [ ] **Step 3: 最小实现**

导出 `AUTH_CACHE_PATH`、`loadAuthCache(filePath)`、`saveAuthCache(cache, filePath)`、`clearAuthCache(filePath)`。仅接受 `{ token: string, receivedAt: number }`；保存时写入同目录 `auth.json.tmp` 后 rename。

- [ ] **Step 4: 验证通过**

Run: `node --test lib/auth-cache.test.js`

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/auth-cache.js lib/auth-cache.test.js
git commit -m "feat: 新增独立账号权益缓存"
```

### Task 3: 账号状态服务和本地 API

**Files:**
- Create: `lib/account.js`
- Test: `lib/account.test.js`
- Modify: `server.js`

- [ ] **Step 1: 写失败测试**

覆盖没有 `AGENT_BOARD_AUTH_ISSUER`、`AGENT_BOARD_AUTH_AUDIENCE`、`AGENT_BOARD_AUTH_PUBLIC_KEY` 时返回 `{ state: 'unconfigured', configured: false, account: null, features: [] }`；配置完整但缓存为空时为 `free`；有效 token 时只返回 `id`、`plan`、`expiresAt` 和 feature 列表。

- [ ] **Step 2: 运行失败测试**

Run: `node --test lib/account.test.js`

Expected: `Cannot find module './account'`。

- [ ] **Step 3: 最小实现并接入路由**

`lib/account.js` 导出 `getAccountStatus(opts)` 和 `hasAccountFeature(status, feature)`；环境配置通过 `opts.env` 注入，生产使用 `process.env`。`server.js` 引入该模块，新增：

```text
GET  /api/account/status
POST /api/account/logout
```

登出只清除 auth cache，不修改会话 store；路由响应绝不带 token 或公钥。

- [ ] **Step 4: 验证通过**

Run: `node --test lib/account.test.js && node -e "new Function(require('fs').readFileSync('server.js','utf8'))"`

Expected: 测试与语法检查 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/account.js lib/account.test.js server.js
git commit -m "feat: 新增本地账号状态和退出登录 API"
```

### Task 4: 设置中心账号状态页

**Files:**
- Modify: `public/app.js`
- Test: `public/account-settings.test.js`

- [ ] **Step 1: 写失败测试**

断言设置中心有“账户与方案”入口，且前端为 `unconfigured`、`free`、`active` 三种 `state` 显示对应文案，并调用 `/api/account/logout`。

- [ ] **Step 2: 运行失败测试**

Run: `node --test public/account-settings.test.js`

Expected: 入口和状态页函数尚不存在。

- [ ] **Step 3: 最小实现**

设置中心增加账户按钮，点击请求 `/api/account/status` 并渲染状态；只有 `active` 或存在无效缓存时展示“退出登录/清除缓存”，不出现购买或收费按钮。

- [ ] **Step 4: 验证通过**

Run: `node --test public/account-settings.test.js && node -e "new Function(require('fs').readFileSync('public/app.js','utf8'))"`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add public/app.js public/account-settings.test.js
git commit -m "feat: 设置中心展示账户与方案状态"
```

### Task 5: 总体验证

**Files:** 无新增代码。

- [ ] **Step 1: 全量测试**

Run: `node --test`

Expected: 全部 PASS。

- [ ] **Step 2: 本机 API 验证**

Run: `Invoke-RestMethod http://127.0.0.1:4876/api/account/status | ConvertTo-Json`

Expected: 未配置云端时返回 `state: "unconfigured"`，现有看板和应用管理不受影响。

- [ ] **Step 3: 审查和提交**

Run: `git diff --check && git status --short`

Expected: 无空白错误；每个任务已各自提交。
