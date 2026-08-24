'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { matchesSessionQuery } = require('./store');

test('项目路径查询只匹配完整项目路径', () => {
  const projects = [
    'F:\\CCPJ\\WX',
    'F:\\CCPJ\\WX\\.claude\\worktrees\\demo',
    'F:\\CCPJ\\WXdat',
  ];
  const projectPaths = new Set(projects.map((project) => project.toLowerCase()));

  assert.equal(matchesSessionQuery({ project: 'F:\\CCPJ\\WX' }, 'F:\\CCPJ\\WX', projectPaths, ''), true);
  assert.equal(matchesSessionQuery({ project: 'F:\\CCPJ\\WX\\.claude\\worktrees\\demo' }, 'F:\\CCPJ\\WX', projectPaths, ''), false);
  assert.equal(matchesSessionQuery({ project: 'F:\\CCPJ\\WXdat' }, 'F:\\CCPJ\\WX', projectPaths, ''), false);
});

test('普通关键词搜索仍支持匹配标题和用户消息', () => {
  const session = { title: '修复搜索', project: 'C:\\work' };

  assert.equal(matchesSessionQuery(session, '搜索', new Set(['c:\\work']), '请修复搜索逻辑'), true);
});
