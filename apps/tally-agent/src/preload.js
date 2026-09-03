'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  pingTally: () => ipcRenderer.invoke('tally:ping'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  getState: () => ipcRenderer.invoke('state:get'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
