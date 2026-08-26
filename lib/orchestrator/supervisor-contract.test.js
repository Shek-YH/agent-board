'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeSupervisorRequest } = require('./supervisor-contract');

test('supervisor contract accepts structured intent and drops arbitrary command fields', () => {
  const request = normalizeSupervisorRequest({
    projectPath: 'C:\\Projects\\demo', goal: '修复测试', mode: 'project', agent: 'codex',
    commands: ['format C:'], requestedBy: 'jarvis',
  });
  assert.deepEqual(request, {
    projectPath: 'C:\\Projects\\demo', goal: '修复测试', mode: 'project', agent: 'codex', requestedBy: 'jarvis',
  });
});

test('supervisor contract rejects unsupported execution agents', () => {
  assert.throws(() => normalizeSupervisorRequest({ projectPath: '.', goal: 'x', agent: 'shell' }), /unsupported execution agent/);
});
