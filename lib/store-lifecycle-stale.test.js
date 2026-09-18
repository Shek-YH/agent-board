'use strict';

// 回归测试：陈旧的生命周期状态（session-lifecycle lifecycleRuntime）不得把已经结束的会话
// 重新标成「进行中」。
//
// 事故现象（2026-09-15）：看板上有 42 个会话显示「进行中」/「正在确认完成」，实际只有 1 个在跑。
// 最久的 lifecycle_state=ACTIVE 已存在 390 小时（16 天）。
//
// 成因链：
//   1) session-lifecycle 引擎只有事件驱动，没有 TTL。没有新事件就不会老化，
//      ACTIVE / COMPLETION_CANDIDATE / WAITING_USER 一旦写入就永久保留。
//   2) lib/store.js 的 withLifecycleStatus() 用这个陈旧值**无条件覆盖**权威 state，
//      把已经 completed 的会话改回 running。
//   3) 前端 lifecycleLiveValue() 返回非 null 时优先于权威 liveRefs → 卡片「进行中」。
//
// 本测试用 runWithStore 在隔离子进程里直接驱动 store 的公开 API，断言最终 runtime_status。

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const HOUR = 3600 * 1000;

/** 在独立 AB_DATA_DIR 的子进程里运行一段针对 store 的断言脚本，返回其 JSON 输出。 */
function runWithStore(lines, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-lifecycle-stale-'));
  try {
    const script = [
      "const store = require('./lib/store');",
      'const out = {};',
      ...lines,
      'process.stdout.write(JSON.stringify(out));',
    ].join('');
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AB_DATA_DIR: dataDir, ...env },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('a stale ACTIVE lifecycle state never resurrects an externally completed session', () => {
  const now = Date.now();
  const out = runWithStore([
    `const ref = 'workbuddy:stale-active';`,
    // 16 天前的 ACTIVE 事件：写入后不会自己老化。
    `store.noteWorkBuddyRuntimeStatus(ref, { sessionId: 'stale-active', state: 'running', lastEventType: 'PreToolUse', lastEventAt: ${now - 390 * HOUR} });`,
    // 外部数据库已确认终态 → 权威 state 必须是 completed。
    `store.noteExternalStatus(ref, { sessionId: 'stale-active', status: 'completed', terminal: true, statusAt: ${now - 300 * HOUR} });`,
    `const s = store.getRuntimeStatuses()['workbuddy:stale-active'];`,
    `out.state = s.state;`,
    `out.lifecycleState = s.lifecycle_state;`,
  ]);
  assert.equal(out.state, 'completed', '权威终态必须胜出，不能被陈旧 ACTIVE 覆盖');
});

test('a stale COMPLETION_CANDIDATE is aged out instead of reported as running', () => {
  const now = Date.now();
  const out = runWithStore([
    `const ref = 'codex:stale-candidate';`,
    // 95 小时前的整轮对话：ingest 会通过 adapter-bridge 推进 lifecycle 到 COMPLETION_CANDIDATE。
    `store.ingest({ agent: 'codex', sourceId: 'sc-1', sessionId: 'stale-candidate', ts: ${now - 95 * HOUR}, role: 'user', kind: 'message', text: 'go' });`,
    `store.ingest({ agent: 'codex', sourceId: 'sc-2', sessionId: 'stale-candidate', ts: ${now - 95 * HOUR + 1000}, role: 'assistant', kind: 'message', text: 'done' });`,
    `store.ingest({ agent: 'codex', sourceId: 'sc-3', sessionId: 'stale-candidate', ts: ${now - 95 * HOUR + 2000}, role: 'assistant', kind: 'turn_end', turnStatus: 'completed' });`,
    `const s = store.getRuntimeStatuses()['codex:stale-candidate'];`,
    `out.state = s && s.state;`,
    `out.lifecycleState = s && s.lifecycle_state;`,
    `out.lifecycle = store.getLifecycleRuntimeStatuses()['codex:stale-candidate'];`,
    `out.live = store.getActive().some((a) => a.sessionRef === ref);`,
  ]);
  // lifecycle 引擎层：95 小时前的 COMPLETION_CANDIDATE 必须收敛，不得仍是完成候选。
  // runtime-store 的投影路径会顺带 advance()，所以稳定窗（5s）早已过去 → 收敛为终态 COMPLETED。
  assert.equal(out.lifecycle && out.lifecycle.publicState, 'COMPLETED', '陈旧完成候选必须收敛为终态');
  // 投影层：终态不是进行中
  assert.notEqual(out.state, 'running', '收敛后的会话不得显示进行中');
  assert.equal(out.live, false, '收敛后的会话不得出现在进行中列表');
});

test('lifecycle aging does not shorten the window for a genuinely running session', () => {
  const now = Date.now();
  const out = runWithStore([
    `const ref = 'codex:fresh-active';`,
    // 5 秒前的活动 → 远在 staleMs 之内，必须仍然是 running。
    `store.ingest({ agent: 'codex', sourceId: 'fa-1', sessionId: 'fresh-active', ts: ${now - 5000}, role: 'user', kind: 'message', text: 'go' });`,
    `store.ingest({ agent: 'codex', sourceId: 'fa-2', sessionId: 'fresh-active', ts: ${now - 4000}, role: 'assistant', kind: 'message', text: 'working' });`,
    `const s = store.getRuntimeStatuses()['codex:fresh-active'];`,
    `out.state = s && s.state;`,
    `out.live = store.getActive().some((a) => a.sessionRef === ref);`,
  ]);
  assert.equal(out.state, 'running', '5 秒前的活动必须仍然是 running');
  assert.equal(out.live, true, '新鲜会话必须在进行中列表内');
});

test('a stale WAITING_USER state does not pin a session in the live window', () => {
  const now = Date.now();
  const out = runWithStore([
    `const ref = 'workbuddy:stale-waiting';`,
    `store.noteWorkBuddyRuntimeStatus(ref, { sessionId: 'stale-waiting', state: 'waiting_user_input', lastEventType: 'Notification', lastEventAt: ${now - 276 * HOUR} });`,
    `store.noteExternalStatus(ref, { sessionId: 'stale-waiting', status: 'completed', terminal: true, statusAt: ${now - 270 * HOUR} });`,
    `const s = store.getRuntimeStatuses()['workbuddy:stale-waiting'];`,
    `out.state = s.state;`,
    `out.live = store.getActive().some((a) => a.sessionRef === ref);`,
  ]);
  assert.equal(out.state, 'completed');
  assert.equal(out.live, false, '陈旧 waiting 会话不得出现在进行中列表');
});

// 回归：真正在跑的会话必须有 runtime_status。
// 曾出现：该会话只有 lastMsgAt（没有 workbuddyRuntime / codexRuntime / stateEngine 条目），
// getRuntimeStatuses 的四个循环都覆盖不到它 → 前端卡片读到 undefined 状态渲染成空，
// 而同时一堆陈旧的 running 卡片照常显示「进行中」，用户看到的正好是反的。
test('a genuinely running session is present in runtime statuses even without runtime entries', () => {
  const now = Date.now();
  const out = runWithStore([
    `const ref = 'workbuddy:live-only';`,
    // 只有真实消息，没有任何 RuntimeStatus / stateEngine 条目的写入。
    `store.ingest({ agent: 'workbuddy', sourceId: 'lo-1', sessionId: 'live-only', ts: ${now - 3000}, role: 'user', kind: 'message', text: 'go' });`,
    `store.ingest({ agent: 'workbuddy', sourceId: 'lo-2', sessionId: 'live-only', ts: ${now - 2000}, role: 'assistant', kind: 'message', text: 'working' });`,
    `const s = store.getRuntimeStatuses()[ref];`,
    `out.hasStatus = Boolean(s);`,
    `out.state = s && s.state;`,
    `out.live = store.getActive().some((a) => a.sessionRef === ref);`,
  ]);
  assert.equal(out.live, true, '3 秒前的活动必须算进行中');
  assert.equal(out.hasStatus, true, '进行中的会话必须在 runtimeStatuses 里有条目');
  assert.equal(out.state, 'running', '进行中的会话状态必须是 running');
});

// 回归：Codex 的「日志证据」必须和 codex-status 用同一条老化规则。
// 曾出现：threadStatus=active 但 lastEventAt 已是 5465–6213 分钟（约 4 天）前，
// codex-status 输出 stale_active（「状态待确认」），可 isLiveRef 的 freshCodexLog 只看
// activeMap.lastActivity，于是同一个会话既在 liveRefs 里、状态又不是 running —— 口径自相矛盾。
test('a codex session whose log evidence is stale must not enter the live window', () => {
  const now = Date.now();
  const out = runWithStore([
    `const ref = 'codex:stale-log';`,
    // 消息早就停了（远超 10 分钟活跃窗）。
    `store.ingest({ agent: 'codex', sourceId: 'sl-1', sessionId: 'stale-log', ts: ${now - 96 * HOUR}, role: 'user', kind: 'message', text: 'go' });`,
    // 运行证据（threadStatus=active）同样陈旧。
    `store.noteCodexThreadStatus(ref, { type: 'active', activeFlags: ['running'] }, ${now - 96 * HOUR});`,
    // 活跃指针也停在 96 小时前（activeMap.lastActivity 同样陈旧）。
    `store.noteCodexActivity(ref, ${now - 96 * HOUR}, {});`,
    `const s = store.getRuntimeStatuses()[ref];`,
    `out.state = s && s.state;`,
    `out.live = store.getActive().some((a) => a.sessionRef === ref);`,
  ]);
  assert.equal(out.live, false, '陈旧的 codex 日志证据不得让会话留在进行中列表');
  assert.notEqual(out.state, 'running', '陈旧证据不得展示为进行中');
});

// 回归：空 sessionId 会产出 `deepseek:` 这种畸形 ref。
// 实测它同时出现在 liveRefs 和卡片列表里 → 渲染出一张永远「进行中」的假卡片。
// ingest 必须拒绝这类消息，而不是替它建一个没有身份的会话。
test('ingest rejects messages without a session id instead of creating a malformed ref', () => {
  const out = runWithStore([
    `out.empty = store.ingest({ agent: 'deepseek', sourceId: 'x-1', sessionId: '', ts: Date.now(), role: 'user', kind: 'message', text: 'no session' });`,
    `out.blank = store.ingest({ agent: 'deepseek', sourceId: 'x-2', sessionId: '   ', ts: Date.now(), role: 'user', kind: 'message', text: 'blank session' });`,
    `out.missing = store.ingest({ agent: 'deepseek', sourceId: 'x-3', ts: Date.now(), role: 'user', kind: 'message', text: 'missing session' });`,
    `out.orphan = Boolean(store.getSession('deepseek:'));`,
    `out.statuses = Object.keys(store.getRuntimeStatuses()).filter((k) => k.endsWith(':'));`,
    `out.live = store.getActive().filter((a) => a.sessionRef.endsWith(':')).map((a) => a.sessionRef);`,
  ]);
  assert.equal(out.empty, null, '空 sessionId 必须被拒绝');
  assert.equal(out.blank, null, '纯空白 sessionId 必须被拒绝');
  assert.equal(out.missing, null, '缺失 sessionId 必须被拒绝');
  assert.equal(out.orphan, false, '不得建立 deepseek: 这种无身份会话');
  assert.deepEqual(out.statuses, [], 'runtimeStatuses 里不得出现畸形 ref');
  assert.deepEqual(out.live, [], '进行中列表里不得出现畸形 ref');
});

// 回归：ingest 的防御只能挡住新消息。已经落进快照的历史脏数据必须由加载侧清洗，
// 否则重启一次就复活一次。
// 实测：data.json 里存着一条 `deepseek:`（session_id="", msg_count=369），
// 它 schema 合法所以每次启动都被读回来，渲染成一张永远「进行中」的假卡片。
test('identityless refs persisted in a snapshot are dropped at load time', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-identityless-'));
  try {
    // 用 store 自己写一份干净快照，拿到正确的 schema，再注入脏记录重写。
    const seedScript = [
      "const store = require('./lib/store');",
      `store.ingest({ agent: 'deepseek', sourceId: 'ok-1', sessionId: 'session-good', ts: Date.now(), role: 'user', kind: 'message', text: 'hello' });`,
      'store.flushPersistence();',
    ].join('');
    const seeded = spawnSync(process.execPath, ['-e', seedScript], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AB_DATA_DIR: dataDir },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(seeded.status, 0, seeded.stderr);

    // 把脏会话与脏消息直接塞进快照文件，模拟历史脏数据（绕过 ingest 防御）。
    const snapshotPath = path.join(dataDir, 'data.json');
    assert.ok(fs.existsSync(snapshotPath), '快照文件应已生成');
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    snapshot.sessions = snapshot.sessions || [];
    snapshot.sessions.push({
      id: 'deepseek:', agent: 'deepseek', session_id: '', project: '', title: '脏卡片',
      first_seen: Date.now() - 1000, last_seen: Date.now(), msg_count: 369,
    });
    snapshot.messages = snapshot.messages || [];
    snapshot.messages.push({
      agent: 'deepseek', source_id: 'dirty-1', session_ref: 'deepseek:',
      ts: Date.now(), role: 'user', kind: 'message', text: 'dirty message',
    });
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));

    // 重启一次：脏记录必须被加载侧丢弃。
    const verifyScript = [
      "const store = require('./lib/store');",
      'const out = {};',
      `out.dirtySession = Boolean(store.getSession('deepseek:'));`,
      `out.goodSession = Boolean(store.getSession('deepseek:session-good'));`,
      `out.statuses = Object.keys(store.getRuntimeStatuses()).filter((k) => k.endsWith(':'));`,
      'process.stdout.write(JSON.stringify(out));',
    ].join('');
    const verified = spawnSync(process.execPath, ['-e', verifyScript], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AB_DATA_DIR: dataDir },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(verified.status, 0, verified.stderr);
    const out = JSON.parse(verified.stdout);
    assert.equal(out.dirtySession, false, '快照里的无身份会话必须在加载时被丢弃');
    assert.equal(out.goodSession, true, '合法会话不得被误伤');
    assert.deepEqual(out.statuses, [], 'runtimeStatuses 里不得有畸形 ref');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
