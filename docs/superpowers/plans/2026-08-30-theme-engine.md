# Theme Engine v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Electron + 原生 HTML/CSS/JS Agent Board 中建立可持久化、可测试、支持 system 模式的语义化多主题引擎，并接入现有设置面板。

**Architecture:** `public/theme-engine.js` 提供声明式 Theme Registry、Resolver、Manager、Persistence 和 DOM Applier。`system` 只表示用户选择模式，实际 DOM 总是应用 `light`/`dark` Definition；所有业务样式通过语义 CSS Variables 和兼容别名消费。主题效果仅使用 root data attributes 与有限 CSS，不触碰 Agent/Session/AutoPilot 状态机。

**Tech Stack:** Electron 44 renderer、原生 HTML/CSS/JavaScript、浏览器 `localStorage`/`matchMedia`、Node.js built-in `node:test` + `vm`。

---

### Task 1: Theme Core 的红测试

**Files:**
- Create: `public/theme-engine.test.js`
- Reference: `public/theme-engine.js`（此任务中尚未实现）

- [ ] **Step 1: 写 Registry/Resolver/Manager 的失败测试**

测试通过 `vm.runInNewContext()` 加载浏览器脚本，并覆盖：Registry 有 9 个内置 Definition；`system` 不作为 Definition；`system` 会按 `matchMedia().matches` 解析；未知配置 fallback；`setTheme()` 持久化 `{ selected, version }`；DOM 收到 `data-theme`、`color-scheme` 和 CSS Variables。

- [ ] **Step 2: 运行红测试并确认失败原因**

Run: `node --test public/theme-engine.test.js`

Expected: FAIL，原因是 `public/theme-engine.js` 尚不存在或未暴露 `window.AgentBoardTheme`，而不是测试语法错误。

### Task 2: Theme Core 与启动恢复

**Files:**
- Create: `public/theme-engine.js`
- Modify: `public/index.html:1-18` and script loading section

- [ ] **Step 1: 实现最小 Theme API**

实现 `ThemeDefinition` 的 JS 数据模型、必填 Token 列表、`validateThemeDefinition()`、`builtinThemes`、`getTheme()`、`getAvailableThemes()`、`migrateThemeSettings()`、`normalizeThemeId()`、`resolveTheme()`、`createThemeManager()`；Manager 暴露 `getSelectedTheme()`、`getResolvedTheme()`、`setTheme(id)`、`getAvailableThemes()`、`subscribe(listener)`。

- [ ] **Step 2: 实现 9 个内置主题和效果 Profile**

注册 Light、Dark、Arctic、CRT Green、Ember、Miami、Synthwave、Terminal、Vapor；每个 Definition 都完整提供 PRD Token，`builtin=true`、`version=1`、`premium=false`，效果只使用 `none/soft/neon`、`scanlines`、`gradientBackground`、`noise`、`shadow`、`motion`、`radiusPreset` 等声明式字段。

- [ ] **Step 3: 实现持久化、system observer 和 DOM applier**

使用单一 key `agent-board-theme` 保存 `{ selected, version: 1 }`；读取旧字符串和旧主题别名时无损迁移；未知 ID fallback 到 `system`；按 `matchMedia('(prefers-color-scheme: dark)')`解析；应用 `document.documentElement.dataset.theme`、`data-theme-selected`、`data-theme-effect`、`style.colorScheme` 和 `--kebab-case-token`；系统变化只在 selected 为 `system` 时重应用并通知订阅者。

- [ ] **Step 4: 将 Manager 提前初始化**

在 `index.html` 的首个样式块之前加载 `/theme-engine.js`，紧接着创建并初始化 `window.AgentBoardThemeManager`，确保渲染 App 前已有 root attribute 和 inline CSS Variables；页面不 reload、不重挂载。

- [ ] **Step 5: 运行绿测试**

Run: `node --test public/theme-engine.test.js`

Expected: 新增核心测试全部 PASS。

### Task 3: 语义 Token、效果与可访问性

**Files:**
- Modify: `public/index.html:9-26`, core/session/overlay CSS blocks

- [ ] **Step 1: 建立语义 Token 默认值和旧变量别名**

声明 PRD 的 global、surface、brand、status、agent、session、sidebar、input、code/terminal、scrollbar、overlay Token，并把现有 `--bg/--card/--text/--text2/--text3/--accent/--accent-bg/--radius/--shadow` 映射到语义变量，保持既有布局和业务 DOM 不变。

- [ ] **Step 2: 迁移核心区域的硬编码颜色**

将 App、Sidebar/project rail、Session card 各状态、Agent 状态、Input、Dialog、Popover、Toast、Settings 和 Scrollbar 的背景/前景/边框改为语义变量；Agent identity color 仍允许作为 Agent 图标/标签的身份色，不把它误当成主题状态色。

- [ ] **Step 3: 添加有限效果和 Reduced Motion**

使用 `data-theme-effect` 添加一个全局 CRT scanline overlay 和轻量 neon/gradient/warm 视觉增强；禁止 Card 级 Canvas/高频文字动画；在 `@media (prefers-reduced-motion: reduce)` 下关闭持续动画、pulse、scanline 动画和过渡，并保留主题颜色。

- [ ] **Step 4: 运行静态主题契约测试**

Run: `node --test public/theme-engine.test.js public/session-card-layout.test.js public/session-status.test.js`

Expected: 核心 Token、Reduced Motion、既有 session card/layout/status 测试全部 PASS。

### Task 4: Settings UI 集成

**Files:**
- Modify: `public/app.js` around `openSettingsHub()` and settings helpers
- Modify: `public/index.html` theme settings CSS

- [ ] **Step 1: 从 Registry 渲染主题按钮**

新增 `openThemeSettings()` 和 `renderThemeSettings(pop)`；按钮来自 Manager Registry，包含中文名称/描述、预览色、`type=button`、`aria-pressed`、键盘可操作的 focus-visible 样式；system 按钮显示当前 resolved light/dark。

- [ ] **Step 2: 接入设置入口**

将现有 disabled 的“皮肤设置（开发中）”改为“主题设置”，点击只调用 `themeManager.setTheme(id)`，不直接操作 `document.documentElement`、不修改任何业务状态；点击后即时更新当前按钮与 toast。

- [ ] **Step 3: 运行 UI 源码测试和完整测试**

Run: `node --test public/*.test.js`

Expected: 既有测试与主题相关测试全部 PASS，主题设置入口不再 disabled，原有设置面板功能不回归。

### Task 5: 交付验收

**Files:**
- Modify: `docs/theme-engine-implementation-confirmation.md`（必要时补充验证事实）
- Create: `docs/theme-engine-completion-report.md`

- [ ] **Step 1: 执行完整项目测试**

Run: `npm test`

Expected: exit code 0，报告通过数/失败数；若失败，区分基线失败与本次回归并修复本次改动。

- [ ] **Step 2: 做主题矩阵静态验收**

用测试断言 9 个 Definition 均包含核心 Token、合法 scheme/effects、所有主题可被 Manager 应用；记录 App/Sidebar/Session/Agent/Settings/Dialog/Popover/Toast/Input/Scrollbar 均通过语义变量覆盖。

- [ ] **Step 3: 输出完成报告**

按 PRD 要求记录完成内容、修改文件、新增依赖、架构、兼容处理、许可证、测试结果、运行方式、验证方法和已知限制；明确未实现 Editor/Marketplace/Cloud Sync 等 v1 后续能力。
