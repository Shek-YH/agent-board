const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('cloud bootstrap binds to the validated configured API host', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
  assert.match(source, /app\.listen\(config\.port, config\.apiHost\)/);
  assert.doesNotMatch(source, /app\.listen\(config\.port, ['"]0\.0\.0\.0['"]\)/);
});
