'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SUBAGENT_CARD_STYLE_KEY,
  normalizeSubagentCardStyle,
  loadSubagentCardStyle,
  saveSubagentCardStyle,
  groupSessions,
} = require('./session-card-stacking');

function session(id, role = 'main', parent = null) {
  return {
    id,
    session_id: id,
    session_role: role,
    ...(parent === null ? {} : { parent_session_ref: parent }),
  };
}

test('直接和多层子代理归并到根主会话，并保持子卡相对顺序与主卡位置', () => {
  const main = session('main');
  const direct = session('direct', 'child', 'main');
  const unrelated = session('other');
  const grandchild = session('grandchild', 'child', 'direct');
  const directLater = session('direct-later', 'child', 'main');

  const result = groupSessions([direct, main, unrelated, grandchild, directLater]);

  assert.deepEqual(result, [
    {
      type: 'group',
      root: main,
      children: [direct, grandchild, directLater],
    },
    { type: 'session', session: unrelated },
  ]);
});

test('父会话缺失、关系成环或指向未知角色时，所有卡均按原顺序独立保留', () => {
  const missingParentChild = session('missing-child', 'child', 'not-in-list');
  const cycleA = session('cycle-a', 'child', 'cycle-b');
  const cycleB = session('cycle-b', 'child', 'cycle-a');
  const unknown = session('unknown', 'unknown');
  const unknownChild = session('unknown-child', 'child', 'unknown');
  const result = groupSessions([missingParentChild, cycleA, cycleB, unknownChild, unknown]);

  assert.deepEqual(result, [
    { type: 'session', session: missingParentChild },
    { type: 'session', session: cycleA },
    { type: 'session', session: cycleB },
    { type: 'session', session: unknownChild },
    { type: 'session', session: unknown },
  ]);
});

test('显示偏好默认归一为 flat，合法值为 stacked，非法值和读取异常安全回退', () => {
  assert.equal(SUBAGENT_CARD_STYLE_KEY, 'ab-subagent-card-style');
  assert.equal(normalizeSubagentCardStyle('stacked'), 'stacked');
  assert.equal(normalizeSubagentCardStyle('flat'), 'flat');
  assert.equal(normalizeSubagentCardStyle(), 'flat');
  assert.equal(normalizeSubagentCardStyle('invalid'), 'flat');
  assert.equal(normalizeSubagentCardStyle({}), 'flat');

  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
  assert.equal(loadSubagentCardStyle(storage), 'flat');
  values.set(SUBAGENT_CARD_STYLE_KEY, 'stacked');
  assert.equal(loadSubagentCardStyle(storage), 'stacked');
  values.set(SUBAGENT_CARD_STYLE_KEY, 'invalid');
  assert.equal(loadSubagentCardStyle(storage), 'flat');

  const throwingStorage = {
    getItem() {
      throw new Error('read failed');
    },
  };
  assert.doesNotThrow(() => loadSubagentCardStyle(throwingStorage));
  assert.equal(loadSubagentCardStyle(throwingStorage), 'flat');
});

test('保存偏好先规范化，写入异常不外泄', () => {
  const writes = [];
  const storage = {
    setItem(key, value) {
      writes.push([key, value]);
    },
  };

  assert.equal(saveSubagentCardStyle(storage, 'stacked'), 'stacked');
  assert.equal(saveSubagentCardStyle(storage, 'invalid'), 'flat');
  assert.deepEqual(writes, [
    [SUBAGENT_CARD_STYLE_KEY, 'stacked'],
    [SUBAGENT_CARD_STYLE_KEY, 'flat'],
  ]);

  const throwingStorage = {
    setItem() {
      throw new Error('write failed');
    },
  };
  assert.doesNotThrow(() => saveSubagentCardStyle(throwingStorage, 'stacked'));
  assert.equal(saveSubagentCardStyle(throwingStorage, 'stacked'), 'stacked');
});
