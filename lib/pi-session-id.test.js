'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pi = require('./adapters/pi');
const PI_ADAPTER_SOURCE = fs.readFileSync(path.join(__dirname, 'adapters', 'pi.js'), 'utf8');

test('Pi 适配器使用 session header 的稳定 ID，而不是文件名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-pi-session-'));
  const file = path.join(dir, '2026-08-24T00-00-00.000Z_filename-id.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    type: 'session',
    id: '019f96fe-643b-76de-a797-24a9771496b2',
    cwd: 'C:\\Users\\Administrator',
  }) + '\n');

  assert.equal(pi.fileToSessionId(file), '019f96fe-643b-76de-a797-24a9771496b2');
  assert.equal(
    pi.resolveSessionId('2026-08-24T00-00-00.000Z_filename-id', [file]),
    '019f96fe-643b-76de-a797-24a9771496b2',
  );
  assert.deepEqual(
    pi.parseLines([
      { type: 'session', id: '019f96fe-643b-76de-a797-24a9771496b2', cwd: 'C:\\Users\\Administrator' },
      {
        type: 'message',
        id: 'message-1',
        timestamp: '2026-08-24T00:00:01.000Z',
        message: { role: 'user', content: '定位测试' },
      },
    ], file).find((entry) => entry.kind === 'message'),
    {
      agent: 'pi',
      sourceId: '019f96fe-643b-76de-a797-24a9771496b2:message-1',
      sessionId: '019f96fe-643b-76de-a797-24a9771496b2',
      ts: Date.parse('2026-08-24T00:00:01.000Z'),
      role: 'user',
      kind: 'message',
      text: '定位测试',
      project: 'C:\\Users\\Administrator',
      sessionRole: 'main',
      rootSessionId: '019f96fe-643b-76de-a797-24a9771496b2',
      topologySource: 'structural',
      topologyConfidence: 1,
      childDetection: 'verified',
      controlEligibility: 'eligible',
    },
  );
});

test('Pi 拓扑只把 subagents 路径识别为子代理，顶层 parentSession 仍是主会话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-pi-topology-'));
  const mainFile = path.join(dir, '2026-08-24T00-00-00.000Z_main.jsonl');
  const mainHeader = { type: 'session', id: 'main-1', parentSession: 'fork-parent', cwd: dir };
  fs.writeFileSync(mainFile, `${JSON.stringify(mainHeader)}\n`);

  const main = pi.piFileTopology(mainFile, mainHeader);
  assert.equal(main.sessionId, 'main-1');
  assert.equal(main.sessionRole, 'main');
  assert.equal(main.parentSessionId, undefined);
  assert.equal(main.rootSessionId, 'main-1');
  assert.equal(main.controlEligibility, 'eligible');

  const childWindowsPath = `${dir}\\parent-1\\subagents\\worker.jsonl`;
  const childUnixPath = path.join(dir, 'parent-1', 'subagents', 'worker.jsonl');
  const childHeader = { type: 'session', id: 'child-1', parentSession: 'parent-1', cwd: dir };
  for (const childPath of [childWindowsPath, childUnixPath]) {
    const child = pi.piFileTopology(childPath, childHeader);
    assert.equal(child.sessionId, 'child-1');
    assert.equal(child.sessionRole, 'child');
    assert.equal(child.parentSessionId, 'parent-1');
    assert.equal(child.rootSessionId, 'parent-1');
    assert.equal(child.childDetection, 'verified');
    assert.equal(child.controlEligibility, 'blocked');
  }
});

test('Pi 子代理 topology 传播到标题、消息和 turn_end 事件', () => {
  const childPath = 'C:\\Users\\demo\\.pi\\agent\\projects\\parent-1\\subagents\\worker.jsonl';
  const events = pi.parseLines([
    {
      type: 'session', id: 'child-1', parentSession: 'parent-1', cwd: 'C:\\Projects\\demo',
      title: 'child task',
    },
    {
      type: 'message', id: 'user-1', timestamp: '2026-08-24T00:00:01.000Z',
      message: { role: 'user', content: 'inspect files' },
    },
    {
      type: 'message', id: 'assistant-1', timestamp: '2026-08-24T00:00:02.000Z',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
    },
  ], childPath);

  assert.deepEqual(events.map((event) => event.kind), ['title', 'message', 'turn_end', 'message']);
  for (const event of events) {
    assert.equal(event.sessionId, 'child-1');
    assert.equal(event.sessionRole, 'child');
    assert.equal(event.parentSessionId, 'parent-1');
    assert.equal(event.rootSessionId, 'parent-1');
    assert.equal(event.childDetection, 'verified');
    assert.equal(event.controlEligibility, 'blocked');
  }
  assert.equal(events[0].title, 'child task');
  assert.equal(events[2].kind, 'turn_end');
});

test('Pi scanAll 和 poll 使用 topology-v2 offset，保证历史记录重投影', () => {
  assert.match(PI_ADAPTER_SOURCE, /offset:topology-v2:\$\{ID\}:\$\{f\}/);
});
