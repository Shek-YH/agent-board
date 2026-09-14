'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('session 卡片展示 Codex 多状态标签并接收 runtimeStatuses', () => {
  assert.match(source, /runtimeStatuses/);
  assert.match(source, /waiting_approval/);
  assert.match(source, /waiting_user_input/);
  assert.match(source, /interrupted/);
  assert.match(source, /failed/);
  assert.match(source, /stale_active/);
  assert.match(source, /状态待确认/);
});

test('session card prefers authoritative lifecycle_state over legacy runtime state', () => {
  assert.match(source, /lifecycle_state/);
  assert.match(source, /runtimeStatusValue/);
  assert.match(source, /runtimeStatusValue\(runtime\)/);
});

test('session card supports V2 fine-grained UI status keys', () => {
  assert.match(source, /running_command/);
  assert.match(source, /running_subagent/);
  assert.match(source, /completion_candidate/);
  assert.match(source, /等待外部/);
});

test('settings exposes the read-only State Engine diagnostics flow', () => {
  assert.match(source, /状态监控诊断/);
  assert.match(source, /state-engine\/diagnostics/);
  assert.match(source, /Evidence Timeline/);
  assert.match(source, /导出诊断包/);
});

test('diagnostics UI keeps mark-seen, mark-turn-done, and close-session actions separate', () => {
  assert.match(source, /mark-seen/);
  assert.match(source, /mark-turn-done/);
  assert.match(source, /close-session/);
  assert.match(source, /标记本轮完成/);
  assert.match(source, /关闭跟踪/);
});

test('health polling tolerates scan backlog and avoids overlapping requests', () => {
  assert.match(source, /let healthRequest = null/);
  assert.match(source, /requestJson\('\/api\/health', \{ timeoutMs: 15000 \}\)/);
  assert.match(source, /后端忙 · 后台扫描中/);
  assert.match(source, /const initialHealth = loadHealth\(\);/);
  assert.match(source, /await initialHealth;/);
});
