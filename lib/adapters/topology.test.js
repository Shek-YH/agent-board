'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const claude = require('./claude');
const zcode = require('./zcode');

test('Claude child transcript gets an independent child session ref', () => {
  const lines = claude.parseLines([
    {
      type: 'assistant',
      sessionId: 'main-1',
      agentId: 'agent-a1',
      uuid: 'msg-child-1',
      timestamp: '2026-08-27T12:00:00.000Z',
      isSidechain: true,
      cwd: 'C:\\Projects\\demo',
      message: { content: [{ type: 'text', text: 'child work' }], stop_reason: 'end_turn' },
    },
  ], 'C:\\Users\\demo\\.claude\\projects\\demo\\main-1\\subagents\\agent-a1.jsonl');

  assert.equal(lines.length, 1);
  assert.equal(lines[0].sessionId, 'main-1:subagent:a1');
  assert.equal(lines[0].sessionRole, 'child');
  assert.equal(lines[0].parentSessionId, 'main-1');
  assert.equal(lines[0].controlEligibility, 'blocked');
});

test('Claude child topology trusts the parent directory over an inline child sessionId', () => {
  const childPath = 'C:\\Users\\demo\\.claude\\projects\\demo\\parent-from-path\\subagents\\agent-agent-from-path.jsonl';
  const lines = claude.parseLines([
    {
      type: 'assistant', sessionId: 'independent-child-uuid', agentId: 'agent-from-line',
      uuid: 'msg-child-path-priority', timestamp: '2026-08-27T12:00:00.000Z', isSidechain: true,
      message: { content: 'child work', stop_reason: 'end_turn' },
    },
  ], childPath);

  assert.equal(lines[0].sessionId, 'parent-from-path:subagent:agent-from-path');
  assert.equal(lines[0].parentSessionId, 'parent-from-path');
  assert.equal(claude.fileToSessionId(childPath), lines[0].sessionId);
});

test('Claude sidechain flag alone does not turn the main transcript into a child', () => {
  const lines = claude.parseLines([
    {
      type: 'assistant', sessionId: 'main-1', uuid: 'msg-main-1',
      timestamp: '2026-08-27T12:00:00.000Z', isSidechain: true,
      message: { content: 'main transcript', stop_reason: 'end_turn' },
    },
  ], 'C:\\Users\\demo\\.claude\\projects\\demo\\main-1.jsonl');

  assert.equal(lines[0].sessionId, 'main-1');
  assert.equal(lines[0].sessionRole, 'main');
  assert.equal(lines.some((line) => line.kind === 'turn_end'), false);
});

test('ZCode keeps interactive and child sessions and labels unknown task types', () => {
  assert.equal(zcode.topologyForSession({ task_type: 'interactive' }).sessionRole, 'main');
  assert.equal(zcode.topologyForSession({ task_type: 'interactive' }).controlEligibility, 'eligible');
  assert.equal(zcode.topologyForSession({ task_type: 'subagent_child' }).sessionRole, 'child');
  assert.equal(zcode.topologyForSession({ task_type: 'subagent_child' }).controlEligibility, 'blocked');
  assert.equal(zcode.topologyForSession({ task_type: 'background' }).sessionRole, 'unknown');
});
