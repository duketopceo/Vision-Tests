import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('argus', {
  collect: () => ipcRenderer.invoke('collect'),
  runEval: () => ipcRenderer.invoke('run-eval'),
  runLogs: (runId) => ipcRenderer.invoke('run-logs', runId),
  onEvalLog: (cb) => ipcRenderer.on('eval-log', (_e, m) => cb(m)),
  onLiveLog: (cb) => ipcRenderer.on('live-log', (_e, m) => cb(m)),
  onRunLog: (cb) => ipcRenderer.on('run-log', (_e, m) => cb(m)),
})
