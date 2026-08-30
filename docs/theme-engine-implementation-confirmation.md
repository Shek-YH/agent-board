# Theme Engine 实施确认报告

## 当前实现

- 前端：原生 HTML + CSS + 浏览器端 JavaScript；没有 React/Vue/Svelte、Vite/Webpack、Tailwind、CSS Modules 或现成 UI 组件库。
- 桌面壳层：Electron 44；`desktop/main.js` 负责窗口/后端进程，主题只需要通过渲染进程 DOM/CSS 适配，不改变桌面业务桥接。
- 主题现状：没有 `ThemeProvider`、`data-theme`、`light/dark/system` 管理器；`public/index.html` 有一组 `:root` 颜色变量，但仍存在大量白色、灰色和状态色硬编码。
- 持久化现状：前端已有多个功能各自使用 `localStorage`（列显示、刚完成状态、卡片布局等），没有主题专用 Source of Truth；本次为主题建立独立的 `agent-board-theme` key，值为 `{ selected, version }`。
- 设置入口：`public/app.js` 的 `openSettingsHub()`；“皮肤设置（开发中）”目前是 disabled 占位。

## 可复用模块

- 复用现有原生 DOM 渲染和 `popover` 设置面板，不引入框架。
- 复用现有 CSS Variables（`--bg`、`--card`、`--text`、`--accent` 等）作为兼容别名，逐步映射到语义 Token，避免重写业务组件。
- 复用现有 Electron 渲染窗口和 `prefers-color-scheme`，不增加 Native Theme Adapter；当前窗口与菜单没有需要主题同步的原生 UI。
- 复用 `node --test` 和现有 VM/静态源码测试方式。

## 必须修改模块

- 新增 `public/theme-engine.js`：Theme Definition、Registry、Resolver、Manager、Persistence、DOM Applier、System Observer、效果 profile。
- 新增 `public/theme-engine.test.js`：核心单元测试和浏览器端管理器测试。
- 修改 `public/index.html`：尽早恢复主题、加载语义 Token 默认值、替换核心区域硬编码颜色、加入 Reduced Motion/效果层和主题设置面板样式。
- 修改 `public/app.js`：从 Registry 渲染主题按钮，并通过 Manager 的 `setTheme()` 切换；不让业务组件判断具体主题名。

## 风险与最小适配方案

- 风险：现有业务 CSS 依赖旧变量和部分硬编码颜色。方案是保留旧变量别名，先覆盖 App/Sidebar/Session/Agent/Input/Dialog/Popover/Toast/Settings/Scrollbar，再逐步降低硬编码颜色。
- 风险：启动闪烁。方案是在 `index.html` 样式之前加载主题引擎并初始化 Manager，立即写入 `<html data-theme>`、`color-scheme` 和 CSS Variables。
- 风险：`system` 与实际主题混淆。方案是 Registry 不注册 `system` Definition，只把它作为 selected mode；resolved 始终为 `light` 或 `dark`。
- 风险：损坏/未知配置阻塞启动。方案是 migration + fallback 到 `system`，缺失 Token 通过 base scheme/default 合并，且异常只记录安全日志。
- 风险：特效影响性能/可访问性。方案是全局 CRT overlay、有限 CSS glow/gradient，并统一响应 `prefers-reduced-motion: reduce`。

## 预计修改文件

1. `public/theme-engine.js`（新增）
2. `public/theme-engine.test.js`（新增）
3. `public/index.html`（语义 Token、硬编码颜色迁移、效果与主题面板样式、启动恢复）
4. `public/app.js`（设置 UI 集成）
5. `docs/superpowers/plans/2026-08-30-theme-engine.md`（实施计划）

## 是否新增依赖

否。Theme Engine 全部使用现有浏览器 API 和 Node 内置测试能力；没有复制第三方代码，也不新增 GPL/AGPL 依赖，因此无需新增第三方许可证文件。

## 范围边界

本次实现 PRD v1 MVP 的本地主题基础设施与设置集成；不实现 Theme Editor、Marketplace、云同步、用户上传 CSS/JavaScript、收费逻辑，也不修改 Agent、Session、AutoPilot 的核心行为或数据模型。
