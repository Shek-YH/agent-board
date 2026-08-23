'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { shouldContainWheel } = require('./scroll-containment');

const scrollable = { scrollTop: 0, clientHeight: 100, scrollHeight: 300 };

test('滚动容器到顶部时阻止继续向上把滚轮传给页面', () => {
  assert.equal(shouldContainWheel(scrollable, -1), true);
});

test('滚动容器到中间时保留自身滚动', () => {
  assert.equal(shouldContainWheel({ ...scrollable, scrollTop: 50 }, 1), false);
});

test('滚动容器到底部时阻止继续向下把滚轮传给页面', () => {
  assert.equal(shouldContainWheel({ ...scrollable, scrollTop: 200 }, 1), true);
});
