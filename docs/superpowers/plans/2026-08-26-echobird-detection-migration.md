# EchoBird Agent Detection Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use systematic-debugging and test-driven-development while implementing this plan.

**Goal:** 将 EchoBird `tool_manager` 的分层安装探测策略迁移到 Agent Board，并为当前尚未接入会话扫描的 AI Agent 预置探测定义。

**Architecture:** 保留现有 Node.js 零依赖探测 API 和会话 adapter；在 `lib/detect.js` 中加入 PATH、环境变量、Windows 注册表增强、MSIX 和弱配置目录探测；在独立的 `lib/agent-detection-catalog.js` 中维护“只探测”工具。应用管理合并两类结果，只有已有会话 adapter 的 Agent 才参与看板扫描。

**Tech Stack:** Node.js built-ins, `node:test`, Windows `where.exe`/`reg.exe`, filesystem probing.

---

### Task 1: 建立探测回归契约

**Files:** `lib/detect.test.js`, `docs/superpowers/plans/2026-08-26-echobird-detection-migration.md`

- 为 PATH 命令、环境变量路径、注册表大小写/单词边界/Publisher、UninstallString、MSIX、配置目录添加失败测试。
- 验证测试在实现前确实失败，锁定当前漏检行为。

### Task 2: 迁移 EchoBird 分层探测链

**Files:** `lib/detect.js`, `lib/detect.test.js`

- 增加可注入的命令解析，Windows 使用 `where.exe`，Unix 使用 `command -v`。
- 增强注册表解析和有限目录扫描，不把卸载程序误认成主程序。
- 支持 `launchUri` 对应的 `%LOCALAPPDATA%\\Packages` MSIX 检测。
- 仅在没有权威安装来源命中时，使用显式 `detectByConfigDir` 的配置目录作为弱信号。

### Task 3: 补齐当前 Agent 的探测描述

**Files:** `lib/adapters/claude.js`, `lib/adapters/codex.js`, `lib/adapters/deepseek.js`, `lib/adapters/pi.js`, `lib/adapters/hermes.js`, `lib/adapters/workbuddy.js`, `lib/adapters/zcode.js`

- 为 CLI adapter 声明 command/envVar，使 PATH 和自定义环境变量探测可用。
- 为已有桌面 Agent 补齐 EchoBird 来源的 install hint / launch URI / 路径候选。
- 不改变会话数据源、启动命令和已有 API 字段兼容性。

### Task 4: 预置未接入会话扫描的 AI Agent

**Files:** `lib/agent-detection-catalog.js`, `server.js`, `public/app.js`, `lib/detect.test.js`

- 录入 EchoBird 中明确属于 AI/coding agent 的路径定义。
- 应用管理展示这些“预置探测”状态，但标记 `probeOnly`，不参与 `scanAll`，不显示误导性的自动配置按钮。
- 保留以后将 catalog 条目升级成正式 adapter 的清晰边界。

### Task 5: 验证

- `node --test lib/detect.test.js`
- `npm test`
- `node --check lib/detect.js`, `node --check server.js`
- 实机 `GET /api/agents/status?force=1`，确认已有 Agent 与预置 Agent 均返回稳定结果。

