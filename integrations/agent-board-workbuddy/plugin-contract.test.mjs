import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ALLOWED_EVENTS } from './scripts/status-runtime.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test('CodeBuddy 插件注册全部生命周期事件，并使用插件根目录变量调用 hook', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.codebuddy-plugin', 'plugin.json'), 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(manifest.hooks, './hooks/hooks.json');
  for (const event of ALLOWED_EVENTS) {
    const registrations = hooks.hooks[event];
    assert.ok(Array.isArray(registrations) && registrations.length > 0, `${event} 未注册`);
    const command = registrations[0].hooks?.[0]?.command || '';
    assert.match(command, /status-hook\.mjs/);
    assert.match(command, /\$\{CODEBUDDY_PLUGIN_ROOT\}/);
  }
});

test('status-hook CLI 只把隐私安全的结构字段写入 spool，并对异常输入 fail-open', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-plugin-'));
  const spool = path.join(directory, 'events.spool');
  const script = path.join(ROOT, 'scripts', 'status-hook.mjs');
  const env = {
    ...process.env,
    AGENT_BOARD_WORKBUDDY_SPOOL_PATH: spool,
    AGENT_BOARD_WORKBUDDY_HTTP_CONFIG_PATH: path.join(directory, 'missing-http-hook.json'),
  };
  try {
    const result = spawnSync(process.execPath, [script, 'Stop'], {
      input: JSON.stringify({
        session_id: 'session-cli',
        last_assistant_message: '需要继续吗？',
        prompt: 'secret prompt',
        tool_input: { command: 'secret command' },
      }),
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0);
    const event = JSON.parse(fs.readFileSync(spool, 'utf8'));
    assert.equal(event.event, 'Stop');
    assert.equal(event.session_id, 'session-cli');
    assert.equal(event.ends_with_question, true);
    assert.equal('prompt' in event, false);
    assert.equal('tool_input' in event, false);

    const malformed = spawnSync(process.execPath, [script, 'Stop'], {
      input: '{not-json', encoding: 'utf8', env,
    });
    assert.equal(malformed.status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
