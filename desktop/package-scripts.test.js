'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('Windows 桌面包构建会先准备内置 Node runtime 和窗口聚焦 DLL', () => {
  assert.match(packageJson.scripts['desktop:prepare'], /prepare-runtime\.ps1/);
  assert.match(packageJson.scripts['desktop:prepare'], /build-focus-dll\.ps1/);
  assert.match(packageJson.scripts['desktop:dist'], /desktop:prepare/);
});

test('桌面包校验脚本允许 npm 调用方传入待校验目录', () => {
  assert.equal(packageJson.scripts['desktop:verify'], 'node tools/verify-package.js');
});

test('runtime 准备脚本不依赖构建机的 WorkBuddy 私有目录', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'prepare-runtime.ps1'), 'utf8');
  assert.doesNotMatch(script, /\.workbuddy[\\/]/i);
  assert.match(script, /AGENT_BOARD_NODE_SOURCE/i);
  assert.match(script, /runtime[\\/]node\.exe/i);
});
