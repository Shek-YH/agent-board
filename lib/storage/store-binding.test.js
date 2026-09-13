'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const storeSource = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');

test('business Store loads snapshots through the Storage Adapter boundary', () => {
  assert.match(storeSource, /createJsonSnapshotStore/);
  assert.match(storeSource, /const snapshotStorage = createJsonSnapshotStore/);
  assert.match(storeSource, /const data = snapshotStorage\.load\(\)/);
});
