'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const skillPath = path.join(__dirname, '..', 'skills', 'agent-board-install-agents', 'SKILL.md');
const skill = fs.readFileSync(skillPath, 'utf8');

test('应用管理提供每个 Agent 的自动配置路径按钮', () => {
  assert.match(app, /ab-discover-path/);
  assert.match(app, /discover-path/);
  assert.match(app, /自动配置路径/);
});

test('应用管理卡片复用顶栏 Agent 的真实图标文件', () => {
  assert.match(app, /function agentIconMarkup/);
  assert.match(app, /agentIconMarkup\(a, 'ab-agent-icon'\)/);
  assert.match(index, /\.ab-card-icon img/);
  assert.match(app, /src="\/icons\/\$\{esc\(def\.icon\)\}"/);
});

test('应用管理安装动作只打开官方下载链接，不执行后端安装命令', () => {
  assert.match(app, /downloadUrl/);
  assert.match(app, /window\.open\(downloadUrl/);
  assert.doesNotMatch(app, /fetch\(`\/api\/agents\/\$\{encodeURIComponent\(id\)\}\/install`/);
});

test('应用管理对预置探测 Agent 标记仅探测并隐藏自动配置按钮', () => {
  assert.match(app, /a\.probeOnly/);
  assert.match(app, /仅探测/);
  assert.match(app, /const discoverButton = a\.probeOnly/);
});

test('应用管理在窄窗口单列显示，并提供 Agent 安装 Skill 指引', () => {
  assert.match(index, /\.ab-agent-manager/);
  assert.match(index, /@media \(max-width:620px\)/);
  assert.match(index, /\.ab-agent-grid\{grid-template-columns:1fr\}/);
  assert.match(app, /agent-board-install-agents\.skill/);
  assert.match(app, /ab-install-guide/);
  assert.match(app, /复制调用指令/);
});

test('应用管理支持 CLI/Desktop 手动路径、清除和探测缓存失效', () => {
  assert.match(app, /ab-manual-path/);
  assert.match(app, /ab-manual-editor/);
  assert.match(app, /override-path/);
  assert.match(app, /saveLaunchOverrideSetting/);
  assert.match(server, /override-path/);
  assert.match(server, /仅支持 \.exe \/ \.cmd \/ \.bat/);
  assert.match(server, /probeCache = \{ data: null, ts: 0 \}/);
});

test('Agent 卡片不按网格行拉伸，并保持统一的固定高度', () => {
  assert.match(index, /\.ab-agent-grid\{[^}]*align-items:start/);
  assert.match(index, /\.ab-card\{[^}]*align-self:start/);
  assert.match(index, /\.ab-card\{[^}]*height:82px/);
  assert.match(index, /\.ab-card\{[^}]*overflow:hidden/);
  assert.match(index, /\.ab-card\{[^}]*display:flex/);
  assert.match(index, /\.ab-card-main\{[^}]*min-height:0[^}]*overflow:hidden/);
});

test('Agent 安装 Skill 必须先询问范围，再使用官方页面', () => {
  assert.match(skill, /你想安装全部 Agent，还是只安装其中几个/);
  assert.match(skill, /must not run a download/);
  assert.match(skill, /https:\/\/zcode\.z\.ai\/cn#all-downloads/);
  assert.match(skill, /并行/);
  assert.ok(fs.existsSync(path.join(__dirname, 'downloads', 'agent-board-install-agents.skill')));
});
