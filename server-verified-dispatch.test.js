'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

test('verified dispatch route is present and only accepts the Slice 0 request fields', () => {
  assert.match(serverSource, /require\('\.\/lib\/verified-dispatch'\)/);
  assert.match(serverSource, /require\('\.\/lib\/codex-desktop-uia'\)/);
  assert.match(serverSource, /require\('\.\/lib\/hermes-desktop-uia'\)/);
  assert.match(serverSource, /require\('\.\/lib\/codex-delivery'\)/);
  assert.match(serverSource, /require\('\.\/lib\/hermes-delivery'\)/);
  assert.match(serverSource, /pathname === '\/api\/verified-dispatch' && req\.method === 'POST'/);
  assert.match(serverSource, /body\.agent/);
  assert.match(serverSource, /body\.project/);
  assert.match(serverSource, /body\.sessionRef/);
  assert.match(serverSource, /body\.message/);
  assert.match(serverSource, /dispatchVerifiedMessage\(/);
});

test('verified dispatch route delegates to strict resolution and reports reconciliation without retrying', () => {
  assert.match(serverSource, /store\.resolveSessionControlTarget\(/);
  assert.match(serverSource, /launchSchemeTargetPromise\(/);
  assert.match(serverSource, /launchHermesThenFocus\(/);
  assert.match(serverSource, /verifyCodexDesktopSession/);
  assert.match(serverSource, /verifyHermesDesktopSession/);
  assert.match(serverSource, /createCodexDeliveryReader/);
  assert.match(serverSource, /createHermesDeliveryReader/);
  assert.match(serverSource, /reconciliation_required/);
  assert.doesNotMatch(serverSource, /verified-dispatch[\s\S]{0,800}setTimeout\([^)]*retry/i);
});

test('verified dispatch route remains scoped to Codex and Hermes POC agents', () => {
  const routeStart = serverSource.indexOf("pathname === '/api/verified-dispatch'");
  assert.ok(routeStart >= 0);
  const routeEnd = serverSource.indexOf("\n  // 按 threadId 打开指定 Codex 会话", routeStart);
  const route = serverSource.slice(routeStart, routeEnd >= 0 ? routeEnd : routeStart + 9000);
  assert.match(route, /createVerifiedDispatchDependencies/);
  assert.match(route, /!request\.sessionRef && !request\.project/);
  const dependencyFactory = serverSource.slice(serverSource.indexOf('function createVerifiedDispatchDependencies'), routeStart);
  assert.match(dependencyFactory, /agent === 'codex'/);
  assert.match(dependencyFactory, /agent === 'hermes'/);
  assert.doesNotMatch(route, /model/);
  assert.doesNotMatch(route, /retry/i);
});
