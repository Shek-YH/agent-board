const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test('提示音设置使用 A 布局并明确展示子代理通知', () => {
  assert.match(source, /id="settings-sound">提示音设置/);
  assert.match(source, /function openSoundSettings\(/);
  assert.match(source, /grid-template-columns:190px minmax\(360px,1fr\)/);
  assert.match(source, /子代理完成通知/);
  assert.match(source, /当前提示音（主任务与子代理共用）/);
});

test('提示音资源改为下拉选择并保留声音库管理', () => {
  assert.match(source, /class="sound-library"/);
  assert.match(source, /class="sound-name"/);
  assert.match(source, /<select id="completion-sound-select"/);
  assert.doesNotMatch(source, /name="completion-sound" value=/);
  assert.match(styles, /\.sound-select/);
});

test('提示音设置可上传、选择、试听并持久化请求', () => {
  assert.match(source, /new FileReader\(\)/);
  assert.match(source, /\/api\/sounds\/upload/);
  assert.match(source, /\/api\/sounds\/assign/);
  assert.match(source, /new Audio\(url\)/);
});

test('子代理完成通知只读取子代理作用域，不影响主会话提示音', () => {
  assert.match(source, /function markRecentlyCompleted\(ref\)/);
  assert.match(source, /const role = sessionRoleForRef\(ref\)/);
  assert.match(source, /if \(!isSoundRoleEnabled\(state\.completionSounds, agent, role\)\) return;/);
  assert.match(source, /state\.completionSounds\.assignments\[agent\]/);
  assert.match(source, /if \(sound\) playSoundPreview\(sound\.url\)/);

  const isSoundRoleEnabled = vm.runInNewContext(`(${extractFunction('isSoundRoleEnabled')})`);
  assert.equal(isSoundRoleEnabled({ disabledAgentRoles: ['codex:child'] }, 'codex', 'main'), true);
  assert.equal(isSoundRoleEnabled({ disabledAgentRoles: ['codex:child'] }, 'codex', 'child'), false);
  assert.equal(isSoundRoleEnabled({ disabledAgentRoles: [] }, 'codex', 'child'), true);
});

test('提示音设置提供子代理单 Agent 和一键全局开关', () => {
  assert.match(source, /disabledAgents/);
  assert.match(source, /class="sound-toggle\s/);
  assert.match(source, /id="sound-toggle-subagent-all-on"/);
  assert.match(source, /id="sound-toggle-subagent-all-off"/);
  assert.match(source, /id="sound-subagent-toggle"/);
  assert.match(source, /data-agent-toggle/);
  assert.match(source, /role = 'all'/);
  assert.match(source, /\/api\/sounds\/enabled/);
  assert.match(serverSource, /body\.role === undefined/);
});

test('提示音开关接口支持主会话与子代理作用域', () => {
  assert.match(source, /disabledAgentRoles/);
  assert.match(source, /function sessionRoleForRef\(ref\)/);
  assert.match(source, /state\.sessionRoles\.set\(ref, a\.session_role\)/);
  assert.match(source, /function isSoundRoleEnabled\(settings, agent, role\)/);
  assert.match(source, /applyEnabled\(\[selectedAgent\], !childEnabled/);
});

test('升级修复时一次性清理旧的伪完成标记', () => {
  assert.match(source, /const RECENT_DONE_STATE_VERSION = '2';/);
  assert.match(source, /localStorage\.removeItem\('ab-recent-done'\)/);
  assert.match(source, /localStorage\.removeItem\('ab-recent-dismissed'\)/);
});
