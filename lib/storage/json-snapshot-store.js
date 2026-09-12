'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertStorage } = require('./interface');

/** @param {{filePath?: string, backupDir?: string}} options */
function createJsonSnapshotStore(options = {}) {
  const { filePath, backupDir } = options;
  if (!filePath || !backupDir) throw new TypeError('filePath and backupDir are required');
  const adapter = {
    load() {
      if (!fs.existsSync(filePath)) return null;
      let text;
      try { text = fs.readFileSync(filePath, 'utf8'); } catch (error) {
        throw new Error(`unable to read JSON snapshot: ${error.message}`);
      }
      try { return JSON.parse(text); } catch (error) {
        throw new Error(`invalid JSON snapshot: ${error.message}`);
      }
    },
    save(snapshot) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      let backup = { created: false, path: null };
      if (fs.existsSync(filePath)) {
        const name = `${path.basename(filePath)}.${Date.now()}-${process.pid}.bak`;
        backup = { created: true, path: path.join(backupDir, name) };
        fs.copyFileSync(filePath, backup.path);
      }
      const tempPath = `${filePath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tempPath, JSON.stringify(snapshot), 'utf8');
        fs.renameSync(tempPath, filePath);
      } catch (error) {
        try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve original file */ }
        throw new Error(`unable to save JSON snapshot: ${error.message}`);
      }
      return { backup };
    },
  };
  return assertStorage(adapter);
}

module.exports = { createJsonSnapshotStore };
