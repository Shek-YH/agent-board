'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('Pi 适配器使用 session header 的稳定 ID，而不是文件名', () => {
  const pi = require('./adapters/pi');
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
    },
  );
});
