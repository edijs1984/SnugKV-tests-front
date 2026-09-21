const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('snugBench', {
  environment: () => ipcRenderer.invoke('bench:environment'),
  start: config => ipcRenderer.invoke('bench:start', config),
  cancel: () => ipcRenderer.invoke('bench:cancel'),
  save: payload => ipcRenderer.invoke('bench:save', payload),
  onUpdate: callback => {
    const listener = (_event, job) => callback(job)
    ipcRenderer.on('bench:update', listener)
    return () => ipcRenderer.removeListener('bench:update', listener)
  },
})
