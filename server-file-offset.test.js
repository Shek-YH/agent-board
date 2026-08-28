'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const claude = require('./lib/adapters/claude');
const workbuddy = require('./lib/adapters/workbuddy');
const pi = require('./lib/adapters/pi');
const deepseek = require('./lib/adapters/deepseek');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function loadFileOffsetResolver() {
  const start = serverSource.indexOf('function fileOffsetKey(adapter, filePath)');
  const match = /\r?\n\r?\nfunction prepareFileOffset/.exec(serverSource.slice(start));
  const end = match ? start + match.index : -1;
  assert.ok(start >= 0, 'server must define the file offset resolver');
  assert.ok(end > start, 'server resolver must precede prepareFileOffset');
  return vm.runInNewContext(`(() => { ${serverSource.slice(start, end)}; return fileOffsetKey; })()`);
}

test('all file adapters expose versioned topology offset keys', () => {
  const file = 'C:\\sessions\\example.jsonl';
  assert.equal(claude.fileOffsetKey(file), `offset:topology-v2:claude:${file}`);
  assert.equal(workbuddy.fileOffsetKey(file), `offset:topology-v2:workbuddy:${file}`);
  assert.equal(pi.fileOffsetKey(file), `offset:topology-v2:pi:${file}`);
  assert.equal(deepseek.fileOffsetKey(file), `offset:topology-v3:deepseek:${file}`);
});

test('server resolver honors adapter keys and keeps legacy fallback for Codex', () => {
  const resolve = loadFileOffsetResolver();
  const file = 'C:\\sessions\\example.jsonl';
  assert.equal(resolve({ ID: 'claude', fileOffsetKey: claude.fileOffsetKey }, file), claude.fileOffsetKey(file));
  assert.equal(resolve({ ID: 'deepseek', fileOffsetKey: deepseek.fileOffsetKey }, file), deepseek.fileOffsetKey(file));
  assert.equal(resolve({ ID: 'codex' }, file), `offset:codex:${file}`);
});

test('an old consumed offset does not seed a new topology key', () => {
  const resolve = loadFileOffsetResolver();
  const file = 'C:\\sessions\\example.jsonl';
  const adapter = { ID: 'claude', fileOffsetKey: claude.fileOffsetKey };
  const oldKey = `offset:${adapter.ID}:${file}`;
  const newKey = resolve(adapter, file);
  const meta = new Map([[oldKey, '42']]);
  assert.equal(meta.get(oldKey), '42');
  assert.equal(meta.get(newKey), undefined);
  assert.equal(Number(meta.get(newKey) || 0), 0);
});

test('server initial scan, truncation reset, and deletion reset all use resolver', () => {
  const scanStart = serverSource.indexOf('async function scanAll');
  const prepareStart = serverSource.indexOf('function prepareFileOffset');
  const pollStart = serverSource.indexOf('function pollChanged');
  const scanEnd = serverSource.indexOf('\nfunction pollChanged', scanStart);
  const scan = serverSource.slice(scanStart, scanEnd);
  const prepare = serverSource.slice(prepareStart, pollStart);
  const poll = serverSource.slice(pollStart);

  assert.match(scan, /fileOffsetKey\(j\.adapter, j\.file\)/);
  assert.match(prepare, /fileOffsetKey\(adapter, filePath\)/);
  assert.match(poll, /fileOffsetKey\(adapter, p\)/);
});
