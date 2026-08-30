# 最近完成任务快捷跳转 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加一个默认为 `Alt+1` 且可配置的全局快捷键，跳转到 Agent Board 中最新的未读完成 session，并在跳转成功后清除该 session 的“已读”提示。

**Architecture:** 保留现有“激活 Agent Board”快捷键，新增独立的全局快捷键控制器和持久化配置字段。主进程通过 preload IPC 通知隐藏的渲染进程，渲染进程根据 `recentDone`、完成状态和完成时间选择目标，复用现有 Agent session 深链跳转；成功时目标 Agent 自己被调到前台，并只在成功后调用现有 dismiss 逻辑。

**Tech Stack:** Electron 44、Node.js 内置 `node:test`、原生 JavaScript/HTML、localStorage。

---

### Task 1: 扩展快捷键配置模型

**Files:**
- Modify: `desktop/shortcut-settings.js`
- Test: `desktop/shortcut-settings.test.js`

- [x] **Step 1: Write the failing test**

扩展测试，要求默认配置同时包含 `activateApp: 'Alt+`'` 与 `jumpToLatestCompleted: 'Alt+1'`，保存其中一个字段时保留另一个字段，并能读取旧的单字段配置。

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="快捷键设置"`  
Expected: FAIL，因为当前配置只有 `activateApp`，没有 `jumpToLatestCompleted`。

- [x] **Step 3: Write minimal implementation**

新增 `DEFAULT_JUMP_SHORTCUT`，让 `defaultSettings()` 返回两个字段；加载时分别校验两个字段，保存时接受 `{ activateApp, jumpToLatestCompleted }` 并对未提供字段回退已有配置/默认值，同时兼容原有字符串保存调用。

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="快捷键设置"`  
Expected: PASS。

### Task 2: 增加纯函数选择器

**Files:**
- Create: `public/recent-completed-jump.js`
- Create: `public/recent-completed-jump.test.js`

- [x] **Step 1: Write the failing test**

通过 VM 加载浏览器脚本，测试 `findLatestEligibleCompletion`：从多个完成 session 中选择完成时间最新者，排除活跃、非 completed、已 dismiss、过期和没有 `recentDone` 时间戳的 session；无候选时返回 `null`。

- [x] **Step 2: Run test to verify it fails**

Run: `node --test public/recent-completed-jump.test.js`  
Expected: FAIL，因为选择器文件尚不存在。

- [x] **Step 3: Write minimal implementation**

暴露 `window.AgentBoardRecentCompletedJump.findLatestEligibleCompletion(sessions, options)`，按 `recentDone` 中的完成时间倒序选择，且只接受 completed、非 live、未 dismiss、未超过 TTL 的 session。

- [x] **Step 4: Run test to verify it passes**

Run: `node --test public/recent-completed-jump.test.js`  
Expected: PASS。

### Task 3: 主进程注册第二个全局快捷键并打通 IPC

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `desktop/main-shortcut.test.js`

- [x] **Step 1: Write the failing test**

增加源码契约断言：主进程有独立的 `jumpToLatestCompleted` 配置/控制器、`shortcut:jump-latest-completed` 通知和 `jumpToLatestCompleted` IPC 设置字段；preload 暴露对应监听方法。

- [x] **Step 2: Run test to verify it fails**

Run: `node --test desktop/main-shortcut.test.js`  
Expected: FAIL，因为当前主进程只注册一个快捷键且 preload 没有跳转事件监听。

- [x] **Step 3: Write minimal implementation**

保留原 `activateApp` 控制器，新增跳转控制器；启动时分别注册两个配置快捷键，设置 IPC 根据 `kind` 更新对应字段并拒绝与另一快捷键相同的组合；窗口加载中时在 `did-finish-load` 后发送待处理通知，正常运行时不显示 Agent Board 窗口。preload 暴露 `onJumpToLatestCompleted(callback)`。

- [x] **Step 4: Run test to verify it passes**

Run: `node --test desktop/main-shortcut.test.js desktop/shortcut-settings.test.js`  
Expected: PASS。

### Task 4: 设置页面提供两个可录入快捷键

**Files:**
- Modify: `public/app.js`
- Modify: `public/shortcut-settings-ui.test.js`

- [x] **Step 1: Write the failing test**

要求页面包含“激活 Agent Board 到前台”和“跳转到最近完成任务”两组独立输入/录入/保存控件，新功能显示默认 `Alt+1`，保存时通过 `kind: 'jumpToLatestCompleted'` 更新。

- [x] **Step 2: Run test to verify it fails**

Run: `node --test public/shortcut-settings-ui.test.js`  
Expected: FAIL，因为当前页面只有一组快捷键控件，默认值是 `Alt+``。

- [x] **Step 3: Write minimal implementation**

把快捷键设置渲染改成按 `activateApp`、`jumpToLatestCompleted` 两项复用一套录入/保存逻辑，两个控件使用独立 ID 和状态；恢复默认分别恢复对应默认值。

- [x] **Step 4: Run test to verify it passes**

Run: `node --test public/shortcut-settings-ui.test.js`  
Expected: PASS。

### Task 5: 接收快捷键事件、跳转并成功后清除“已读”

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/recent-done.test.js`

- [x] **Step 1: Write the failing test**

增加源码契约断言：页面加载选择器脚本；渲染进程注册 `onJumpToLatestCompleted`；快捷键路径使用最新候选、无候选提示“暂无符合条件的已完成任务”，并在 `await jumpToAgentSession` 成功后才调用 `dismissRecent`。

- [x] **Step 2: Run test to verify it fails**

Run: `node --test public/recent-done.test.js`  
Expected: FAIL，因为当前没有快捷键事件处理和最新候选跳转函数。

- [x] **Step 3: Write minimal implementation**

加载 `/recent-completed-jump.js`；让各 Agent session 打开函数返回成功/失败布尔值；新增 `jumpToLatestCompleted()` 复用选择器和 `jumpToAgentSession()`，成功后 dismiss 并同步卡片，不成功保留“已读”；同时让手动 session 跳转沿用同一成功后清除规则。

- [x] **Step 4: Run test to verify it passes**

Run: `node --test public/recent-done.test.js public/recent-completed-jump.test.js public/shortcut-settings-ui.test.js`  
Expected: PASS。

### Task 6: 全量验证

- [x] **Step 1: Run the complete test suite**

Run: `npm test`  
结果：本功能聚焦测试 27/27 通过；完整套件为 633 项，其中工作区已有的云端授权测试 3 项失败（`cloud-runtime.test.js`），与本次快捷跳转改动无关。

- [x] **Step 2: Inspect the final diff**

Run: `git diff --check; git diff --stat; git status --short`  
Expected: 无空白错误；仅包含本功能涉及的变更，保留工作树中原有的其他用户改动。
