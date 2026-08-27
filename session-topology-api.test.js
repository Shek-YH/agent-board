'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { resolveControlTarget } = require('./lib/session-topology');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('session topology API is read-only and delegates strict resolution', () => {
  assert.match(serverSource, /pathname === '\/api\/session-control-target'/);
  assert.match(serverSource, /store\.resolveSessionControlTarget/);
  assert.match(serverSource, /这里只做定位，不在本阶段发送指令/);
});

test('strict API contract exposes all safe outcomes without latest-session fallback', () => {
  const sessions = [
    { id: 'claude:main', agent: 'claude', project: 'C:\\demo', session_role: 'main', control_eligibility: 'eligible' },
    { id: 'claude:child', agent: 'claude', project: 'C:\\demo', session_role: 'child', control_eligibility: 'blocked' },
  ];
  assert.equal(resolveControlTarget(sessions, { agent: 'claude', project: 'C:/demo' }).status, 'resolved');
  assert.equal(resolveControlTarget([
    ...sessions,
    { id: 'claude:main-2', agent: 'claude', project: 'C:\\demo', session_role: 'main', control_eligibility: 'eligible' },
  ], { agent: 'claude', project: 'C:/demo' }).status, 'ambiguous');
  assert.equal(resolveControlTarget(sessions, { sessionRef: 'claude:child' }).status, 'blocked');
  assert.equal(resolveControlTarget(sessions, { agent: 'pi', project: 'C:/demo' }).status, 'not_found');
});
