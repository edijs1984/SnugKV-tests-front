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
  serverStatus: () => ipcRenderer.invoke('server:status'),
  startServer: (kind, optimizerMode = 'dedicated') =>
    ipcRenderer.invoke('server:start', { kind, optimizerMode }),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  onServerUpdate: callback => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('server:update', listener)
    return () => ipcRenderer.removeListener('server:update', listener)
  },
  bestResults: profile => ipcRenderer.invoke('history:get', profile),
  resetBestResults: profile => ipcRenderer.invoke('history:reset', profile),
  onHistoryUpdate: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('history:update', listener)
    return () => ipcRenderer.removeListener('history:update', listener)
  },
})
