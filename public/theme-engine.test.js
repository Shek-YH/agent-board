'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'theme-engine.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    read(key) { return values.get(key); },
  };
}

function createDocument() {
  const values = new Map();
  return {
    documentElement: {
      dataset: {},
      style: {
        colorScheme: '',
        setProperty(key, value) { values.set(key, String(value)); },
        getPropertyValue(key) { return values.get(key) || ''; },
      },
    },
  };
}

function createMediaQuery(matches = false) {
  const listeners = new Set();
  return {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener(type, listener) { if (type === 'change') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'change') listeners.delete(listener); },
    emit(nextMatches) {
      this.matches = nextMatches;
      for (const listener of listeners) listener({ matches: nextMatches, media: this.media });
    },
  };
}

function loadThemeApi() {
  const context = { window: {}, console: { warn() {}, error() {} } };
  vm.runInNewContext(source, context, { filename: 'theme-engine.js' });
  return context.window.AgentBoardTheme;
}

test('Theme Registry 注册九个内置主题，system 只作为选择模式', () => {
  const api = loadThemeApi();
  assert.equal(api.builtinThemes.length, 9);
  assert.equal(JSON.stringify(api.builtinThemes.map((theme) => theme.id)), JSON.stringify([
    'light', 'dark', 'arctic', 'crt-green', 'ember', 'miami', 'synthwave', 'terminal', 'vapor',
  ]));
  assert.equal(api.getTheme('system'), undefined);
  assert.equal(api.resolveTheme('system', true), 'dark');
  assert.equal(api.resolveTheme('system', false), 'light');
  for (const theme of api.builtinThemes) {
    assert.equal(api.validateThemeDefinition(theme), true);
    assert.equal(theme.builtin, true);
    assert.equal(theme.version, 1);
    assert.equal(theme.metadata.premium, false);
  }
});

test('Theme Manager 分离 selected/resolved，并立即应用 CSS Variables', () => {
  const api = loadThemeApi();
  const document = createDocument();
  const storage = createStorage({ 'agent-board-theme': JSON.stringify({ selected: 'system', version: 1 }) });
  const media = createMediaQuery(false);
  const manager = api.createThemeManager({ document, storage, matchMedia: () => media });

  manager.initialize();
  assert.equal(manager.getSelectedTheme(), 'system');
  assert.equal(manager.getResolvedTheme(), 'light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(document.documentElement.dataset.themeSelected, 'system');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.equal(document.documentElement.style.getPropertyValue('--background'), '#F8FAFC');

  manager.setTheme('crt-green');
  assert.equal(manager.getSelectedTheme(), 'crt-green');
  assert.equal(manager.getResolvedTheme(), 'crt-green');
  assert.equal(document.documentElement.dataset.theme, 'crt-green');
  assert.equal(document.documentElement.dataset.themeEffect, 'crt');
  assert.equal(JSON.parse(storage.read('agent-board-theme')).selected, 'crt-green');
  assert.equal(document.documentElement.style.getPropertyValue('--agent-running'), '#5CFF7A');

  const restored = api.createThemeManager({
    document: createDocument(),
    storage,
    matchMedia: () => media,
  });
  restored.initialize();
  assert.equal(restored.getSelectedTheme(), 'crt-green');
  assert.equal(restored.getResolvedTheme(), 'crt-green');
});

test('system 模式监听系统变化，未知主题安全 fallback 并保留系统模式', () => {
  const api = loadThemeApi();
  const document = createDocument();
  const storage = createStorage({ 'agent-board-theme': JSON.stringify({ selected: 'theme-does-not-exist', version: 1 }) });
  const media = createMediaQuery(false);
  const warnings = [];
  const manager = api.createThemeManager({
    document,
    storage,
    matchMedia: () => media,
    logger: { warn(message) { warnings.push(message); } },
  });
  const changes = [];
  manager.subscribe((snapshot) => changes.push(snapshot));

  manager.initialize();
  assert.equal(manager.getSelectedTheme(), 'system');
  assert.equal(manager.getResolvedTheme(), 'light');
  assert.ok(warnings.some((message) => message.includes('Unknown Theme')));

  media.emit(true);
  assert.equal(manager.getSelectedTheme(), 'system');
  assert.equal(manager.getResolvedTheme(), 'dark');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(changes.at(-1).resolvedTheme, 'dark');
});

test('Theme Migration 兼容旧字符串、旧别名和嵌套 theme 配置', () => {
  const api = loadThemeApi();
  assert.equal(JSON.stringify(api.migrateThemeSettings('dark')), JSON.stringify({ selected: 'dark', version: 1 }));
  assert.equal(JSON.stringify(api.migrateThemeSettings({ selected: 'crt', version: 0 })), JSON.stringify({ selected: 'crt-green', version: 1 }));
  assert.equal(JSON.stringify(api.migrateThemeSettings({ theme: { selected: 'miami' } })), JSON.stringify({ selected: 'miami', version: 1 }));
  assert.equal(JSON.stringify(api.migrateThemeSettings({ selected: 'unknown-theme', version: 1 })), JSON.stringify({ selected: 'system', version: 1 }));
});

test('设置面板从 Theme Registry 渲染可访问的主题按钮，并交给 Manager 切换', () => {
  assert.match(appSource, /function openThemeSettings\(\)/);
  assert.match(appSource, /getAvailableThemes\(\)/);
  assert.match(appSource, /aria-pressed/);
  assert.match(appSource, /themeManager\.setTheme\(/);
  assert.match(appSource, /settings-theme/);
  assert.doesNotMatch(appSource, /settings-theme[\s\S]{0,200}document\.documentElement/);
  assert.match(appSource, /id="settings-theme"/);
  assert.doesNotMatch(appSource, /id="settings-skin"[^>]*disabled/);
  assert.match(htmlSource, /\.theme-option\{/);
  assert.match(htmlSource, /prefers-reduced-motion/);
});

test('九套主题都能应用到根节点，启动恢复在样式前完成', () => {
  const api = loadThemeApi();
  const document = createDocument();
  const manager = api.createThemeManager({ document, storage: createStorage(), matchMedia: () => createMediaQuery(false) });
  manager.initialize();
  for (const theme of api.builtinThemes) {
    const snapshot = manager.setTheme(theme.id);
    assert.equal(snapshot.resolvedTheme, theme.id);
    assert.equal(document.documentElement.dataset.theme, theme.id);
    assert.equal(document.documentElement.style.getPropertyValue('--background'), theme.tokens.background);
    assert.equal(document.documentElement.style.getPropertyValue('--popover-background'), theme.tokens.popoverBackground);
  }
  assert.ok(htmlSource.indexOf('<script src="/theme-engine.js">') < htmlSource.indexOf('<style>'));
  assert.match(htmlSource, /data-theme-effect="crt"/);
});
