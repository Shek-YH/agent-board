const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('设置中心提供账户与方案入口', () => {
  assert.match(source, /id="settings-account"[^>]*>账户与方案/);
  assert.match(source, /settings-account[^\n]*openAccountSettings/);
});

test('账户页展示未配置、免费和有效方案三种状态', () => {
  assert.match(source, /function openAccountSettings\(/);
  assert.match(source, /账号云服务尚未配置/);
  assert.match(source, /当前为免费方案/);
  assert.match(source, /当前方案：/);
  assert.match(source, /清除本地登录缓存/);
  assert.match(source, /退出登录/);
});

test('账户页读取状态并通过本地 API 退出登录', () => {
  assert.match(source, /fetch\('\/api\/account\/status'\)/);
  assert.match(source, /fetch\('\/api\/account\/logout',\s*\{/);
});
