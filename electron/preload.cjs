const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('snugBench', {
  environment: () => ipcRenderer.invoke('bench:environment'),
  start: config => ipcRenderer.invoke('bench:start', config),
  cancel: () => ipcRenderer.invoke('bench:cancel'),
  save: payload => ipcRenderer.invoke('bench:save', payload),
  saveText: payload => ipcRenderer.invoke('bench:save-text', payload),
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
  resetAllStatistics: () => ipcRenderer.invoke('history:reset-all'),
  onHistoryUpdate: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('history:update', listener)
    return () => ipcRenderer.removeListener('history:update', listener)
  },
  validationSuites: () => ipcRenderer.invoke('validation:suites'),
  startValidation: (suiteId, options) => ipcRenderer.invoke('validation:start', { suiteId, options }),
  cancelValidation: () => ipcRenderer.invoke('validation:cancel'),
  onValidationUpdate: callback => {
    const listener = (_event, job) => callback(job)
    ipcRenderer.on('validation:update', listener)
    return () => ipcRenderer.removeListener('validation:update', listener)
  },
  console: {
    startServers: opts => ipcRenderer.invoke('console:servers:start', opts),
    stopServers: () => ipcRenderer.invoke('console:servers:stop'),
    connect: (id, addr) => ipcRenderer.invoke('console:connect', id, addr),
    disconnect: id => ipcRenderer.invoke('console:disconnect', id),
    run: (id, line) => ipcRenderer.invoke('console:run', id, line),
    publish: (id, channel, message, count) => ipcRenderer.invoke('console:publish', id, channel, message, count),
    subscribe: (id, kind, targets) => ipcRenderer.invoke('console:subscribe', id, kind, targets),
    unsubscribe: id => ipcRenderer.invoke('console:unsubscribe', id),
    onEvent: callback => {
      const listener = (_event, data) => callback(data)
      ipcRenderer.on('console:event', listener)
      return () => ipcRenderer.removeListener('console:event', listener)
    },
  },
  startPubSubLab: config => ipcRenderer.invoke('pubsub:start', config),
  cancelPubSubLab: () => ipcRenderer.invoke('pubsub:cancel'),
  onPubSubUpdate: callback => {
    const listener = (_event, job) => callback(job)
    ipcRenderer.on('pubsub:update', listener)
    return () => ipcRenderer.removeListener('pubsub:update', listener)
  },
  startRpcLab: config => ipcRenderer.invoke('rpc:start', config),
  cancelRpcLab: () => ipcRenderer.invoke('rpc:cancel'),
  onRpcUpdate: callback => {
    const listener = (_event, job) => callback(job)
    ipcRenderer.on('rpc:update', listener)
    return () => ipcRenderer.removeListener('rpc:update', listener)
  },
  dbListKeys: options => ipcRenderer.invoke('db:list-keys', options),
  dbGetKey: options => ipcRenderer.invoke('db:get-key', options),
  dbSetString: options => ipcRenderer.invoke('db:set-string', options),
  dbSetTtl: options => ipcRenderer.invoke('db:set-ttl', options),
  dbDeleteKey: options => ipcRenderer.invoke('db:delete-key', options),
  dbCreateExample: options => ipcRenderer.invoke('db:create-example', options),
  dbMutate: request => ipcRenderer.invoke('db:mutate', request),
  dbBulk: request => ipcRenderer.invoke('db:bulk', request),
  dbCommand: request => ipcRenderer.invoke('db:command', request),
  dbOverview: () => ipcRenderer.invoke('db:overview'),
  dbScan: options => ipcRenderer.invoke('db:scan', options),
  dbPipeline: request => ipcRenderer.invoke('db:pipeline', request),
  dbFlush: () => ipcRenderer.invoke('db:flush'),
})
