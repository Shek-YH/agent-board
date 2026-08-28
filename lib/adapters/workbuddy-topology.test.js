'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const workbuddy = require('./workbuddy');

const childPath = 'C:\\Users\\demo\\.workbuddy\\projects\\demo\\parent-from-path\\subagents\\agent-agent-from-path.jsonl';

test('WorkBuddy child topology uses the real child UUID and parent directory', () => {
  const lines = [
    { type: 'file-history-snapshot' },
    { type: 'ai-title', sessionId: 'child-real-uuid', aiTitle: 'Child title', timestamp: 1000 },
    { type: 'message', sessionId: 'child-real-uuid', role: 'assistant', timestamp: 2000, content: 'child output' },
  ];

  const topology = workbuddy.workbuddyFileTopology(childPath, lines);
  assert.equal(topology.sessionId, 'child-real-uuid');
  assert.equal(topology.sessionRole, 'child');
  assert.equal(topology.parentSessionId, 'parent-from-path');
  assert.equal(topology.rootSessionId, 'parent-from-path');
  assert.equal(topology.childDetection, 'verified');
  assert.equal(topology.controlEligibility, 'blocked');

  const events = workbuddy.parseLines(lines, childPath);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.sessionId), ['child-real-uuid', 'child-real-uuid']);
  assert.ok(events.every((event) => event.sessionRole === 'child'));
  assert.ok(events.every((event) => event.parentSessionId === 'parent-from-path'));
});

test('WorkBuddy child topology falls back to a composite ID without an inline session ID', () => {
  const topology = workbuddy.workbuddyFileTopology(childPath, [{ type: 'tool-result' }]);

  assert.equal(topology.sessionId, 'parent-from-path:subagent:agent-from-path');
  assert.equal(topology.parentSessionId, 'parent-from-path');
  assert.equal(topology.topologySource, 'structural');
  assert.equal(topology.childDetection, 'verified');
  assert.equal(topology.controlEligibility, 'blocked');
});

test('WorkBuddy fileToSessionId reads the first valid child session ID and keeps main IDs unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-topology-'));
  const childFile = path.join(root, 'parent-session', 'subagents', 'agent-file-id.jsonl');
  const mainFile = path.join(root, 'main-session.jsonl');
  fs.mkdirSync(path.dirname(childFile), { recursive: true });
  fs.writeFileSync(childFile, [
    '{not-json}',
    JSON.stringify({ type: 'message', sessionId: 'child-file-uuid' }),
  ].join('\n'));
  fs.writeFileSync(mainFile, '');

  try {
    assert.equal(workbuddy.fileToSessionId(childFile), 'child-file-uuid');
    assert.equal(workbuddy.fileToSessionId(mainFile), 'main-session');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WorkBuddy 解析后即使子代理文件删除，fileToSessionId 仍返回缓存的真实 UUID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-session-cache-'));
  const childFile = path.join(root, 'parent-session', 'subagents', 'agent-cache-id.jsonl');
  const sessionId = 'child-cache-uuid';
  fs.mkdirSync(path.dirname(childFile), { recursive: true });
  fs.writeFileSync(childFile, `${JSON.stringify({ type: 'message', sessionId, role: 'assistant', content: 'child' })}\n`);

  try {
    workbuddy.parseLines([{ type: 'message', sessionId, role: 'assistant', timestamp: 1, content: 'child' }], childFile);
    fs.rmSync(childFile);
    assert.equal(workbuddy.fileToSessionId(childFile), sessionId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
