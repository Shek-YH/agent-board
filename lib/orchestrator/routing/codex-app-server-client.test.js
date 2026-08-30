'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCodexAppServerClient } = require('./codex-app-server-client');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = { write: (chunk) => this.receive(chunk) };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.requests = [];
    this.holdResponses = false;
  }

  receive(chunk) {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      const message = JSON.parse(line);
      this.requests.push(message);
      if (message.method === 'initialize') this.emitJson({ id: message.id, result: { userAgent: 'Codex Desktop/0.151.0' } });
      if (message.method === 'model/list' && !this.holdResponses) this.emitJson({ id: message.id, result: { data: [] } });
    }
  }

  emitJson(value) { this.stdout.emit('data', `${JSON.stringify(value)}\n`); }
  kill() { this.emit('exit', 0, null); }
}

test('performs the app-server handshake and request/response exchange', async () => {
  const child = new FakeChild();
  const spawned = [];
  const client = createCodexAppServerClient({
    executablePath: 'codex.exe', spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return child;
    },
  });

  const result = await client.request('model/list', { includeHidden: false });

  assert.deepEqual(result, { data: [] });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['app-server', '--stdio']);
  assert.deepEqual(child.requests.map((request) => request.method), ['initialize', 'initialized', 'model/list']);
  await client.close();
});

test('waits for a matching notification and rejects on process exit', async () => {
  const child = new FakeChild();
  const client = createCodexAppServerClient({ executablePath: 'codex.exe', spawnImpl: () => child });
  await client.request('model/list', {});
  const notification = client.waitForNotification({
    method: 'thread/settings/updated',
    predicate: (event) => event.params.threadId === 'thread-1',
    timeoutMs: 100,
  });
  child.emitJson({ method: 'thread/settings/updated', params: { threadId: 'thread-1' } });
  assert.deepEqual(await notification, { method: 'thread/settings/updated', params: { threadId: 'thread-1' } });
  child.holdResponses = true;
  const pending = client.sendRequest('model/list', {});
  child.emit('exit', 1, null);
  await assert.rejects(pending, /app server process is not running/);
  await client.close();
});

test('rejects a pending notification wait immediately when the process exits', async () => {
  const child = new FakeChild();
  const client = createCodexAppServerClient({ executablePath: 'codex.exe', spawnImpl: () => child });
  await client.request('model/list', {});
  const waiting = client.waitForNotification({ method: 'thread/settings/updated', timeoutMs: 5_000 });
  child.emit('exit', 1, null);
  await assert.rejects(waiting, /app server process is not running/);
  await client.close();
});
