# v3.9 Detection and Session Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix v3.9 Agent discovery/startup gaps and make session cards show only the final project folder name.

**Architecture:** Keep CLI and Desktop probes as separate variants. Extend the existing user override file in a backward-compatible way, route all desktop overrides through the same detection result used by the UI, and make launch resolvers read the saved desktop path. The existing automatic discovery and launch override APIs remain compatible.

**Tech Stack:** Node.js built-ins, existing detection engine, local HTTP API, native browser JavaScript, Node test runner.

---

### Task 1: Add regression tests for v3.9 discovery and launch failures

**Files:**
- Modify: `lib/detect.test.js`
- Modify: `lib/deepseek-desktop-path.test.js`
- Modify: `lib/marvis-desktop-path.test.js`

- [x] **Step 1: Add failing tests**

Cover DeepSeek registry/path detection for `D:\\deepseek\\DSH Desktop\\DSH Desktop.exe`, Marvis executable detection under `C:\\Program Files (x86)\\Marvis\\Application\\...`, old CLI override arrays, new `{cli,desktop}` overrides, nonexistent DeepSeek fallback returning `''`, and desktop override precedence.

- [x] **Step 2: Run focused tests**

Run: `node --test lib/detect.test.js lib/deepseek-desktop-path.test.js lib/marvis-desktop-path.test.js`  
Expected: FAIL on the currently missing v3.9 behavior.

### Task 2: Implement variant-aware overrides and probe definitions

**Files:**
- Modify: `lib/detect.js`
- Modify: `lib/adapters/deepseek.js`
- Modify: `lib/adapters/marvis.js`

- [x] **Step 1: Normalize user overrides**

Make `loadUserOverrides()` return `{agent:{cli:string[],desktop:string[]}}` for new data while accepting old string/array values as CLI paths. Keep malformed files as `{}` and preserve CLI probe behavior.

- [x] **Step 2: Add desktop override support**

Make `probeAgent()` pass desktop overrides to `probeDefinition()` and export `saveDesktopUserOverride()`. Return `desktopSource:'override'` when the desktop path wins.

- [x] **Step 3: Complete DeepSeek and Marvis probe definitions**

Add the v3.9 custom executable paths, registry display-name/publisher hints, and executable names. Put Marvis executable paths before the data directory so an existing data directory cannot mask the real executable path.

- [x] **Step 4: Run focused detection tests**

Run: `node --test lib/detect.test.js`  
Expected: PASS.

### Task 3: Repair DeepSeek and Marvis launch path resolution

**Files:**
- Modify: `lib/deepseek-desktop-path.js`
- Modify: `lib/marvis-desktop-path.js`
- Modify: `marvis-launch.bat`

- [x] **Step 1: Make missing DeepSeek paths fail honestly**

Return `''` when no candidate exists instead of returning the first nonexistent candidate. Read an existing desktop override before automatic candidates.

- [x] **Step 2: Add Marvis installation roots and override precedence**

Support `ProgramFiles(x86)\\Marvis` and `ProgramFiles\\Marvis`, including versioned `Application` directories, and read the saved desktop override before automatic candidates.

- [x] **Step 3: Run launch path tests**

Run: `node --test lib/deepseek-desktop-path.test.js lib/marvis-desktop-path.test.js public/marvis-session-jump.test.js`  
Expected: PASS.

### Task 4: Add the manual path API and application-manager UI

**Files:**
- Modify: `server.js`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/agent-manager-actions.test.js`

- [x] **Step 1: Add failing API/UI contract assertions**

Assert the new `override-path` route exists, accepts `kind=cli|desktop`, rejects non-absolute or unsupported extensions, returns a warning for nonexistent files, exposes manual source metadata, and the UI contains manual-path controls plus clear/reprobe actions.

- [x] **Step 2: Implement the endpoint**

Add `POST /api/agents/:id/override-path`, validate agent, kind, absolute path and extension, save the selected variant, invalidate `probeCache`, and return `{ok,agent,kind,path,warning,overrides}`. Keep saving nonexistent paths allowed with a warning.

- [x] **Step 3: Implement the card controls**

Add a manual configuration expander with CLI/Desktop choice, path input, save and clear actions. Show `手动配置` when the detection source is override, and use the existing launch override helper only when the user requests startup synchronization.

- [x] **Step 4: Run focused UI/API tests**

Run: `node --test public/agent-manager-actions.test.js`  
Expected: PASS.

### Task 5: Implement final project-folder labels and run all v3.9 regression checks

**Files:**
- Modify: `public/app.js`
- Create or modify: `public/project-label.test.js`

- [x] **Step 1: Add path-label tests**

Assert `C:\\Projects\\agent-board` renders `agent-board`, `/work/app` renders `app`, `C:\\` renders `C:\\`, trailing separators are ignored, and empty paths render the existing placeholder.

- [x] **Step 2: Replace the current tail truncation helper**

Make session cards show the final directory segment and keep the full path in the existing `title` attribute and copy action.

- [x] **Step 3: Run the complete verification set**

Run: `node --test lib/detect.test.js lib/deepseek-desktop-path.test.js lib/marvis-desktop-path.test.js public/agent-manager-actions.test.js public/project-label.test.js`, then `npm test` and `git diff --check`.
