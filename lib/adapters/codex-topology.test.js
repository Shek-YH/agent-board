'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const codex = require('./codex');

const parentId = '01a03e82-9dd7-7ba1-ac4d-f70e9583df0a';
const childId = '01a0414e-2b0f-7e30-8b35-f03437f6d705';

test('Codex session_meta uses payload.id and recognizes a spawned child', () => {
  const lines = codex.parseLines([{
    type: 'session_meta',
    timestamp: '2026-08-26T23:40:37.000Z',
    payload: {
      id: childId,
      session_id: parentId,
      cwd: 'F:\\CCPJ\\A2T',
      thread_source: 'subagent',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentId,
            depth: 1,
            agent_nickname: 'Volta',
          },
        },
      },
    },
  }], 'C:\\Users\\demo\\.codex\\sessions\\2026\\08\\26\\rollout-2026-08-26T23-40-37-' + childId + '.jsonl');

  assert.equal(lines.length, 1);
  assert.equal(lines[0].sessionId, childId);
  assert.equal(lines[0].sessionRole, 'child');
  assert.equal(lines[0].parentSessionId, parentId);
  assert.equal(lines[0].rootSessionId, parentId);
  assert.equal(lines[0].topologySource, 'explicit');
  assert.equal(lines[0].childDetection, 'verified');
  assert.equal(lines[0].controlEligibility, 'blocked');
  assert.equal(lines[0].topologyDepth, 1);
  assert.equal(lines[0].agentNickname, 'Volta');
});

test('Codex session_meta without subagent marker remains a controllable main thread', () => {
  const mainId = '01a04148-92b6-7ec2-8c8c-8ed9d08a4a90';
  const lines = codex.parseLines([{
    type: 'session_meta',
    timestamp: '2026-08-26T23:34:30.000Z',
    payload: { id: mainId, cwd: 'F:\\CCPJ\\A2T' },
  }], 'rollout-2026-08-26T23-34-30-' + mainId + '.jsonl');

  assert.equal(lines[0].sessionId, mainId);
  assert.equal(lines[0].sessionRole, 'main');
  assert.equal(lines[0].parentSessionId, undefined);
  assert.equal(lines[0].controlEligibility, 'eligible');
  assert.equal(lines[0].childDetection, 'verified');
});
