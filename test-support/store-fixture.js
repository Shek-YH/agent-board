'use strict';

// 测试只能使用临时数据目录，避免 node --test 读写用户真实的 AgentBoard 数据。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-data-'));
process.env.AB_DATA_DIR = testDataDir;

const store = require('../lib/store');

process.once('exit', () => {
  try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch { /* 临时目录清理由系统兜底 */ }
});

module.exports = store;
