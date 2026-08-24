'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('顶部手动导入按钮右侧提供一键已读入口', () => {
  assert.match(html, /id="btn-import"[\s\S]*?id="btn-dismiss-recent"/);
  assert.match(html, /<button class="icon-btn header-read-all" id="btn-dismiss-recent"[^>]*>一键已读<\/button>/);
  assert.match(app, /\$\('btn-dismiss-recent'\)\.onclick = dismissAllRecent;/);
});

test('一键已读清除所有最近完成标记并同步当前卡片', () => {
  assert.match(app, /function dismissAllRecent\(\)/);
  assert.match(app, /for \(const ref of refs\)/);
  assert.match(app, /state\.recentDone\.delete\(ref\)/);
  assert.match(app, /state\.dismissedRecent\.add\(ref\)/);
  assert.match(app, /persistRecentDone\(\)/);
  assert.match(app, /applyFlowDecor\(el, ref, state\.liveRefs\.has\(ref\)\)/);
});
