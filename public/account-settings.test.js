const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const start = source.indexOf('function renderAccountSettings');
const end = source.indexOf('\n// 每个 agent 默认', start);

function createPopover() {
  return {
    button: null,
    style: {},
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html = value;
      this.button = value.includes('id="account-logout"') ? { disabled: false, onclick: null } : null;
    },
    querySelector(selector) {
      return selector === '#account-logout' ? this.button : null;
    },
  };
}

function loadAccountSettings(fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
  const popovers = [];
  const context = {
    closePopover() {},
    document: {
      body: { appendChild(pop) { popovers.push(pop); } },
      createElement() { return createPopover(); },
    },
    esc: (value) => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    fetch: fetchImpl,
    state: {},
    toast() {},
    module: { exports: {} },
  };
  vm.runInNewContext(`${source.slice(start, end)}\nmodule.exports = { openAccountSettings, renderAccountSettings };`, context);
  return { ...context.module.exports, popovers };
}

test('账户页按未配置、免费和有效方案状态渲染，并转义远端文案', () => {
  const { renderAccountSettings } = loadAccountSettings();
  const pop = createPopover();

  renderAccountSettings(pop, { state: 'unconfigured' });
  assert.match(pop.innerHTML, /账号云服务尚未配置/);
  assert.equal(pop.button, null);

  renderAccountSettings(pop, { hasCachedToken: false, state: 'free' });
  assert.match(pop.innerHTML, /当前为免费方案/);
  assert.equal(pop.button, null);

  renderAccountSettings(pop, { hasCachedToken: true, state: 'free' });
  assert.match(pop.innerHTML, /清除本地登录缓存/);
  assert.ok(pop.button);

  renderAccountSettings(pop, {
    account: { expiresAt: 2_000, plan: '<pro>' },
    features: ['team-sync', '<unsafe>'],
    state: 'active',
  });
  assert.match(pop.innerHTML, /当前方案：/);
  assert.match(pop.innerHTML, /&lt;pro&gt;/);
  assert.match(pop.innerHTML, /&lt;unsafe&gt;/);
  assert.match(pop.innerHTML, /退出登录/);
});

test('账户页从本地 API 加载状态，并在退出登录后重渲染', async () => {
  const calls = [];
  const statuses = [
    { hasCachedToken: true, state: 'free' },
    { hasCachedToken: false, state: 'free' },
  ];
  const { openAccountSettings, popovers } = loadAccountSettings(async (url, options) => {
    calls.push({ options, url });
    return { ok: true, status: 200, json: async () => statuses.shift() };
  });

  await openAccountSettings();
  const pop = popovers[0];
  assert.equal(calls[0].url, '/api/account/status');
  assert.match(pop.innerHTML, /清除本地登录缓存/);

  await pop.button.onclick();
  assert.equal(calls[1].url, '/api/account/logout');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(pop.button, null);
});
