'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { findAvailablePort } = require('./port');

test('findAvailablePort 返回指定的可用端口', async () => {
  const port = await findAvailablePort({ preferredPort: 49123 });
  assert.equal(port, 49123);
});

test('findAvailablePort 在首选端口占用时回退到随机端口', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => blocker.once('error', reject).listen(0, '127.0.0.1', resolve));
  const preferredPort = blocker.address().port;
  t.after(() => blocker.close());

  const port = await findAvailablePort({ preferredPort });
  assert.notEqual(port, preferredPort);
  assert.ok(port > 0);
});
