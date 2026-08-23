const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('提示音设置使用 B 布局，并排除已停用的 doubao', () => {
  assert.match(source, /id="settings-sound">提示音设置/);
  assert.match(source, /function openSoundSettings\(/);
  assert.match(source, /grid-template-columns:190px minmax\(360px,1fr\)/);
  assert.match(source, /filter\(\(\[id\]\) => id !== 'doubao'\)/);
});

test('提示音设置可上传、选择、试听并持久化请求', () => {
  assert.match(source, /new FileReader\(\)/);
  assert.match(source, /\/api\/sounds\/upload/);
  assert.match(source, /\/api\/sounds\/assign/);
  assert.match(source, /new Audio\(url\)/);
});

test('仅在完成迁移时按 Agent 分配播放提示音', () => {
  assert.match(source, /function markRecentlyCompleted\(ref\)/);
  assert.match(source, /state\.completionSounds\.assignments\[agent\]/);
  assert.match(source, /if \(sound\) playSoundPreview\(sound\.url\)/);
});
