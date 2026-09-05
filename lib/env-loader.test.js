'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadEnvFile, parseEnvContent } = require('./env-loader');

test('parseEnvContent supports comments, exports, quotes, and lower-case model keys', () => {
  const parsed = parseEnvContent([
    'export ZHIPU_API_KEY="secret-value"',
    'model=glm-test # local model',
    "EMPTY=''",
    'invalid line',
  ].join('\n'));

  assert.deepEqual(parsed, { ZHIPU_API_KEY: 'secret-value', model: 'glm-test' });
});

test('loadEnvFile fills missing environment values without overwriting explicit values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-env-'));
  const filePath = path.join(directory, '.env');
  fs.writeFileSync(filePath, 'ZHIPU_API_KEY=secret-value\nmodel=glm-test\n', 'utf8');
  const env = { ZHIPU_API_KEY: 'explicit-value' };

  const result = loadEnvFile({ filePath, env });

  assert.equal(result.loaded, true);
  assert.deepEqual(result.keys, ['model']);
  assert.equal(env.ZHIPU_API_KEY, 'explicit-value');
  assert.equal(env.model, 'glm-test');
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});
