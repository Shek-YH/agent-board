'use strict';
// 集成测试：用户创作数据（待办 / 提示词 / 索引）在迁移、重装、清库、备份恢复场景下的持久化。
// 必须独占进程（每个测试文件独立进程），因为要控制 AB_DATA_DIR 并重载 store 模块。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-userdata-it-'));
process.env.AB_DATA_DIR = dataDir;

const legacyPath = path.join(dataDir, 'data.json');
const userDataPath = path.join(dataDir, 'user-data.json');

// 先写入「旧版」数据：三类用户数据与会话消息挤在同一个 data.json 里
fs.writeFileSync(legacyPath, JSON.stringify({
  sessions: [],
  messages: [],
  meta: [],
  hidden: [],
  todoTasks: [{ id: 't1', title: '写周报', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', sort_order: 1 }],
  promptGroups: [{ id: 'g1', name: '写作', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', sort_order: 1 }],
  prompts: [{ id: 'p1', group_id: 'g1', title: '标题生成', content: '帮我起标题', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', sort_order: 1 }],
  indexEntries: [{ id: 'e1', category: 'AI', title: '笔记一', content: '内容', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', order: 1 }],
  indexCategoryOrder: ['AI'],
}));

const store = require('../lib/store');

process.once('exit', () => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 系统兜底清理 */ }
});

test('首次启动把旧 data.json 里的用户数据迁移到独立 user-data.json', async () => {
  assert.equal(store.getTodoTasks().length, 1);
  assert.equal(store.getPrompts().length, 1);
  assert.equal(store.getIndexEntries().length, 1);
  assert.deepEqual(store.getIndexCategoryOrder(), ['AI']);
  await new Promise((resolve) => setTimeout(resolve, 400)); // 迁移为异步落盘
  assert.ok(fs.existsSync(userDataPath), '应生成独立 user-data.json');
});

test('新增数据写入独立文件，且 clearAll（清库）不再连带删除用户数据', async () => {
  store.createTodoTask({ title: '新任务' });
  store.createIndexEntry({ title: '新索引', content: 'x', category: 'AI' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const snap = JSON.parse(fs.readFileSync(userDataPath, 'utf-8'));
  assert.equal(snap.todoTasks.length, 2);
  assert.equal(snap.indexEntries.length, 2);

  store.clearAll();
  assert.equal(store.getTodoTasks().length, 2, '清库不应删除待办');
  assert.equal(store.getPrompts().length, 1, '清库不应删除提示词');
  assert.equal(store.getIndexEntries().length, 2, '清库不应删除索引');
});

test('模拟重装：删除会话缓存 data.json 后重启，用户数据完好', () => {
  fs.rmSync(legacyPath, { force: true });
  delete require.cache[require.resolve('../lib/store')];
  delete require.cache[require.resolve('./user-data-store')];
  const restarted = require('../lib/store');
  assert.equal(restarted.getTodoTasks().length, 2, '重装后待办应保留');
  assert.equal(restarted.getPrompts().length, 1, '重装后提示词应保留');
  assert.equal(restarted.getIndexEntries().length, 2, '重装后索引应保留');
});

test('备份快照包含四类数据，可被导出为 JSON', () => {
  const snapshot = store.getUserSnapshot();
  assert.ok(Array.isArray(snapshot.todoTasks));
  assert.ok(Array.isArray(snapshot.promptGroups));
  assert.ok(Array.isArray(snapshot.prompts));
  assert.ok(Array.isArray(snapshot.indexEntries));
  assert.ok(Array.isArray(snapshot.indexCategoryOrder));
  assert.equal(snapshot.todoTasks.length, 2);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test('导入备份：merge 模式补充数据，replace 模式整体替换', () => {
  const before = store.getTodoTasks().length;
  const merged = store.importUserData({
    todoTasks: [{ id: 't-import', title: '来自备份', created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z' }],
    indexEntries: [{ id: 'e-import', title: '备份索引', content: 'x', category: '备份', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' }],
  }, { mode: 'merge' });
  assert.equal(merged.todoTasks.length, before + 1);
  assert.equal(store.getIndexEntries().length, 3);

  const replaced = store.importUserData({
    todoTasks: [{ id: 't-only', title: '仅备份有', created_at: '2026-09-06T00:00:00.000Z', updated_at: '2026-09-06T00:00:00.000Z' }],
  }, { mode: 'replace' });
  assert.equal(replaced.todoTasks.length, 1);
  assert.equal(store.getTodoTasks().length, 1);
  assert.equal(store.getTodoTasks()[0].title, '仅备份有');
});
