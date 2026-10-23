// Sandboxed preload for the settings view (CommonJS required by sandbox:true).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wegoSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  close: () => ipcRenderer.invoke('ui:action', { type: 'settingsToggle' }),
  onShow: (cb) => ipcRenderer.on('settings:show', () => cb()),
});
