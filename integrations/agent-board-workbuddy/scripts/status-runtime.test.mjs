import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendProjectedEvent,
  postProjectedEvent,
  projectEvent,
  readHttpHookConfig,
  resolveHttpHookConfigPath,
  resolveSpoolPath,
} from './status-runtime.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-hook-'));
}

test('projectEvent 只保留结构化白名单，不落盘 Prompt、回复或工具内容', () => {
  const projected = projectEvent('Stop', {
    session_id: 'session-1',
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    subagent_id: 'child-1',
    task_id: 'task-1',
    last_assistant_message: '已完成，需要继续吗？',
    prompt: 'secret prompt',
    assistant_message: 'secret answer',
    tool_input: { command: 'secret' },
    tool_output: 'secret output',
    file_path: 'C:\\secret.txt',
    transcript_path: 'C:\\Users\\alice\\.codebuddy\\session.jsonl',
    cwd: 'C:\\work\\repo',
    stop_hook_active: true,
  }, 1234);

  assert.equal(projected.event, 'Stop');
  assert.equal(projected.ts, 1234);
  assert.equal(projected.session_id, 'session-1');
  assert.equal(projected.tool_use_id, 'tool-1');
  assert.equal(projected.subagent_id, 'child-1');
  assert.equal(projected.task_id, 'task-1');
  assert.equal(projected.ends_with_question, true);
  assert.equal(projected.transcript_path, 'C:\\Users\\alice\\.codebuddy\\session.jsonl');
  assert.equal(projected.cwd, 'C:\\work\\repo');
  assert.equal(projected.stop_hook_active, true);
  assert.equal('prompt' in projected, false);
  assert.equal('assistant_message' in projected, false);
  assert.equal('last_assistant_message' in projected, false);
  assert.equal('tool_input' in projected, false);
  assert.equal('tool_output' in projected, false);
  assert.equal('file_path' in projected, false);
});

test('projectEvent 支持 Headless 后台任务事件及其终态字段', () => {
  const projected = projectEvent('task_notification', {
    session_id: 'session-1',
    task_id: 'bg-1',
    tool_use_id: 'tool-1',
    task_type: 'Bash',
    status: 'failed',
    summary: '不要落盘的摘要',
    output_file: 'C:\\secret.log',
  }, 1234);

  assert.equal(projected.event, 'task_notification');
  assert.equal(projected.task_id, 'bg-1');
  assert.equal(projected.tool_use_id, 'tool-1');
  assert.equal(projected.task_type, 'Bash');
  assert.equal(projected.status, 'failed');
  assert.equal('summary' in projected, false);
  assert.equal('output_file' in projected, false);
});

test('appendProjectedEvent 可轮转 JSONL，并拒绝非法或超长事件而保持 fail-open', () => {
  const dir = tempDir();
  const spool = path.join(dir, 'nested', 'events.spool');
  const event = projectEvent('Stop', { session_id: 'session-1' }, 100);

  try {
    assert.equal(appendProjectedEvent(spool, event, { maxBytes: 180 }), true);
    assert.equal(appendProjectedEvent(spool, { ...event, ts: 200 }, { maxBytes: 180 }), true);
    assert.equal(fs.existsSync(`${spool}.1`), true);
    assert.equal(fs.readFileSync(spool, 'utf8').trim().length > 0, true);
    assert.equal(appendProjectedEvent('relative/events.spool', event), false);
    assert.equal(appendProjectedEvent(spool, { event: 'x', value: 'x'.repeat(20000) }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSpoolPath 优先使用绝对覆盖路径，并安全回退到用户目录', () => {
  assert.equal(
    resolveSpoolPath({ env: { AGENT_BOARD_WORKBUDDY_SPOOL_PATH: 'D:\\AgentBoard\\events.spool' }, homedir: () => 'C:\\Users\\alice' }),
    'D:\\AgentBoard\\events.spool',
  );
  assert.equal(
    resolveSpoolPath({ env: {}, homedir: () => 'C:\\Users\\alice' }),
    path.join('C:\\Users\\alice', '.workbuddy-buddy', 'events.spool'),
  );
});

test('HTTP Hook 配置可从环境读取，发送失败时允许回退 spool', async () => {
  const config = readHttpHookConfig({ env: {
    AGENT_BOARD_WORKBUDDY_HTTP_URL: 'http://127.0.0.1:4876/internal/hooks/workbuddy',
    AGENT_BOARD_WORKBUDDY_HTTP_TOKEN: 'a'.repeat(64),
  } });
  assert.deepEqual(config, {
    url: 'http://127.0.0.1:4876/internal/hooks/workbuddy',
    token: 'a'.repeat(64),
    source: 'environment',
  });
  const event = projectEvent('Stop', { session_id: 'session-1' }, 1234);
  const requests = [];
  assert.equal(await postProjectedEvent(event, {
    config,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true };
    },
  }), true);
  assert.equal(requests[0].url, config.url);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${config.token}`);
  assert.deepEqual(JSON.parse(requests[0].options.body), event);
  assert.equal(await postProjectedEvent(event, {
    config,
    fetchImpl: async () => ({ ok: false }),
  }), false);
});

test('HTTP Hook 配置可从 Agent Board data dir 的私有文件读取', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'workbuddy', 'http-hook.json');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      url: 'http://127.0.0.1:4876/internal/hooks/workbuddy', token: 'd'.repeat(64),
    }));
    assert.equal(resolveHttpHookConfigPath({ env: { AGENT_BOARD_WORKBUDDY_DATA_DIR: dir } }), filePath);
    assert.deepEqual(readHttpHookConfig({ env: { AGENT_BOARD_WORKBUDDY_DATA_DIR: dir } }), {
      url: 'http://127.0.0.1:4876/internal/hooks/workbuddy',
      token: 'd'.repeat(64),
      source: 'file',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
