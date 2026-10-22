// Sandboxed preload: must stay CommonJS (sandbox:true forbids ESM preloads).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ego', {
  action: (type, payload = {}) => ipcRenderer.invoke('ui:action', { type, ...payload }),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onHighlight: (cb) => ipcRenderer.on('highlight', (_e, p) => cb(p)),
  onFindOpen: (cb) => ipcRenderer.on('findbar:open', () => cb()),
  onFindResult: (cb) => ipcRenderer.on('findbar:result', (_e, r) => cb(r)),
});
