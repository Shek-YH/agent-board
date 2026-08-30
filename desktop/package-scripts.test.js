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

test('runtime 准备脚本不依赖构建机的 WorkBuddy 私有目录', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'prepare-runtime.ps1'), 'utf8');
  assert.doesNotMatch(script, /\.workbuddy[\\/]/i);
  assert.match(script, /AGENT_BOARD_NODE_SOURCE/i);
  assert.match(script, /runtime[\\/]node\.exe/i);
});

test('免登录通测版使用独立 lite 构建配置和输出名称', () => {
  const liteConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.lite.json'), 'utf8'));
  assert.equal(packageJson.scripts['desktop:dist:lite'].includes('electron-builder --config electron-builder.lite.json'), true);
  assert.equal(liteConfig.extraMetadata.agentBoardLiteMode, true);
  assert.equal(liteConfig.productName, '免登录最新版');
  assert.equal(liteConfig.artifactName, '免登录最新版.${ext}');
  assert.equal(liteConfig.directories.output, 'F:\\CCPJ\\AgentBoard2.1lite');
});

test('桌面包为内置后端写入 CommonJS package 标记，避免外部目录 type=module 污染', () => {
  const marker = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'backend-package.json'), 'utf8'));
  const hasMarker = packageJson.build.extraResources.some((item) => item.to === 'backend/package.json');
  assert.equal(marker.type, 'commonjs');
  assert.equal(hasMarker, true);
});

test('桌面主进程引用的云端授权模块必须随源代码存在', () => {
  for (const fileName of ['secure-store.js', 'cloud-license-client.js', 'build-profile.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, fileName)), true, `${fileName} is missing`);
  }
});

test('普通桌面包内置生产云端地址，免登录包仍可通过 lite 元数据关闭云端', () => {
  assert.equal(packageJson.build.extraMetadata.agentBoardCloudUrl, 'https://api.agent.9aizhuan.com');
  const liteConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.lite.json'), 'utf8'));
  assert.equal(liteConfig.extraMetadata.agentBoardLiteMode, true);
});
