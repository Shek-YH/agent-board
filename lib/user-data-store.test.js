'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createUserDataStore,
  normalizeSnapshot,
  mergeSnapshots,
  updatedAtOf,
  countAll,
  FILE_NAME,
} = require('./user-data-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ab-uds-'));
}

const task = (id, title, updated) => ({ id, title, updated_at: updated, created_at: '2026-09-01T00:00:00.000Z' });
const entry = (id, title, updated) => ({ id, title, category: 'AI', updatedAt: updated, createdAt: '2026-09-01T00:00:00.000Z' });

test('normalizeSnapshot 丢弃无 id 项、去重并补齐结构', () => {
  const out = normalizeSnapshot({
    todoTasks: [task('t1', 'a', 'x'), { title: '无 id' }, task('t1', '重复', 'x')],
    prompts: null,
    indexCategoryOrder: ['AI', 'AI', '', '工具'],
  });
  assert.equal(out.todoTasks.length, 1);
  assert.equal(out.todoTasks[0].title, 'a');
  assert.deepEqual(out.prompts, []);
  assert.deepEqual(out.indexCategoryOrder, ['AI', '工具']);
});

test('updatedAtOf 兼容 snake_case 与 camelCase', () => {
  const t1 = Date.parse('2026-09-02T00:00:00.000Z');
  assert.equal(updatedAtOf({ updated_at: '2026-09-02T00:00:00.000Z' }), t1);
  assert.equal(updatedAtOf({ updatedAt: '2026-09-02T00:00:00.000Z' }), t1);
  assert.equal(updatedAtOf({ created_at: '2026-09-03T00:00:00.000Z' }), Date.parse('2026-09-03T00:00:00.000Z'));
  assert.equal(updatedAtOf(null), 0);
});

test('mergeSnapshots 同 id 取更新的一份，其余取并集', () => {
  const disk = { todoTasks: [task('t1', '旧', '2026-09-01T00:00:00.000Z'), task('t2', '仅磁盘', '2026-09-01T00:00:00.000Z')] };
  const memory = { todoTasks: [task('t1', '新', '2026-09-05T00:00:00.000Z'), task('t3', '仅内存', '2026-09-05T00:00:00.000Z')] };
  const out = mergeSnapshots(disk, memory);
  const byId = Object.fromEntries(out.todoTasks.map((t) => [t.id, t.title]));
  assert.equal(byId.t1, '新');
  assert.equal(byId.t2, '仅磁盘');
  assert.equal(byId.t3, '仅内存');
});

test('mergeSnapshots 合并索引分类顺序（保留传入优先）', () => {
  const out = mergeSnapshots({ indexCategoryOrder: ['AI', '旧类'] }, { indexCategoryOrder: ['新类', 'AI'] });
  assert.deepEqual(out.indexCategoryOrder, ['新类', 'AI', '旧类']);
});

test('mergeSnapshots 删除不复活，且能感知别处新建', () => {
  // disk 是另一次写入后的磁盘状态；loadedAt 是本实例上次读取时刻
  const disk = {
    savedAt: '2026-09-10T00:00:00.000Z',
    todoTasks: [
      task('t1', '保留', '2026-09-01T00:00:00.000Z'),
      task('t2', '应被删', '2026-09-01T00:00:00.000Z'),
      task('t3', '别处新建', '2026-09-09T00:00:00.000Z'),
    ],
  };
  const memory = { todoTasks: [task('t1', '保留', '2026-09-01T00:00:00.000Z')] };
  const out = mergeSnapshots(disk, memory, { loadedAt: Date.parse('2026-09-05T00:00:00.000Z') });
  const ids = out.todoTasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['t1', 't3'], 't2 应被本实例删除并丢弃；t3 是别处新建应保留');
});

test('mergeSnapshots 本实例新建的条目（比磁盘写入新）应保留', () => {
  const disk = { savedAt: '2026-09-10T00:00:00.000Z', todoTasks: [task('t1', '旧', '2026-09-01T00:00:00.000Z')] };
  const memory = {
    todoTasks: [
      task('t1', '旧', '2026-09-01T00:00:00.000Z'),
      task('t9', '新建', '2026-09-11T00:00:00.000Z'), // 比 diskSavedAt 新
    ],
  };
  const out = mergeSnapshots(disk, memory);
  const ids = out.todoTasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['t1', 't9']);
});

test('countAll 统计四类数据总量', () => {
  assert.equal(countAll({ todoTasks: [1, 2], prompts: [1], indexEntries: [], promptGroups: [] }), 3);
  assert.equal(countAll(null), 0);
});

test('save 落盘并在二次写入时生成 .bak 备份', async () => {
  const dir = tmpDir();
  const store = createUserDataStore({ dir });
  await store.save({ todoTasks: [task('t1', 'a', '2026-09-01T00:00:00.000Z')] });
  const first = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf-8'));
  assert.equal(first.todoTasks.length, 1);
  await store.save({ todoTasks: [task('t1', 'a', '2026-09-01T00:00:00.000Z'), task('t2', 'b', '2026-09-02T00:00:00.000Z')] });
  assert.ok(fs.existsSync(path.join(dir, `${FILE_NAME}.bak`)), '应生成 .bak 备份');
});

test('save 与磁盘内容合并：不覆盖其他实例新写入的数据', async () => {
  const dir = tmpDir();
  const store = createUserDataStore({ dir });
  await store.save({ todoTasks: [task('t1', '本机', '2026-09-01T00:00:00.000Z')] });
  // 模拟另一个实例写入了一条新数据
  const other = { todoTasks: [task('t1', '本机', '2026-09-01T00:00:00.000Z'), task('t9', '另一实例', '2026-09-03T00:00:00.000Z')] };
  fs.writeFileSync(path.join(dir, FILE_NAME), JSON.stringify(other));
  const merged = await store.save({ todoTasks: [task('t1', '本机改名', '2026-09-04T00:00:00.000Z')] });
  const ids = merged.todoTasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['t1', 't9']);
  assert.equal(merged.todoTasks.find((t) => t.id === 't1').title, '本机改名');
});

test('load 在主文件损坏时回退 .bak 并修复主文件', () => {
  const dir = tmpDir();
  const file = path.join(dir, FILE_NAME);
  const good = { todoTasks: [task('t1', '完好数据', '2026-09-01T00:00:00.000Z')] };
  fs.writeFileSync(file, JSON.stringify(good));
  const store = createUserDataStore({ dir });
  assert.equal(store.load().data.todoTasks.length, 1);
  // 制造损坏：主文件截断
  fs.copyFileSync(file, file + '.bak'); // 先留一份完好备份
  fs.writeFileSync(file, '{"todoTasks":[{"id":"t1","ti');
  const loaded = store.load();
  assert.equal(loaded.source, 'bak');
  assert.equal(loaded.data.todoTasks.length, 1);
  // 加载后应把备份写回主文件
  const restored = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(restored.todoTasks.length, 1);
});

test('空快照不会覆盖磁盘上已有数据', async () => {
  const dir = tmpDir();
  const store = createUserDataStore({ dir });
  await store.save({ indexEntries: [entry('e1', '笔记', '2026-09-01T00:00:00.000Z')] });
  const guard = await store.save({ todoTasks: [], prompts: [], indexEntries: [], promptGroups: [] });
  assert.equal(guard.indexEntries.length, 1, '磁盘数据应被保留');
});

test('saveSync 同步落盘（进程退出路径）', () => {
  const dir = tmpDir();
  const store = createUserDataStore({ dir });
  store.saveSync({ prompts: [{ id: 'p1', group_id: 'g1', title: 'x', updated_at: '2026-09-01T00:00:00.000Z' }] });
  const disk = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf-8'));
  assert.equal(disk.prompts.length, 1);
});

test('load 在文件全部缺失时返回空快照且 source=none', () => {
  const dir = tmpDir();
  const store = createUserDataStore({ dir });
  const result = store.load();
  assert.equal(result.source, 'none');
  assert.equal(countAll(result.data), 0);
});
