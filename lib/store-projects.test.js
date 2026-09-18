'use strict';

// 回归测试：项目聚合与筛选必须按「归一化路径」比较，不能按原始字符串。
//
// 事故现象（2026-09-17）：看板「按项目筛选看板与todo」下拉框把同一个项目文件夹显示成两条，
// 例如 c:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10 (31) 与
//      C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10 (181)。
// 同一项目下的会话因此被拆成两组展示。实测全库 340 条项目条目里有 19 条是这种重复，涉及 534 个会话。
//
// 成因链（Windows 路径大小写不敏感，但代码按字符串比较）：
//   1) lib/store.js ingest()：`s.project !== msg.project` 即改写 → 同一会话的 project
//      在两种写法间反复横跳，还每次都标 changed 触发无谓落盘。
//   2) stmts.projects.all()：直接用原始字符串做 Map 键 → 同一目录分裂成两条下拉项。
//   3) getSessions() / getTimeline()：`s.project === project` 严格相等 →
//      即使下拉框只显示一条，选中后也只能筛出其中一半会话。
//
// 说明：本文件原先只有一条对 store.js 源码的正则断言
// （assert.match(source, /lastSeen: Math\.max\(current\.lastSeen, ...\)/)）。
// 那种写法一改实现就失效、且无法覆盖真实行为，已替换为下面的端到端行为断言，
// 同时保留了它原本想守的「lastSeen 取最新会话时间」语义。

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BASE = Date.parse('2026-09-01T00:00:00Z');

const P_UPPER = 'C:\\Proj';
const P_LOWER = 'c:\\Proj';
const P_FLAT = 'c:\\proj';
const P_TIE_A = 'D:\\Tie';
const P_TIE_B = 'd:\\Tie';
const P_TRAIL_A = 'E:\\Trail\\';
const P_TRAIL_B = 'e:\\trail';

/** 构造一条最小可用的真实消息（role=user + kind=message 才算真实消息）。 */
function msg(agent, sessionId, sourceId, project, ts) {
  return JSON.stringify({
    agent, sessionId, sourceId, ts, project, title: 'T',
    role: 'user', kind: 'message', text: 'hello',
  });
}

/** 在独立 AB_DATA_DIR 的子进程里驱动 store 公开 API，返回其 JSON 输出。 */
function runWithStore(lines) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-projects-'));
  try {
    const script = [
      "const store = require('./lib/store');",
      'const out = {};',
      ...lines,
      'process.stdout.write(JSON.stringify(out));',
    ].join('');
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AB_DATA_DIR: dataDir },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const out = runWithStore([
  // 同一目录的三种大小写写法，分别落在三个会话上。
  `store.ingest(${msg('claude', 's1', 'a1', P_UPPER, BASE)});`,
  `store.ingest(${msg('claude', 's2', 'a2', P_LOWER, BASE + 1000)});`,
  `store.ingest(${msg('codex', 's3', 'a3', P_FLAT, BASE + 2000)});`,
  // 平局：两种写法各一个会话，应稳定取大写盘符那种。
  `store.ingest(${msg('claude', 't1', 'b1', P_TIE_A, BASE)});`,
  `store.ingest(${msg('claude', 't2', 'b2', P_TIE_B, BASE)});`,
  // 末尾分隔符差异也应归一（Windows 下 E:\Trail\ 与 e:\trail 是同一目录）。
  `store.ingest(${msg('claude', 'r1', 'c1', P_TRAIL_A, BASE + 5000)});`,
  `store.ingest(${msg('claude', 'r2', 'c2', P_TRAIL_B, BASE)});`,

  // 快照：必须在下面的 a9 churn 用例之前取，否则 lastSeen 会被顶高。
  'out.projects = store.stmts.projects.all().map((p) => ({ project: p.project, cnt: p.cnt, lastSeen: p.lastSeen }));',
  `out.filterUpper = store.getSessions({ project: ${JSON.stringify(P_UPPER)} }).map((s) => s.id).sort();`,
  `out.filterFlat = store.getSessions({ project: ${JSON.stringify(P_FLAT)} }).map((s) => s.id).sort();`,
  `out.filterShout = store.getSessions({ project: 'C:\\\\PROJ' }).map((s) => s.id).sort();`,
  `out.filterTrail = store.getSessions({ project: ${JSON.stringify(P_TRAIL_B)} }).map((s) => s.id).sort();`,

  // ingest 侧：同目录的另一写法不得改写已存的 project（否则会话 project 反复横跳）。
  `store.ingest(${msg('claude', 's1', 'a9', P_LOWER, BASE + 3000)});`,
  `out.s1ProjectAfterChurn = store.getSession('claude:s1').project;`,

  // 时间线断言放在 churn ingest 之后：既验证大小写不敏感，也验证新写入的小写消息
  // 能被大写查询命中。c:\proj 组共 4 条消息：s1(a1,a9) + s2(a2) + s3(a3)。
  `out.timelineUpper = store.getTimeline({ project: ${JSON.stringify(P_UPPER)} }).length;`,
  `out.timelineFlat = store.getTimeline({ project: ${JSON.stringify(P_FLAT)} }).length;`,
  `out.timelineRefs = store.getTimeline({ project: ${JSON.stringify(P_UPPER)} }).map((m) => m.sessionRef).sort();`,
]);

const findProject = (needle) => out.projects.find((p) => p.project === needle);

test('同一文件夹的不同大小写/末尾分隔符写法合并为一条项目条目', () => {
  // 7 个会话分属 3 个真实目录，必须聚合为 3 条，而不是 7 条。
  assert.equal(out.projects.length, 3, JSON.stringify(out.projects, null, 2));
  assert.equal(out.projects.reduce((n, p) => n + p.cnt, 0), 7);
});

test('合并后 cnt 是各变体会话数之和，lastSeen 取最新（保留原断言语义）', () => {
  const merged = findProject(P_UPPER);
  assert.ok(merged, '合并后的显示名应为多数/字典序优先的写法 C:\\Proj');
  assert.equal(merged.cnt, 3);
  assert.equal(merged.lastSeen, BASE + 2000);

  // 平局时稳定取大写盘符写法（字典序更小）。
  assert.ok(findProject(P_TIE_A), '平局应取 D:\\Tie');
  assert.equal(findProject(P_TIE_A).cnt, 2);

  // 末尾分隔符差异同样归一，且 lastSeen 取两者最大值。
  const trail = findProject(P_TRAIL_A);
  assert.ok(trail, 'E:\\Trail\\ 与 e:\\trail 应合并为一条');
  assert.equal(trail.cnt, 2);
  assert.equal(trail.lastSeen, BASE + 5000);
});

test('按项目筛选会话时，任意大小写写法都能筛出该目录下全部会话', () => {
  const expected = ['claude:s1', 'claude:s2', 'codex:s3'];
  assert.deepEqual(out.filterUpper, expected);
  assert.deepEqual(out.filterFlat, expected);
  assert.deepEqual(out.filterShout, expected, '全大写查询也应命中');
  assert.deepEqual(out.filterTrail, ['claude:r1', 'claude:r2']);
});

test('时间线按项目筛选同样大小写不敏感', () => {
  // c:\proj 组共 4 条消息：s1 两条（a1 + churn 用例写入的小写 a9）、s2 一条、s3 一条。
  assert.equal(out.timelineUpper, 4);
  assert.equal(out.timelineFlat, 4);
  assert.deepEqual(out.timelineRefs, ['claude:s1', 'claude:s1', 'claude:s2', 'codex:s3']);
});

test('ingest 不因大小写差异改写已存的 project（避免反复横跳与无谓落盘）', () => {
  assert.equal(out.s1ProjectAfterChurn, P_UPPER);
});
