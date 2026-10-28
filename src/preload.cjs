const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  getState: () => ipcRenderer.invoke('deck:get'),
  command: (command) => ipcRenderer.invoke('deck:command', command),
  setBounds: (bounds) => ipcRenderer.send('deck:bounds', bounds),
  setModal: (open) => ipcRenderer.send('deck:modal', open),
  onState: (callback) => ipcRenderer.on('deck:state', (_event, state) => callback(state)),
  onNotice: (callback) => ipcRenderer.on('deck:notice', (_event, message) => callback(message)),
  onLayout: (callback) => ipcRenderer.on('deck:layout', () => callback()),
});
