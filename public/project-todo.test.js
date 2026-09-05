'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'project-todo.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('项目 Todo 抽屉默认隐藏，并支持 Hover、快捷键和固定状态', () => {
  assert.match(source, /mode: readBoolean\(storage, PINNED_KEY, false\) \? 'pinned' : 'hidden'/);
  assert.match(source, /const OPEN_DELAY_MS = 80/);
  assert.match(source, /const CLOSE_DELAY_MS = 300/);
  assert.match(source, /Alt\+Q 呼出/);
  assert.match(source, /if \(value == null \|\| value === ''\) return DEFAULT_WIDTH/);
  assert.match(source, /data-mode="hidden"/);
  assert.match(source, /Alt\+Q 呼出/);
  assert.match(source, /event\.altKey && !event\.ctrlKey && !event\.metaKey && !event\.shiftKey/);
  assert.match(source, /state\.mode === 'peek' \? setMode\('hidden'\) : setMode\('peek'\)/);
});

test('Todo 抽屉为全局清单，支持手动添加、一级子任务和偏好持久化', () => {
  assert.match(source, /requestJson\('\/api\/todos'\)/);
  assert.match(source, /body: JSON\.stringify\(\{ parentId, title: value \}\)/);
  assert.doesNotMatch(source, /state\.projectId|state\.projectName|setProject\(/);
  assert.match(source, /data-action="hover-enabled"/);
  assert.match(source, /HOVER_KEY/);
  assert.match(source, /HIDE_COMPLETED_KEY/);
  assert.match(source, /WIDTH_KEY/);
  assert.match(source, /data-role="resize"/);
  assert.match(source, /pointermove/);
  assert.match(source, /aria-valuemin="280" aria-valuemax="480"/);
  assert.match(html, /\.todo-subtasks\{margin-left:36px;padding-left:8px;border-left:1px solid/);
  assert.match(html, /\.todo-drawer\[data-mode="peek"\],\.todo-drawer\[data-mode="pinned"\]\{[^}]*transform:translateX\(0\)/);
});

test('Todo 清单启动时预加载并复用缓存，避免每次打开重复请求', () => {
  assert.match(source, /const TODO_CACHE_TTL_MS = 30 \* 1000/);
  assert.match(source, /let refreshPromise = null/);
  assert.match(source, /function refresh\(\{ force = false \} = \{\}\)/);
  assert.match(source, /state\.loaded && Date\.now\(\) - lastLoadedAt < TODO_CACHE_TTL_MS/);
  assert.match(source, /await refresh\(\{ force: true \}\)/);
  assert.match(source, /void refresh\(\);/);
});

test('Todo 渲染预先建立父子任务索引，避免每个父任务重复扫描全集', () => {
  assert.match(source, /let childrenIndex = new Map\(\)/);
  assert.match(source, /function rebuildTaskIndexes\(\)/);
  assert.match(source, /childrenIndex\.get\(parentId\)/);
});
