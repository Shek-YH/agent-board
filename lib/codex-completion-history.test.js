'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCompletionHistory } = require('./codex-completion-history');

const started = (timestamp, turnId) => ({
  timestamp,
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: turnId },
});
const complete = (timestamp, turnId) => ({
  timestamp,
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: turnId },
});

test('completion history updates incrementally and rebuilds only after invalidation', () => {
  let stat = { identity: 'file-a', size: 100 };
  let rebuilds = 0;
  const history = createCompletionHistory({
    stat: () => stat,
    readAll: () => {
      rebuilds += 1;
      return { lines: [started('2026-09-12T00:00:00.000Z', 'a')] };
    },
  });

  assert.equal(history.holdMs('session.jsonl', Date.parse('2026-09-12T00:00:10.000Z'), [
    started('2026-09-12T00:00:00.000Z', 'a'),
  ]), 5000);
  assert.equal(rebuilds, 1);

  stat = { identity: 'file-a', size: 200 };
  const signal = Date.parse('2026-09-12T00:03:00.000Z');
  const hold = history.holdMs('session.jsonl', signal, [
    complete('2026-09-12T00:01:00.000Z', 'a'),
    started('2026-09-12T00:01:20.000Z', 'b'),
  ]);
  assert.equal(hold, 26000);
  assert.equal(rebuilds, 1);

  stat = { identity: 'file-b', size: 20 };
  assert.equal(history.holdMs('session.jsonl', signal, []), 5000);
  assert.equal(rebuilds, 2);
});

test('completion history deduplicates replayed lifecycle rows without retaining raw events', () => {
  const history = createCompletionHistory({
    stat: () => ({ identity: 'file-a', size: 100 }),
    readAll: () => ({ lines: [] }),
  });
  const rows = [
    started('2026-09-12T00:00:00.000Z', 'a'),
    complete('2026-09-12T00:01:00.000Z', 'a'),
    started('2026-09-12T00:01:10.000Z', 'b'),
  ];
  const expected = history.holdMs('session.jsonl', Date.parse('2026-09-12T00:02:00.000Z'), rows);
  const replayed = history.holdMs('session.jsonl', Date.parse('2026-09-12T00:02:00.000Z'), rows);
  assert.equal(replayed, expected);
  assert.deepEqual(history.snapshot('session.jsonl'), {
    fileIdentity: 'file-a',
    lastOffset: 100,
    startCount: 2,
    completeCount: 1,
    starts: [Date.parse('2026-09-12T00:00:00.000Z'), Date.parse('2026-09-12T00:01:10.000Z')],
    recentRapidGaps: [10000],
  });
});
