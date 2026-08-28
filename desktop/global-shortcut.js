'use strict';

function createGlobalShortcutController({ globalShortcut, onActivate = () => {} }) {
  let current = null;

  function apply(accelerator) {
    const next = typeof accelerator === 'string' ? accelerator.trim() : '';
    if (!next) return { ok: false, error: '快捷键不能为空', accelerator: current };
    if (next === current) return { ok: true, accelerator: current, changed: false };

    try {
      const registered = globalShortcut.register(next, onActivate);
      if (!registered) {
        return { ok: false, error: '快捷键已被占用或不可用', accelerator: current };
      }
    } catch {
      return { ok: false, error: '快捷键已被占用或不可用', accelerator: current };
    }

    if (current) {
      try { globalShortcut.unregister(current); } catch { /* 注册已成功，释放旧快捷键失败不应阻断新设置 */ }
    }
    current = next;
    return { ok: true, accelerator: current, changed: true };
  }

  function dispose() {
    if (!current) return;
    try { globalShortcut.unregister(current); } catch { /* 应用退出时忽略清理失败 */ }
    current = null;
  }

  return {
    apply,
    dispose,
    get current() { return current; },
  };
}

module.exports = { createGlobalShortcutController };
