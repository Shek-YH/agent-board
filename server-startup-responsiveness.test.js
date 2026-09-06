'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('Hermes 不递归监听包含缓存文件的根目录', () => {
  const start = source.indexOf('function startWatchers');
  const end = source.indexOf('// CLI agent 进程名', start);
  const watcherSource = source.slice(start, end);
  assert.match(watcherSource, /if \(a\.ID === 'hermes'\) continue;/);
  assert.equal((watcherSource.match(/if \(a\.ID === 'hermes'\) continue;/g) || []).length, 2);
});

test('启动扫描放到后端监听之后，首屏请求不等待扫描完成', () => {
  assert.match(source, /async function runStartupTasks\(\)/);
  assert.match(source, /server\.listen\(PORT, '127\.0\.0\.1', \(\) => \{/);
  // 启动任务改为 Promise.resolve().then 后台执行，不再 setImmediate + await 阻塞首屏请求
  assert.match(source, /Promise\.resolve\(\)\.then\(runStartupTasks\)/);
});

test('看板首屏不等待同步 Agent 探测', () => {
  const start = source.indexOf("if (pathname === '/api/board')");
  const end = source.indexOf('// 一键跳转到 AI agent', start);
  const boardSource = source.slice(start, end);
  assert.match(boardSource, /const probed = probeCache\.data \|\| \{\};/);
  assert.doesNotMatch(boardSource, /const probed = await getProbe\(\);/);
  assert.match(boardSource, /setImmediate\(\(\) => \{\s*getProbe\(\)/);
});
