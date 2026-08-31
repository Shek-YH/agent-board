'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const installerScriptPath = path.join(projectRoot, 'build', 'installer.nsh');

test('NSIS 更新卸载使用跨盘安全的原地删除策略', () => {
  assert.equal(packageJson.build.nsis.include, 'build/installer.nsh');

  const installerScript = fs.readFileSync(installerScriptPath, 'utf8');
  assert.match(installerScript, /!macro customInit/);
  assert.match(installerScript, /KEEP_APP_DATA/);
  assert.match(installerScript, /Call GetInQuotes/);
  assert.match(installerScript, /Call GetFileParent/);
  assert.doesNotMatch(installerScript, /ExecWait[^\r\n]*--updated/);
  assert.match(installerScript, /!macro customRemoveFiles/);
  assert.match(installerScript, /SetOutPath \$TEMP/);
  assert.match(installerScript, /RMDir \/r \$INSTDIR/);
  assert.doesNotMatch(installerScript, /Rename \s+"\$INSTDIR/);
});
