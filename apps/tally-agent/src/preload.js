'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  pingTally: (draft) => ipcRenderer.invoke('tally:ping', draft),
  listCompanies: (draft) => ipcRenderer.invoke('tally:companies', draft),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  getState: () => ipcRenderer.invoke('state:get'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
