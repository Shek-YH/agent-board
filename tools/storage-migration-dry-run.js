'use strict';

const fs = require('node:fs');
const { dryRunMigration } = require('../lib/storage/migration');

function usage() {
  console.error('Usage: node tools/storage-migration-dry-run.js <data.json> <user-data.json> <target.json>');
  process.exitCode = 2;
}

const [, , dataPath, userDataPath, targetPath] = process.argv;
if (!dataPath || !userDataPath || !targetPath) {
  usage();
} else {
  try {
    const result = dryRunMigration({
      dataPath,
      userDataPath,
      target: JSON.parse(fs.readFileSync(targetPath, 'utf8')),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
