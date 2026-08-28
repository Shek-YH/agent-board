'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AgentBoardDesktop', {
  getShortcutSettings: () => ipcRenderer.invoke('shortcut:get'),
  setShortcutSettings: (shortcut) => ipcRenderer.invoke('shortcut:set', shortcut),
});
