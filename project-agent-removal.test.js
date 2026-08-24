'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = __dirname;
const SELF = path.resolve(__filename);
const REMOVED_ID = 'dou' + 'bao';
const REMOVED_NAME = '\u8c46\u5305';
const REMOVED_PATHS = [
  `lib/adapters/${REMOVED_ID}.js`,
  `lib/${REMOVED_ID}-extract.py`,
  `lib/${REMOVED_ID}-extract.test.js`,
  `lib/${REMOVED_ID}-extract-cache.test.js`,
  `public/icons/${REMOVED_ID}.jpg`,
  `logo/${REMOVED_NAME}.jpg`,
];
const TEXT_EXTENSIONS = new Set(['.bat', '.html', '.js', '.json', '.md', '.py', '.sh', '.txt', '.vbs']);

function collectTextFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'graphify-out') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTextFiles(full, out);
    else if (path.resolve(full) !== SELF && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

test('项目运行代码、资源和文档不再包含已移除 Agent', () => {
  for (const relative of REMOVED_PATHS) {
    assert.equal(fs.existsSync(path.join(ROOT, relative)), false, `残留文件: ${relative}`);
  }
  const forbidden = new RegExp(`${REMOVED_ID}|${REMOVED_NAME}`, 'i');
  for (const file of collectTextFiles(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, forbidden, `残留引用: ${path.relative(ROOT, file)}`);
  }
});
