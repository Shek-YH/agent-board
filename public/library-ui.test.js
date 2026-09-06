'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLibraryPanels, LIMITS, sortNumericAsc, filterText, checkLength } = require('./library-ui');

test('LIMITS 与服务端校验常量一致', () => {
  assert.equal(LIMITS.groupName, 50);
  assert.equal(LIMITS.promptTitle, 100);
  assert.equal(LIMITS.promptContent, 10000);
  assert.equal(LIMITS.category, 50);
  assert.equal(LIMITS.entryTitle, 200);
  assert.equal(LIMITS.entryContent, 100000);
});

test('sortNumericAsc 按数值升序排列', () => {
  const items = [
    { id: 'a', sort_order: 20, created_at: 'x' },
    { id: 'b', sort_order: 5, created_at: 'y' },
    { id: 'c', sort_order: '10', created_at: 'z' },
  ];
  assert.deepEqual(sortNumericAsc(items, 'sort_order').map((x) => x.id), ['b', 'c', 'a']);
});

test('sortNumericAsc 数值相同时按 created_at 稳定排序', () => {
  const items = [
    { id: 'a', order: 1, createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'b', order: 1, createdAt: '2026-08-01T00:00:00.000Z' },
  ];
  assert.deepEqual(sortNumericAsc(items, 'order').map((x) => x.id), ['b', 'a']);
});

test('sortNumericAsc 不修改原数组', () => {
  const items = [{ id: 'a', order: 2 }, { id: 'b', order: 1 }];
  const copy = items.slice();
  sortNumericAsc(items, 'order');
  assert.deepEqual(items, copy);
});

test('filterText 大小写不敏感匹配标题/内容/分类', () => {
  const items = [
    { title: 'Code Review 模板', content: '检查边界条件', category: '代码' },
    { title: '周报', content: 'code review 汇总', category: '管理' },
    { title: '无关', content: '今天天气不错', category: '生活' },
  ];
  assert.equal(filterText(items, 'CODE', ['title', 'content', 'category']).length, 2);
  assert.equal(filterText(items, '代码', ['title', 'content', 'category']).length, 1);
  assert.equal(filterText(items, '管理', ['title', 'content', 'category']).length, 1);
  assert.equal(filterText(items, '不存在', ['title', 'content', 'category']).length, 0);
});

test('filterText 空关键词返回原数组', () => {
  const items = [{ title: 'x' }];
  assert.equal(filterText(items, '  ', ['title']), items);
});

test('checkLength 校验空值、长度与正常输入', () => {
  assert.throws(() => checkLength('', '标题', 100), /不能为空/);
  assert.throws(() => checkLength('   ', '标题', 100), /不能为空/);
  assert.throws(() => checkLength('a'.repeat(101), '标题', 100), /不能超过 100/);
  assert.equal(checkLength('  hello  ', '标题', 100), 'hello');
});

test('createLibraryPanels 缺少 requestJson 时抛类型错误', () => {
  assert.throws(() => createLibraryPanels({}), TypeError);
  assert.throws(() => createLibraryPanels({ requestJson: null }), TypeError);
  assert.doesNotThrow(() => createLibraryPanels({ requestJson: async () => ({}) }));
});
