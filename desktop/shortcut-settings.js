'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfigDir } = require('../lib/runtime-paths');

const DEFAULT_SHORTCUT = 'Alt+`';

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
  return { activateApp: DEFAULT_SHORTCUT };
}

function loadShortcutSettings(filePath = getShortcutSettingsPath()) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const shortcut = normalizeShortcut(value?.activateApp);
    return shortcut ? { activateApp: shortcut } : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

function saveShortcutSettings(shortcut, filePath = getShortcutSettingsPath()) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) throw new Error('快捷键不能为空');
  const settings = { activateApp: normalized };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

module.exports = {
  DEFAULT_SHORTCUT,
  getShortcutSettingsPath,
  loadShortcutSettings,
  saveShortcutSettings,
};
