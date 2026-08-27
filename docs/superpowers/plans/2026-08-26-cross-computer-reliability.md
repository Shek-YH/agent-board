# Agent Board 跨电脑可靠性修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent Board 在不同 Windows 电脑上使用时，启动、session 读取、监听补偿、错误提示和打包路径都具备可诊断、可恢复的行为。

**Architecture:** 保留现有本地 server + Electron 架构，把文件监听降级为“事件加速、定时校准兜底”，把运行实例身份和健康状态显式暴露给前端与 watchdog；全量重扫直接绕过 30 天窗口，并在文件被替换或截断时重置读取 offset。路径和构建脚本只依赖当前项目、当前用户环境和项目内 runtime，不携带开发机绝对路径。

**Tech Stack:** Node.js built-in HTTP/SSE, Electron, `node:test`, PowerShell, electron-builder。

---

### Task 1: 文件扫描与 offset 自愈

**Files:**
- Modify: `lib/watcher.js`
- Modify: `server.js`
- Test: `lib/watcher.test.js`
- Test: `server-rescan-active.test.js`

- [ ] 写测试：验证快照能发现新增、修改、删除；验证文件 inode/size 变化时应重置 offset；验证 full scan 不受 30 天 cutoff 限制。
- [ ] 运行相关测试并确认先因缺少新行为失败。
- [ ] 实现 watcher 快照差异、缺失目录轮询、文件替换/截断检测和 `scanAll({full:true})`。
- [ ] 运行相关测试并确认通过。

### Task 2: 运行身份、健康诊断和 watchdog 协调

**Files:**
- Create: `lib/runtime-marker.js`
- Modify: `server.js`
- Modify: `agent-board-watchdog.js`
- Modify: `desktop/backend-process.js`
- Test: `lib/runtime-marker.test.js`
- Test: `desktop/backend-process.test.js`

- [ ] 写测试：运行 marker 仅在 PID/端口身份匹配时被 watchdog 视为可用；backend 子进程提前退出时等待立即失败。
- [ ] 运行测试确认失败。
- [ ] 实现 marker、`/api/health`、collector 状态、watchdog 端口/身份复用和 backend 早退检测。
- [ ] 运行测试确认通过。

### Task 3: 前端错误可见化与跨平台桌面路径

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `desktop/paths.js`
- Modify: `desktop/main.js`
- Test: `desktop/paths.test.js`

- [ ] 写测试：非 2xx、错误 JSON、超时请求必须产生可读错误；darwin/Linux 数据目录不得拼接 Windows 路径。
- [ ] 运行测试确认失败。
- [ ] 实现统一 API 请求包装、健康状态展示、session/board 请求错误提示、桌面外链异常捕获和平台数据路径。
- [ ] 运行测试确认通过。

### Task 4: 可复现构建和验收

**Files:**
- Modify: `tools/prepare-runtime.ps1`
- Modify: `tools/verify-package.js`
- Modify: `README.md`

- [ ] 写或补充构建验收测试，确保不再依赖开发机绝对路径，并明确 runtime 来源和版本。
- [ ] 运行测试确认失败。
- [ ] 实现项目内 runtime 优先、版本校验、通用路径泄漏检查和安装包使用说明。
- [ ] 运行完整 `npm test`、构建/包校验（若当前 Electron 二进制可用）并记录未覆盖平台风险。
