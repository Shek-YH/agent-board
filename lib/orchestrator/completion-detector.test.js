'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCompletionDetector } = require('./completion-detector');

test('completion detector accepts an explicit completed runtime after dispatch', async () => {
  const detector = createCompletionDetector({
    getSession: () => ({ runtime_status: { state: 'completed', completedAt: 2_000 } }),
    now: () => 2_100,
  });

  assert.deepEqual(await detector.detect({
    workflow: { binding: { sessionRef: 'session-1' } },
    dispatchRecord: { startedAt: 1_000 },
  }), {
    status: 'completed', completed: true, reasonCode: 'TURN_COMPLETED', completedAt: 2_000, evidence: [],
  });
});

test('completion detector fails closed for stale, active, and unavailable runtime state', async () => {
  const stale = createCompletionDetector({ getSession: () => ({ runtime_status: { state: 'completed', completedAt: 900 } }) });
  const active = createCompletionDetector({ getSession: () => ({ runtime_status: { state: 'running' } }) });
  const unavailable = createCompletionDetector({ getSession: () => ({}) });

  assert.equal((await stale.detect({ workflow: { binding: { sessionRef: 's' } }, dispatchRecord: { startedAt: 1_000 } })).completed, false);
  assert.equal((await active.detect({ workflow: { binding: { sessionRef: 's' } } })).reasonCode, 'TURN_IN_PROGRESS');
  assert.equal((await unavailable.detect({ workflow: { binding: { sessionRef: 's' } } })).reasonCode, 'SESSION_STATUS_UNAVAILABLE');
});

test('completion detector maps permission and failed runtime states to human-safe outcomes', async () => {
  const permission = createCompletionDetector({
    getSession: () => ({ runtime_status: { state: 'waiting_approval' } }),
  });
  const failed = createCompletionDetector({
    getSession: () => ({ runtime_status: { state: 'failed', lastEventAt: 2_000 } }),
  });

  assert.deepEqual(await permission.detect({ workflow: { binding: { sessionRef: 's' } } }), {
    status: 'waiting_user', completed: false, reasonCode: 'PERMISSION_REQUIRED',
  });
  assert.deepEqual(await failed.detect({ workflow: { binding: { sessionRef: 's' } } }), {
    status: 'blocked', completed: false, reasonCode: 'AGENT_FAILED',
  });
});

test('completion detector pauses when a human user message arrives after the autopilot delivery', async () => {
  const detector = createCompletionDetector({
    getSession: () => ({
      runtime_status: { state: 'completed', completedAt: 2_000 },
      messages: [
        { role: 'user', ts: 1_500, text: 'autopilot instruction', source_id: 'auto-message' },
        { role: 'assistant', ts: 1_900, text: 'working' },
        { role: 'user', ts: 2_100, text: '我临时改一下目标', source_id: 'human-message' },
      ],
    }),
    now: () => 2_200,
  });

  const result = await detector.detect({
    workflow: { binding: { sessionRef: 's' } },
    dispatchRecord: {
      startedAt: 1_000,
      completedAt: 1_600,
      deliveryProof: { sourceId: 'auto-message', timestamp: 1_500 },
    },
  });

  assert.deepEqual(result, {
    status: 'waiting_user',
    completed: false,
    reasonCode: 'HUMAN_INTERVENTION',
    observedAt: 2_200,
  });
});
