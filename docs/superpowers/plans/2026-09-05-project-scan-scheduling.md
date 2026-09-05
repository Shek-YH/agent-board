# Project Scan Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent Board 的启动扫描、温项目校对、自动全量扫描和手动重扫统一到一个可合并、可持久化且不并发的智能调度器中。

**Architecture:** 新增一个无文件系统副作用的扫描策略/调度模块，负责活跃度分层、6 小时到期判断、单飞执行和队列合并。`server.js` 负责把调度请求映射到现有 adapter 扫描，文件监听事件在扫描期间进入待处理队列；SQLite adapter 接收统一的 `cutoff` 参数，在启动/温项目扫描时只筛选近期会话。`lib/store.js` 增加扫描时间元数据和脏持久化判断，保持现有 JSON 快照格式兼容。

**Tech Stack:** Node.js CommonJS、Node 内置 `node:test`、现有 `fs.watch`/目录快照、现有 Agent adapter 和 JSON store。

---

## 文件结构与职责

- Create: `lib/scan-scheduler.js` — 时间窗口、活跃度分类、扫描请求合并、定时器和状态机；不直接读取文件或调用 HTTP。
- Create: `lib/scan-scheduler.test.js` — 策略边界、到期判断、互斥和请求合并测试。
- Modify: `lib/store.js:45-270,1180-1225` — 持久化 revision/dirty 状态；暴露读取和写入扫描元数据所需的稳定接口，保留现有数据格式。
- Modify: `lib/store-persistence.test.js` — 无变更不生成快照、扫描批次延迟保存和调度元数据落盘测试。
- Modify: `lib/adapters/marvis.js:200-310` — 支持 `cutoff` 的近期会话筛选。
- Modify: `lib/adapters/hermes.js:430-505` — 支持 `cutoff` 的近期 Session 筛选。
- Modify: `lib/adapters/zcode.js:170-285` — 支持 `cutoff` 的近期 Session 候选筛选。
- Modify: `lib/adapters/marvis.test.js`, `lib/adapters/hermes.test.js`, `lib/adapters/zcode.test.js` — SQLite 数据源的近期/全量扫描回归测试。
- Modify: `server.js:985,1320-1445,1450-1585,2600-2645,2808-2845` — 扫描模式、事件队列、调度器接线、启动调度和手动重扫接线。
- Modify: `server-startup-responsiveness.test.js`, `server-rescan-active.test.js` — 更新扫描入口合同并增加自动/手动互斥检查。
- Create: `server-scan-scheduling.test.js` — 服务端扫描模式、启动顺序、6 小时计时器、事件排队和手动请求合同测试。

### Task 1: 先建立纯策略和调度器的失败测试

**Files:**
- Create: `lib/scan-scheduler.test.js`

- [ ] **Step 1: 写活跃度分层和全量到期的失败测试**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DAY_MS,
  classifyActivity,
  isFullScanDue,
} = require('./scan-scheduler');

test('活跃度使用 session last_seen 与文件 mtime 的较新值', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  assert.equal(classifyActivity({
    lastSeen: now - 2 * DAY_MS,
    fileMtime: now - 2 * 60 * 60 * 1000,
    now,
  }), 'hot');
  assert.equal(classifyActivity({
    lastSeen: now - 40 * DAY_MS,
    fileMtime: now - 3 * DAY_MS,
    now,
  }), 'warm');
  assert.equal(classifyActivity({ lastSeen: 0, fileMtime: 0, now }), 'cold');
});

test('分层边界和全量扫描到期判断稳定', () => {
  const now = Date.now();
  assert.equal(classifyActivity({ lastSeen: now - 24 * 60 * 60 * 1000, fileMtime: 0, now }), 'hot');
  assert.equal(classifyActivity({ lastSeen: now - 7 * 24 * 60 * 60 * 1000 - 1, fileMtime: 0, now }), 'recent');
  assert.equal(classifyActivity({ lastSeen: now - 30 * 24 * 60 * 60 * 1000 - 1, fileMtime: 0, now }), 'cold');
  assert.equal(isFullScanDue(now - 6 * 60 * 60 * 1000, now), true);
  assert.equal(isFullScanDue(now - 6 * 60 * 60 * 1000 + 1, now), false);
});
```

- [ ] **Step 2: 运行策略测试，确认因模块和导出不存在而失败**

Run: `node --test lib/scan-scheduler.test.js`

Expected: FAIL with `Cannot find module './scan-scheduler'`.

### Task 2: 实现纯策略和单一扫描调度器

**Files:**
- Create: `lib/scan-scheduler.js`
- Modify: `lib/scan-scheduler.test.js`

- [ ] **Step 1: 添加固定时间常量和分类函数**

```js
const DAY_MS = 24 * 60 * 60 * 1000;
const HOT_WINDOW_MS = DAY_MS;
const WARM_WINDOW_MS = 7 * DAY_MS;
const RECENT_WINDOW_MS = 30 * DAY_MS;
const WARM_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const FULL_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_FULL_GRACE_MS = 60 * 1000;

function classifyActivity({ lastSeen = 0, fileMtime = 0, known = true, now = Date.now() } = {}) {
  if (!known) return 'hot';
  const activityAt = Math.max(Number(lastSeen) || 0, Number(fileMtime) || 0);
  if (!activityAt) return 'cold';
  const age = Math.max(0, now - activityAt);
  if (age <= HOT_WINDOW_MS) return 'hot';
  if (age <= WARM_WINDOW_MS) return 'warm';
  if (age <= RECENT_WINDOW_MS) return 'recent';
  return 'cold';
}

function isFullScanDue(lastFullScanAt, now = Date.now(), intervalMs = FULL_SCAN_INTERVAL_MS) {
  const last = Number(lastFullScanAt) || 0;
  return !last || now - last >= intervalMs;
}
```

- [ ] **Step 2: 实现调度器的明确接口**

实现 `createScanScheduler(options)`，其中 `options.run(request)` 接受以下请求对象：

```js
{ kind: 'startup-recent', full: false, maxAgeMs: HOT_WINDOW_MS }
{ kind: 'warm-reconcile', full: false, maxAgeMs: WARM_WINDOW_MS }
{ kind: 'scheduled-full', full: true, maxAgeMs: 0 }
{ kind: 'manual-full', full: true, maxAgeMs: 0 }
```

公开方法和行为固定为：`start()`、`request(kind)`、`getState()`、`whenIdle()`、`stop()`。

调用 `whenIdle()` 可等待当前运行和已合并队列全部结束，供测试和手动重扫完成回调使用。

示例：

```js
const scheduler = createScanScheduler({
  run: ({ kind, full, maxAgeMs }) => Promise.resolve({ kind, full, maxAgeMs }),
  readLastFullScanAt: () => 0,
  writeLastFullScanAt: () => {},
  now: () => Date.now(),
});

scheduler.start();
scheduler.request('startup-recent');
scheduler.request('manual-full');
scheduler.getState();
scheduler.whenIdle();
scheduler.stop();
```

调度器必须满足：同一时刻只有一个 `run`；运行中收到 `manual-full` 时将其排在当前任务之后；运行中再次收到任意 full 请求只保留一个；手动 full 优先于 warm；自动 full 只有在 `isFullScanDue()` 为真时入队；启动时到期的自动 full 通过 `STARTUP_FULL_GRACE_MS` 延迟入队；自动 full 成功后才调用 `writeLastFullScanAt(now())`；失败不推进时间戳；`stop()` 清理所有计时器但不丢失当前状态。

- [ ] **Step 3: 增加调度器失败测试和成功测试**

```js
test('扫描请求单飞，手动全量请求会合并到当前扫描之后', async () => {
  const runs = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createScanScheduler({
    run: async (request) => {
      runs.push(request.kind);
      if (request.kind === 'startup-recent') await gate;
    },
    readLastFullScanAt: () => Date.now(),
  });
  const first = scheduler.request('startup-recent');
  scheduler.request('manual-full');
  scheduler.request('scheduled-full');
  assert.deepEqual(runs, ['startup-recent']);
  release();
  await first;
  await scheduler.whenIdle();
  assert.deepEqual(runs, ['startup-recent', 'manual-full']);
  scheduler.stop();
});
```

- [ ] **Step 4: 运行策略测试确认通过**

Run: `node --test lib/scan-scheduler.test.js`

Expected: all scheduler tests PASS.

### Task 3: 给 store 增加扫描元数据和脏持久化判断

**Files:**
- Modify: `lib/store.js:45-270,1180-1225`
- Modify: `lib/store-persistence.test.js`

- [ ] **Step 1: 写无变更不落盘和扫描时间持久化测试**

```js
test('无持久化变更时 flushPersistence 不生成新快照', async () => {
  await store.flushPersistence();
  assert.equal(fs.existsSync(store.DATA_PATH), false);
});

test('扫描时间元数据可以通过现有 meta 快照持久化', async () => {
  store.stmts.setMeta.run('scan:last-full-at', '123456789');
  await store.flushPersistence();
  assert.match(fs.readFileSync(store.DATA_PATH, 'utf8'), /scan:last-full-at/);
});
```

- [ ] **Step 2: 运行测试确认新断言先失败或暴露现有行为**

Run: `node --test lib/store-persistence.test.js`

Expected: the no-change test FAILS because current `flushPersistence()` always calls `save()`; the metadata test remains compatible with the existing meta snapshot path.

- [ ] **Step 3: 用 revision 标记实现最小脏判断**

在 `lib/store.js` 保存以下状态：

```js
let persistenceRevision = 0;
let savedRevision = 0;
```

让 `scheduleSave()` 先递增 `persistenceRevision`，再根据 `persistenceSuppressed` 决定是否创建 timer。`save()` 捕获本次快照对应的 revision，并在写入成功的 finally 中更新 `savedRevision`；如果写入期间 revision 又变化，沿用现有 `saveAgain` 机制。`flushPersistence()` 只有在存在未保存 revision、延迟 timer 或进行中的写入时才调用 `save()`，否则返回 `Promise.resolve()`。

扫描时间统一使用：

```js
const SCAN_LAST_FULL_AT_KEY = 'scan:last-full-at';
```

通过 `store.stmts.getMeta.get(SCAN_LAST_FULL_AT_KEY)?.v` 读取，通过 `store.stmts.setMeta.run(SCAN_LAST_FULL_AT_KEY, String(timestamp))` 写入，不新增数据文件格式。

- [ ] **Step 4: 运行 store 持久化测试确认通过**

Run: `node --test lib/store-persistence.test.js`

Expected: all persistence tests PASS.

### Task 4: 为 SQLite adapter 增加近期扫描 cutoff

**Files:**
- Modify: `lib/adapters/marvis.js:216-300`
- Modify: `lib/adapters/hermes.js:437-505`
- Modify: `lib/adapters/zcode.js:180-260`
- Modify: `lib/adapters/marvis.test.js`
- Modify: `lib/adapters/hermes.test.js`
- Modify: `lib/adapters/zcode.test.js`

- [ ] **Step 1: 为三个 adapter 写近期扫描失败测试**

每个 adapter 的测试都建立一个“旧 Session”和一个“近期 Session”，调用 `scanAll(store, { cutoff })`，断言只有近期 Session 的消息进入测试 store；调用 `scanAll(store, { cutoff: 0 })` 时断言两个 Session 都可被扫描。测试用各自现有 fixture 的 SQLite schema，不读取真实用户目录。

Marvis 用 `conversations.updated_at` 判断候选；Hermes 用 `last_activity_at`、`started_at` 和最新可用消息时间判断候选；ZCode 用每个 session 的最大 `message.time_created` 判断候选。任何缺失或无法解析的活动时间都必须保守地纳入候选，不能因为字段缺失漏掉 Session。

- [ ] **Step 2: 运行三个 adapter 测试确认近期断言失败**

Run: `node --test lib/adapters/marvis.test.js lib/adapters/hermes.test.js lib/adapters/zcode.test.js`

Expected: new cutoff tests FAIL because the existing `scanAll` functions ignore their second argument.

- [ ] **Step 3: 增加兼容的 `scanAll(store, { cutoff = 0 } = {})` 签名**

保留无参数调用的全量语义：

```js
scanAll(store, { cutoff = 0 } = {}) {
  // cutoff === 0: 扫描全部候选；cutoff > 0: 只处理活动时间不早于 cutoff 的候选
}
```

只在候选 Session/Conversation 层过滤，不能改变 adapter 内部已有的 offset、source-id 幂等和拓扑派生逻辑。server 传入 `{ cutoff }` 时，三个 adapter 都必须使用该参数；各自 30 秒/5 秒 `poll` 保持现有即时语义。

- [ ] **Step 4: 运行 adapter 测试确认通过**

Run: `node --test lib/adapters/marvis.test.js lib/adapters/hermes.test.js lib/adapters/zcode.test.js`

Expected: all adapter tests PASS.

### Task 5: 扩展 server 扫描函数为可分层、可排队的运行单元

**Files:**
- Modify: `server.js:985,1320-1450`
- Create: `server-scan-scheduling.test.js`

- [ ] **Step 1: 为 server 扫描模式写失败合同测试**

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('scanAll 支持启动、温项目和全量三种模式', () => {
  assert.match(source, /async function scanAll\(\{ full = false, maxAgeMs/);
  assert.match(source, /maxAgeMs: WARM_WINDOW_MS/);
  assert.match(source, /a\.scanAll\(store, \{ cutoff \}\)/);
});

test('扫描期间文件事件进入队列而不是并发 poll', () => {
  assert.match(source, /pendingChangedPaths/);
  assert.match(source, /if \(isScanning\).*pendingChangedPaths/);
});
```

- [ ] **Step 2: 扩展 `scanAll` 参数并返回统计结果**

将函数签名改为：

```js
async function scanAll({ full = false, maxAgeMs = SCAN_DAYS * DAY_MS, mode = 'recent' } = {})
```

计算 `cutoff` 时使用 `full ? 0 : Date.now() - maxAgeMs`；现有文件扫描逻辑继续使用 `full` 决定 offset 读取方式，未变化文件继续走 offset 快速路径。调用非文件型 adapter 时传入 `a.scanAll(store, { cutoff })`。将 `lastScanMode` 写成传入的 `mode`，并返回 `{ full, mode, files, messages, startedAt, finishedAt }`。

将 `isScanning = false` 和失败清理放入 `try/finally`，确保 adapter 抛错后调度器不会永久认为扫描中。扫描结束时先释放扫描锁，再把 `pendingChangedPaths` 合并交给现有 `pollChanged`，避免扫描期间的文件变化被丢弃。

- [ ] **Step 3: 接入文件事件待处理队列**

新增：

```js
const pendingChangedPaths = new Map();

function queueChangedPath(adapter, filePath) {
  if (!pendingChangedPaths.has(adapter.ID)) pendingChangedPaths.set(adapter.ID, new Set());
  pendingChangedPaths.get(adapter.ID).add(filePath);
  if (!isScanning) drainChangedPaths();
}
```

把 `watchTree(a.ROOT, (p) => pollChanged(a, [p]))` 改为 `watchTree(a.ROOT, (p) => queueChangedPath(a, p))`。`drainChangedPaths()` 只在没有扫描时执行，每个 adapter 调用一次 `pollChanged(adapter, paths)`，完成后清空已消费集合；扫描期间只累积路径。

- [ ] **Step 4: 运行 server 合同测试确认通过**

Run: `node --test server-scan-scheduling.test.js`

Expected: all scan mode and event queue tests PASS.

### Task 6: 接入调度器、启动策略和 6 小时自动全量扫描

**Files:**
- Modify: `server.js:15-25,1320-1450,1475-1585,2808-2845`
- Modify: `server-scan-scheduling.test.js`

- [ ] **Step 1: 在 server 中创建唯一调度器实例**

在 `scanAll` 定义后创建：

```js
const scanScheduler = createScanScheduler({
  run: async ({ kind, full, maxAgeMs }) => {
    if (full) store.clearOffsets();
    return scanAll({ full, maxAgeMs, mode: kind });
  },
  readLastFullScanAt: () => Number(store.stmts.getMeta.get('scan:last-full-at')?.v || 0),
  writeLastFullScanAt: (timestamp) => store.stmts.setMeta.run('scan:last-full-at', String(timestamp)),
  onStateChange: (state) => sseBroadcast('scan', { ...state }),
});
```

自动和手动 full 都走这个 `run` 回调；`clearOffsets()` 只在 full 请求进入实际执行阶段时调用，不在排队阶段调用，避免排队期间改变读取状态。

- [ ] **Step 2: 将启动任务改为近期优先、温项目后台排队**

把 `runStartupTasks()` 中的 `await scanAll()` 改为：

```js
await scanScheduler.request('startup-recent');
void scanScheduler.request('warm-reconcile');
```

`startup-recent` 使用 24 小时窗口，`warm-reconcile` 使用 7 天窗口；二者仍在 `server.listen` 后的 `setImmediate` 中启动，所以已有 JSON 快照可以立即服务首屏。warm 请求不能创建第二个并发扫描。

- [ ] **Step 3: 启动 watcher 调度器并验证自动 full 到期规则**

在 `server.listen` 回调中调用 `scanScheduler.start()`。调度器内部安排每小时一次 warm 请求和每 6 小时一次 full 请求；启动时若 `lastFullScanAt` 到期，先等待 60 秒 grace，再排队自动 full。服务重启时只补做一次，不根据错过的周期数连续执行。

- [ ] **Step 4: 保留现有 adapter 高频 poll，但避免与扫描并发**

保留 DeepSeek/ZCode 30 秒、Hermes 5 秒和 WorkBuddy 状态轮询的业务频率；所有会读写 store 的扫描型 poll 都经过 `isScanning` 或 pending 队列保护。现有标题/心跳轮询在扫描期间继续跳过，扫描结束后由正常 timer 恢复。

- [ ] **Step 5: 加入 scheduler server 合同测试**

测试必须静态确认：

- `runStartupTasks` 请求 `startup-recent` 而不是默认 30 天窗口；
- server 创建 `scanScheduler` 并读取/写入 `scan:last-full-at`；
- `start()` 在监听完成后调用；
- 自动 full、warm 和启动扫描使用统一调度器；
- full 执行调用 `store.clearOffsets()`，但请求排队时不提前清偏移。

- [ ] **Step 6: 运行 server 调度测试确认通过**

Run: `node --test server-scan-scheduling.test.js server-startup-responsiveness.test.js`

Expected: all scheduler integration contracts PASS.

### Task 7: 把手动重新扫描接入同一调度器

**Files:**
- Modify: `server.js:2600-2645`
- Modify: `server-rescan-active.test.js`

- [ ] **Step 1: 更新手动重扫测试，锁定排队语义**

将测试从“初始扫描时返回 409”改为验证：手动请求立即返回后台接受结果；当前已有扫描时不启动第二个扫描，并在当前任务结束后执行一次 `manual-full`。保留“非破坏式、不调用 `store.clearAll()`、完成后广播当前活跃快照”的断言。

- [ ] **Step 2: 将 `/api/rescan` 改为请求 `manual-full`**

保留立即返回 HTTP 响应：

```js
res.writeHead(202, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ ok: true, background: true }));
void scanScheduler.request('manual-full')
  .then(() => {
    store.repairSessionTimestamps();
    store.repairUserQueries();
    sseBroadcast('active', { active: store.getActive(), statuses: store.getRuntimeStatuses() });
  })
  .catch((error) => console.error('[rescan] failed:', error.message));
```

不再在 route 层直接判断 `isScanning`、清 offset 或调用 `scanAll`；这些动作由调度器实际开始 full 时统一完成。若已有 full 正在运行，返回仍为接受状态，但不会重复启动。

- [ ] **Step 3: 运行手动重扫测试确认通过**

Run: `node --test server-rescan-active.test.js`

Expected: all rescan contract tests PASS.

### Task 8: 完成性能指标、回归测试和交付验证

**Files:**
- Modify: `server.js` scan logging around `scanAll`
- Modify: `server-scan-scheduling.test.js`
- Modify: relevant adapter/store tests only when a regression assertion is required

- [ ] **Step 1: 增加扫描统计日志和只读状态字段**

每次扫描记录 `mode`、文件数、候选数、实际解析条数、耗时和是否跳过未变化文件；`/api/state` 或现有健康状态只增加安全的 `lastFullScanAt`、`nextFullScanAt` 和当前扫描模式，不返回文件正文或用户数据。

- [ ] **Step 2: 增加端到端调度场景测试**

覆盖以下顺序：启动优先扫描 → 温项目排队 → 自动 full 到期；覆盖应用重启后 6 小时内不重复 full、离线期间新文件按 `mtime` 进入 hot 候选、扫描期间文件事件在结束后被 poll、失败不推进时间戳、手动 full 合并自动 full。

- [ ] **Step 3: 运行全部相关测试**

Run: `node --test lib/scan-scheduler.test.js lib/store-persistence.test.js lib/adapters/marvis.test.js lib/adapters/hermes.test.js lib/adapters/zcode.test.js server-scan-scheduling.test.js server-startup-responsiveness.test.js server-rescan-active.test.js`

Expected: all listed tests PASS.

- [ ] **Step 4: 运行全量测试和语法检查**

Run: `npm test`

Expected: 0 failed tests; existing skipped tests remain skipped only for their original reasons.

Run: `node --check lib/scan-scheduler.js; node --check lib/store.js; node --check server.js; node --check lib/adapters/marvis.js; node --check lib/adapters/hermes.js; node --check lib/adapters/zcode.js`

Expected: all commands exit with code 0.

- [ ] **Step 5: 检查最终改动范围**

Run: `git diff --check`

Expected: no whitespace errors. Confirm the final diff contains only the scan scheduling implementation, its tests, and the already committed design/plan documents; do not stage or remove unrelated existing worktree changes.
