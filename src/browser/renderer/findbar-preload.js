// Sandboxed preload for the findbar view (CommonJS required by sandbox:true).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('findbar', {
  action: (type, payload = {}) => ipcRenderer.invoke('ui:action', { type, ...payload }),
  onResult: (cb) => ipcRenderer.on('findbar:result', (_e, r) => cb(r)),
  onPrefill: (cb) => ipcRenderer.on('findbar:prefill', (_e, t) => cb(t)),
});
