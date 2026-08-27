'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { repairCredentialsText } = require('./dsh-credentials');

test('moves legacy top-level ECHOBIRD_API_KEY into the supported refs section', () => {
  const input = [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: secret-a',
    'ECHOBIRD_API_KEY: secret-b',
  ].join('\n');
  const result = repairCredentialsText(input);
  assert.equal(result.changed, true);
  assert.match(result.text, /refs:\n  DEEPSEEK_API_KEY: secret-a\n  ECHOBIRD_API_KEY: secret-b/);
  assert.doesNotMatch(result.text, /\nECHOBIRD_API_KEY:/);
});

test('does not rewrite credentials when the refs section is missing', () => {
  const input = 'version: 1\nECHOBIRD_API_KEY: secret-b\n';
  const result = repairCredentialsText(input);
  assert.equal(result.changed, false);
  assert.match(result.error, /refs/);
});
