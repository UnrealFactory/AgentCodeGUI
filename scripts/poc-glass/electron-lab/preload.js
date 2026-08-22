const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('lab', {
  hello: () => ipcRenderer.invoke('lab:hello'),
  on: (cb) => ipcRenderer.on('lab', (_e, s) => cb(s))
})
