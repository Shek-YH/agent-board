'use strict';

(function exposeShortcutUtils(root) {
  const namedKeys = {
    Backquote: '`',
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    Escape: 'Esc',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };

  function keyName(event) {
    const code = event?.code || '';
    if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)) return null;
    if (namedKeys[code]) return namedKeys[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    const key = typeof event?.key === 'string' ? event.key : '';
    if (key.length === 1 && !/\s/.test(key)) return key.toUpperCase();
    return null;
  }

  function acceleratorFromKeyboardEvent(event) {
    if (!event || event.isComposing) return null;
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Control');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey) modifiers.push('Super');
    const key = keyName(event);
    if (!modifiers.length || !key) return null;
    return [...modifiers, key].join('+');
  }

  function displayAccelerator(accelerator) {
    return String(accelerator || '')
      .replace(/\bControl\b/g, 'Ctrl')
      .replace(/\bSuper\b/g, 'Win');
  }

  root.AgentBoardShortcutUtils = { acceleratorFromKeyboardEvent, displayAccelerator };
})(window);
