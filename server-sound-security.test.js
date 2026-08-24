const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('声音分配只接受 AGENT_DEFS 的自有 Agent', () => {
  assert.match(source, /Object\.hasOwn\(AGENT_DEFS, agent\)/);
});

test('声音上传以字节限流，并返回不泄漏内部细节的错误', () => {
  assert.match(source, /byteLength \+= chunk\.length/);
  assert.match(source, /error\.statusCode = 413/);
  assert.match(source, /Unable to save audio upload/);
  assert.match(source, /Unable to save sound assignment/);
});
