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

test('全局跳转快捷键选择最新完成任务，并仅在跳转成功后标记已读', () => {
  assert.match(html, /recent-completed-jump\.js/);
  assert.match(app, /onJumpToLatestCompleted/);
  assert.match(app, /function jumpToLatestCompleted\(\)/);
  assert.match(app, /findLatestEligibleCompletion/);
  assert.match(app, /await jumpToAgentSession\(candidate\.session\)/);
  assert.match(app, /if \(jumped\)[\s\S]*dismissRecent\(candidate\.session\.id\)/);
  assert.match(app, /暂无符合条件的已完成任务/);
});
