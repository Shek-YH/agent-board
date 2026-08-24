'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const deepseek = require('./adapters/deepseek');
const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const deepseekSource = fs.readFileSync(path.join(__dirname, 'adapters/deepseek.js'), 'utf8');

test('DeepSeek turn/end completed 事件被转换为明确的回合完成信号', () => {
  const messages = deepseek.parseLines([
    { type: 'session', id: 'session-status-1', cwd: 'C:\\repo' },
    {
      type: 'turn/end',
      seq: 41,
      time: 1700000000000,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ]);

  assert.deepEqual(messages, [{
    agent: 'deepseek',
    sourceId: 'turnend:41',
    sessionId: 'session-status-1',
    ts: 1700000000000,
    kind: 'turn_end',
    turnStatus: 'completed',
    project: 'C:\\repo',
  }]);
});

test('DeepSeek turn/end aborted 事件同样结束当前回合', () => {
  const messages = deepseek.parseLines([
    { type: 'session', id: 'session-status-2' },
    {
      type: 'turn/end',
      seq: 42,
      time: 1700000001000,
      data: { turn: 2, reason: { kind: 'aborted' } },
    },
  ]);

  assert.equal(messages[0].kind, 'turn_end');
  assert.equal(messages[0].turnStatus, 'aborted');
});

test('DeepSeek assistant 消息后文件静止超过阈值才判定为完成', () => {
  assert.equal(
    deepseek.isDeepSeekIdleComplete('assistant', deepseek.DEEPSEEK_IDLE_MS + 1),
    true,
  );
  assert.equal(
    deepseek.isDeepSeekIdleComplete('assistant', deepseek.DEEPSEEK_FRESH_MS),
    false,
  );
});

test('DeepSeek 最后一条是 user 时不能因为文件静止而提前完成', () => {
  assert.equal(
    deepseek.isDeepSeekIdleComplete('user', deepseek.DEEPSEEK_IDLE_MS + 1),
    false,
  );
});

test('DeepSeek 停顿检测接入服务轮询，且文件变化不再伪造当前活跃时间', () => {
  assert.match(serverSource, /deepseek\.checkDesktopIdle\(store\)/);
  assert.match(deepseekSource, /mtime:v2:\$\{ID\}:\$\{f\}/);
  assert.doesNotMatch(
    deepseekSource,
    /store\.touchActive\([^\n]+Date\.now\(\)/,
  );
});
