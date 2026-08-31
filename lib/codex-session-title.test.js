'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const codex = require('./adapters/codex');

test('Codex session_index 同一 session 取最后一条非空标题', () => {
  const titles = codex.parseSessionIndexLines([
    { id: '01a02e58-1c91-7413-8080-c8c0c64941a9', thread_name: '继续开发未完成代码' },
    { id: '01a02e58-1c91-7413-8080-c8c0c64941a9', thread_name: 'agent board' },
    { id: 'ignored', thread_name: '   ' },
  ]);

  assert.deepEqual([...titles.entries()], [
    ['01a02e58-1c91-7413-8080-c8c0c64941a9', 'agent board'],
  ]);
});

test('Codex session_index 标题更新到看板内部 rollout session', () => {
  const ingested = [];
  const store = {
    resolveAgentRef: (agent, sessionId) => agent === 'codex' && sessionId === '01a02e58-1c91-7413-8080-c8c0c64941a9'
      ? 'codex:2026-08-23T07-18-41-01a02e58-1c91-7413-8080-c8c0c64941a9'
      : '',
    getSession: () => ({ title: 'claude code开发到一半额度用完了，你接着继续开发' }),
    ingest: (message) => ingested.push(message),
  };

  const count = codex.applySessionIndexTitles(store, new Map([
    ['01a02e58-1c91-7413-8080-c8c0c64941a9', 'agent board'],
  ]));

  assert.equal(count, 1);
  assert.deepEqual(ingested[0], {
    agent: 'codex',
    sourceId: 'index-title:01a02e58-1c91-7413-8080-c8c0c64941a9',
    sessionId: '2026-08-23T07-18-41-01a02e58-1c91-7413-8080-c8c0c64941a9',
    ts: 0,
    role: 'system',
    kind: 'title',
    text: '',
    title: 'agent board',
  });
});

test('Codex session_index 优先使用精确 session ref，不把标题回退到最近会话', () => {
  const ingested = [];
  const store = {
      getSession: (ref) => ref === 'codex:exact-session' ? { id: ref, title: '' } : null,
    resolveAgentRef: () => 'codex:wrong-recent-session',
    ingest: (message) => ingested.push(message),
  };

  codex.applySessionIndexTitles(store, new Map([
    ['exact-session', 'Exact title'],
  ]));

  assert.equal(ingested[0].sessionId, 'exact-session');
});
