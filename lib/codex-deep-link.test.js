'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const helperPath = path.join(__dirname, 'codex-deep-link.js');

function loadHelper() {
  return require('./codex-deep-link');
}

test('为合法 threadId 构造指定 Codex 会话深链', () => {
  assert.equal(fs.existsSync(helperPath), true, 'Codex 深链模块尚未实现');
  const { buildCodexDeepLink } = loadHelper();
  const threadId = '019e4751-d521-7290-9627-e501f3d7d2d3';
  assert.equal(buildCodexDeepLink(threadId), `codex://threads/${threadId}`);
});

test('从看板内部的 rollout session_id 提取末尾 Codex threadId', () => {
  assert.equal(fs.existsSync(helperPath), true, 'Codex 深链模块尚未实现');
  const { extractCodexThreadId } = loadHelper();
  assert.equal(typeof extractCodexThreadId, 'function', 'Codex session_id 提取函数尚未实现');
  const threadId = '01a02e58-1c91-7413-8080-c8c0c64941a9';
  assert.equal(
    extractCodexThreadId(`2026-08-23T07-18-41-${threadId}`),
    threadId,
  );
  assert.equal(extractCodexThreadId(threadId), threadId);
  assert.equal(extractCodexThreadId('2026-08-23T07-18-41-not-a-uuid'), null);
});

test('Codex threadId 校验允许大小写 UUID 并拒绝首尾空白以外的注入内容', () => {
  assert.equal(fs.existsSync(helperPath), true, 'Codex 深链模块尚未实现');
  const { isValidCodexThreadId } = loadHelper();
  assert.equal(isValidCodexThreadId('019E4751-D521-7290-9627-E501F3D7D2D3'), true);
  assert.equal(isValidCodexThreadId(' 019e4751-d521-7290-9627-e501f3d7d2d3 '), false);
  assert.equal(isValidCodexThreadId('codex://threads/019e4751-d521-7290-9627-e501f3d7d2d3'), false);
  assert.equal(isValidCodexThreadId('not-a-thread-id'), false);
});

test('拒绝无效 threadId，不生成任意协议链接', () => {
  assert.equal(fs.existsSync(helperPath), true, 'Codex 深链模块尚未实现');
  const { buildCodexDeepLink } = loadHelper();
  assert.throws(
    () => buildCodexDeepLink('javascript:alert(1)'),
    /无效的 Codex threadId/,
  );
});
