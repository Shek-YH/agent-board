'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('全量重扫结束后只推送当前活跃会话快照', () => {
  const rescan = source.slice(source.indexOf("if (pathname === '/api/rescan'"));
  assert.match(source, /async function scanAll\(\{ full = false \} = \{\}\)/);
  assert.match(source, /const cutoff = full \? 0 : Date\.now\(\) - SCAN_DAYS/);
  assert.match(source, /event: active\\ndata: \$\{JSON\.stringify\(\{ active: store\.getActive\(\), statuses: store\.getRuntimeStatuses\(\) \}\)\}/);
  assert.match(rescan, /sseBroadcast\('active', \{ active: store\.getActive\(\), statuses: store\.getRuntimeStatuses\(\) \}\)/);
  assert.doesNotMatch(rescan, /sseBroadcast\('active', store\.getRecentActive\('day'\)\)/);
  assert.match(source, /setInterval\(\(\) => \{\s*if \(!isScanning\) sseBroadcast\('active', \{ active: store\.getActive\(\), statuses: store\.getRuntimeStatuses\(\) \}\);\s*\}, 5000\)/);
  assert.match(rescan, /store\.clearOffsets\(\)/);
  assert.match(rescan, /await scanAll\(\{ full: true \}\)/);
  assert.doesNotMatch(rescan, /store\.clearAll\(\)/);
});
