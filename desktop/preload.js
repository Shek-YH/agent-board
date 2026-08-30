'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AgentBoardDesktop', {
  getShortcutSettings: () => ipcRenderer.invoke('shortcut:get'),
  setShortcutSettings: (shortcut, kind = 'activateApp') => ipcRenderer.invoke('shortcut:set', { shortcut, kind }),
  onJumpToLatestCompleted: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('shortcut:jump-latest-completed', listener);
    return () => ipcRenderer.removeListener('shortcut:jump-latest-completed', listener);
  },
});
