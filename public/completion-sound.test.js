const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('提示音设置使用 B 布局', () => {
  assert.match(source, /id="settings-sound">提示音设置/);
  assert.match(source, /function openSoundSettings\(/);
  assert.match(source, /grid-template-columns:190px minmax\(360px,1fr\)/);
});

test('提示音资源使用紧凑的响应式网格展示', () => {
  assert.match(source, /class="sound-library"/);
  assert.match(source, /class="sound-row/);
  assert.match(source, /class="sound-name"/);
  assert.match(styles, /\.sound-library\{[^}]*display:grid/);
  assert.match(styles, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.sound-library\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(styles, /\.sound-library\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
});

test('提示音设置可上传、选择、试听并持久化请求', () => {
  assert.match(source, /new FileReader\(\)/);
  assert.match(source, /\/api\/sounds\/upload/);
  assert.match(source, /\/api\/sounds\/assign/);
  assert.match(source, /new Audio\(url\)/);
});

test('仅在完成迁移时按 Agent 分配播放提示音', () => {
  assert.match(source, /function markRecentlyCompleted\(ref\)/);
  assert.match(source, /const disabledAgents = new Set\(state\.completionSounds\.disabledAgents \|\| \[\]\)/);
  assert.match(source, /if \(disabledAgents\.has\(agent\)\) return;/);
  assert.match(source, /state\.completionSounds\.assignments\[agent\]/);
  assert.match(source, /if \(sound\) playSoundPreview\(sound\.url\)/);
});

test('提示音设置提供单 Agent 和一键全局开关', () => {
  assert.match(source, /disabledAgents/);
  assert.match(source, /class="sound-toggle\s/);
  assert.match(source, /id="sound-toggle-all"/);
  assert.match(source, /data-agent-toggle/);
  assert.match(source, /\/api\/sounds\/enabled/);
});

test('升级修复时一次性清理旧的伪完成标记', () => {
  assert.match(source, /const RECENT_DONE_STATE_VERSION = '2';/);
  assert.match(source, /localStorage\.removeItem\('ab-recent-done'\)/);
  assert.match(source, /localStorage\.removeItem\('ab-recent-dismissed'\)/);
});
