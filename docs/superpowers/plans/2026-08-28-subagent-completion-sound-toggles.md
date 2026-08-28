# 子代理完成提示音开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有提示音设置页增加单个 Agent 和一键全开/全关的完成提示音开关，并保留每个 Agent 已选择的音频。

**Architecture:** 在现有 `assignments` 声音绑定旁增加可选的 `disabledAgents` 持久化字段。前端用声音绑定与禁用列表共同计算开关状态，单项和批量操作共用一个后端启用接口；关闭只写入禁用状态，不清除声音绑定，因此重新开启无需重新选择音频。旧配置没有 `disabledAgents` 时继续按已有绑定播放。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Node.js `node:test`、现有 HTTP API。

---

### Task 1: 扩展声音设置持久化与启用接口

**Files:**
- Modify: `lib/sound-settings.js`
- Test: `lib/sound-settings.test.js`

- [x] **Step 1: Write the failing test**

为 `lib/sound-settings.test.js` 增加测试：单个开关和批量开关写入 `disabledAgents`，但保留 `assignments`；重新开启后移除禁用状态；空禁用列表不写入冗余字段。

- [x] **Step 2: Run test to verify it fails**

Run: `node --test lib/sound-settings.test.js`
Expected: FAIL because `setSoundEnabled` and `setSoundsEnabled` are not exported.

- [x] **Step 3: Write minimal implementation**

在 `loadSoundSettings` 中兼容可选的字符串数组 `disabledAgents`；新增 `setSoundEnabled(agent, enabled, paths)` 和 `setSoundsEnabled(agents, enabled, paths)`，校验 Agent 字符串及布尔值，更新禁用集合并通过现有原子写入保存。

- [x] **Step 4: Run test to verify it passes**

Run: `node --test lib/sound-settings.test.js`
Expected: PASS。

### Task 2: 接入服务端单个/批量开关 API

**Files:**
- Modify: `server.js`
- Test: `server-sound-security.test.js`

- [x] **Step 1: Write the failing test**

为服务端源码契约测试增加断言：存在 `/api/sounds/enabled`、仅接受 `AGENT_DEFS` 中的 Agent、校验 `enabled` 为布尔值，并调用批量启用函数。

- [x] **Step 2: Run test to verify it fails**

Run: `node --test server-sound-security.test.js`
Expected: FAIL because the new endpoint is absent。

- [x] **Step 3: Write minimal implementation**

新增 `POST /api/sounds/enabled`：接受 `{ agents: string[], enabled: boolean }`，校验数组非空且每个 Agent 都是 `AGENT_DEFS` 自有键，调用 `soundSettings.setSoundsEnabled`，返回最新设置；错误响应延续现有声音 API 的安全摘要。

- [x] **Step 4: Run test to verify it passes**

Run: `node --test server-sound-security.test.js`
Expected: PASS。

### Task 3: 在设置页增加单 Agent 与全局开关

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Test: `public/completion-sound.test.js`

- [x] **Step 1: Write the failing test**

为前端契约测试增加断言：设置页包含 `disabledAgents` 状态、单 Agent 开关、全局开关、`/api/sounds/enabled` 请求，以及完成播放前的禁用检查。

- [x] **Step 2: Run test to verify it fails**

Run: `node --test public/completion-sound.test.js`
Expected: FAIL because the new switch markup and request are absent。

- [x] **Step 3: Write minimal implementation**

在 Agent 列表每行增加可访问的 `role="switch"` 单项按钮，在标题栏增加根据当前状态显示“全部开启/全部关闭”的按钮；切换时保留声音绑定并刷新当前面板。`markRecentlyCompleted` 先检查 `disabledAgents`，禁用时不播放；兼容旧配置的现有绑定逻辑。补充 CSS，使按钮在截图所示的左右 B 布局中与现有列表、边框和主题变量一致，并增加窄屏换行规则。

- [x] **Step 4: Run test to verify it passes**

Run: `node --test public/completion-sound.test.js public/sound-settings-ui.test.js`
Expected: PASS。

### Task 4: 全量验证与差异检查

**Files:**
- Verify: `agent-board/public/app.js`, `agent-board/public/index.html`, `agent-board/lib/sound-settings.js`, `agent-board/server.js`

- [x] **Step 1: Run focused tests**

Run: `node --test lib/sound-settings.test.js server-sound-security.test.js public/completion-sound.test.js public/sound-settings-ui.test.js`
Expected: PASS。

- [x] **Step 2: Run the full project test suite**

Run: `npm test`
Expected: all existing tests pass。

- [x] **Step 3: Review the final diff**

Run: `git diff --check; git diff --stat; git status --short`
Expected: no whitespace errors，只有本需求相关源码、测试和计划文件发生变化；不上传、不部署、不删除用户音频。
