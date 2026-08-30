# Slice 3 Single Session Auto 实现计划

## 目标

实现 PRD V2.2 Slice 3 的单 Session Auto Loop，并保持 Slice 0-2 的安全边界与兼容性。

## 文件边界

- 新增 `lib/orchestrator/fsm.js` 及测试：固定 Auto 状态、合法迁移和旧 status 映射。
- 新增 `lib/orchestrator/policy-gate.js` 及测试：Auto Dispatch 机械 Gate、危险/权限/重复/预算检查。
- 新增 `lib/orchestrator/watchdog.js` 及测试：迭代、运行时、失败、停滞、重复和 Dispatch 计数。
- 新增 `lib/orchestrator/gui-bus.js` 及测试：按 Agent/Session 串行化 Verified Dispatch。
- 新增 `lib/orchestrator/run-receipt.js` 及测试：安全 Run Receipt 与 Supervisor 摘要。
- 新增 `lib/orchestrator/reconciliation.js` 及测试：WAL pending 恢复和 Delivery 对账。
- 新增 `lib/orchestrator/auto-loop.js` 及测试：单轮 Auto Loop、Supervisor Decision、Verified Dispatch、暂停/完成。
- 修改 `run-contract.js`：允许 `suggest` 与 `auto`，保留默认 Suggest。
- 修改 `workflow-store.js`：持久化 FSM、binding、WAL、dispatch records、decision、receipt 与 Watchdog 计数，并迁移旧快照。
- 修改 `api.js`：接收 Auto binding，提供 evidence、stop、resume、reconcile API 辅助。
- 修改 `runtime.js`：注入 Auto Loop、GuiBus 和恢复对账。
- 修改 `http.js`：Auto `/run`、`/reconcile`、`/evidence`、`/stop`、`/resume` 路由。
- 修改 `server.js`：向 Runtime 注入现有 Verified Dispatch capability 工厂，不改变 Slice 0 路由。
- 修改 `public/index.html`、`public/app.js`、`public/ai-monitor-contract.test.js`：Auto/Suggest 选择、Session binding、FSM/Receipt 展示和受控操作。
- 修改已有编排测试：适配 auto 合同并增加端到端 API/恢复矩阵。

## 顺序

1. 先扩展合同与 Store 迁移，验证旧 Suggest/Voice 不回归。
2. 实现 FSM、Watchdog、Policy Gate、GuiBus、Receipt、WAL/Reconciliation 的纯数据组件。
3. 实现 Auto Loop：只接受单 Session binding，只调用注入的 Verified Dispatch；每次成功送达后停在 WAITING_AGENT。
4. 接入 HTTP 与 Runtime；启动时只做对账，不自动重发。
5. 更新 UI 与契约测试。
6. 运行 Slice 3、Slice 0-2 和全量测试，复核 `main` 与未跟踪构建目录。

## 关键验收

- Auto 无 `sessionRef`、无 capability、Session identity 不强或项目超出 scope 时不发送。
- 任何 Human takeover、permission/danger、Delivery Unverified、身份漂移都进入 PAUSED/需要人工。
- SEND 后异常只产生 reconcile required，不调用第二次 send。
- 显式 Evidence 未覆盖全部 DoD 时不能 DONE；stdout/stderr 不能伪造完成。
- 重启恢复 pending WAL 只对账，不重放旧指令。
- 同一 Agent/Session 并发 Run 串行化。
- Suggest 路径仍不调用 Auto Loop/Verified Dispatch。
