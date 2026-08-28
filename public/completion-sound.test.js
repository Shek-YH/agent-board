const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('提示音设置使用 B 布局', () => {
  assert.match(source, /id="settings-sound">提示音设置/);
  assert.match(source, /function openSoundSettings\(/);
  assert.match(source, /grid-template-columns:190px minmax\(360px,1fr\)/);
});

test('提示音设置可上传、选择、试听并持久化请求', () => {
  assert.match(source, /new FileReader\(\)/);
  assert.match(source, /\/api\/sounds\/upload/);
  assert.match(source, /\/api\/sounds\/assign/);
  assert.match(source, /new Audio\(url\)/);
});

test('仅在完成迁移时按 Agent 分配播放提示音', () => {
  assert.match(source, /function markRecentlyCompleted\(ref\)/);
  assert.match(source, /const role = sessionRoleForRef\(ref\)/);
  assert.match(source, /if \(!isSoundRoleEnabled\(state\.completionSounds, agent, role\)\) return;/);
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

test('提示音设置提供主会话和子代理独立开关，并按会话角色播放', () => {
  assert.match(source, /disabledAgentRoles/);
  assert.match(source, /function sessionRoleForRef\(ref\)/);
  assert.match(source, /state\.sessionRoles\.set\(ref, a\.session_role\)/);
  assert.match(source, /function isSoundRoleEnabled\(settings, agent, role\)/);
  assert.match(source, /data-sound-role="child"/);
  assert.match(source, /const role = button\.dataset\.soundRole/);
});

test('升级修复时一次性清理旧的伪完成标记', () => {
  assert.match(source, /const RECENT_DONE_STATE_VERSION = '2';/);
  assert.match(source, /localStorage\.removeItem\('ab-recent-done'\)/);
  assert.match(source, /localStorage\.removeItem\('ab-recent-dismissed'\)/);
});
