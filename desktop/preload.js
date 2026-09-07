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
  onToggleProjectTodoDrawer: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('shortcut:toggle-project-todo', listener);
    return () => ipcRenderer.removeListener('shortcut:toggle-project-todo', listener);
  },
  notifyCompletion: (agent, sessionId) => { /* 2026-09-07 暂时停用系统弹窗，仅保留语音通知；通道占位以备恢复 */ void agent; void sessionId; },
  selectProjectFolder: () => ipcRenderer.invoke('project:select-folder'),
  provider: Object.freeze({
    getStatus: () => ipcRenderer.invoke('provider:status'),
    setApiKey: (provider, apiKey) => ipcRenderer.invoke('provider:set-api-key', { provider, apiKey }),
    clearApiKey: (provider) => ipcRenderer.invoke('provider:clear-api-key', { provider }),
  }),
  cloud: Object.freeze({
    getStatus: () => ipcRenderer.invoke('cloud:status'),
    login: (email, password) => ipcRenderer.invoke('cloud:login', { email, password }),
    register: (email, password, activationCode) => ipcRenderer.invoke('cloud:register', { email, password, activationCode }),
    requestPasswordReset: (email) => ipcRenderer.invoke('cloud:forgot-password', { email }),
    logout: () => ipcRenderer.invoke('cloud:logout'),
    redeem: (code) => ipcRenderer.invoke('cloud:redeem', { code }),
    acquire: () => ipcRenderer.invoke('cloud:acquire'),
    release: () => ipcRenderer.invoke('cloud:release'),
  }),
});
