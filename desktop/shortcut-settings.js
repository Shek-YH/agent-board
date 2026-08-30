'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfigDir } = require('../lib/runtime-paths');

const DEFAULT_SHORTCUT = 'Alt+`';
const DEFAULT_JUMP_SHORTCUT = 'Alt+1';

function normalizeShortcut(value) {
  if (typeof value !== 'string') return null;
  const shortcut = value.trim();
  if (!shortcut || shortcut.length > 128 || /[\r\n]/.test(shortcut)) return null;
  return shortcut;
}

function getShortcutSettingsPath({ env = process.env, homedir = os.homedir(), platform = process.platform } = {}) {
  return path.join(getConfigDir({ env, homedir, platform }), 'shortcut-settings.json');
}

function defaultSettings() {
  return {
    activateApp: DEFAULT_SHORTCUT,
    jumpToLatestCompleted: DEFAULT_JUMP_SHORTCUT,
  };
}

function loadShortcutSettings(filePath = getShortcutSettingsPath()) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const defaults = defaultSettings();
    return {
      activateApp: normalizeShortcut(value?.activateApp) || defaults.activateApp,
      jumpToLatestCompleted: normalizeShortcut(value?.jumpToLatestCompleted) || defaults.jumpToLatestCompleted,
    };
  } catch {
    return defaultSettings();
  }
}

function saveShortcutSettings(input, filePath = getShortcutSettingsPath()) {
  const current = loadShortcutSettings(filePath);
  const requested = typeof input === 'string' ? { activateApp: input } : input;
  if (!requested || typeof requested !== 'object') throw new Error('快捷键不能为空');
  const settings = { ...current };
  for (const key of ['activateApp', 'jumpToLatestCompleted']) {
    if (!(key in requested)) continue;
    const normalized = normalizeShortcut(requested[key]);
    if (!normalized) throw new Error('快捷键不能为空');
    settings[key] = normalized;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

module.exports = {
  DEFAULT_SHORTCUT,
  DEFAULT_JUMP_SHORTCUT,
  getShortcutSettingsPath,
  loadShortcutSettings,
  saveShortcutSettings,
};
