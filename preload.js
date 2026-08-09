// Bridge between the sandboxed renderer and the main process RPC bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prime', {
  // Generic RPC command -> { success, data, error }
  command: (cmd) => ipcRenderer.invoke('rpc:command', cmd),
  restartRpc: (cwd) => ipcRenderer.invoke('rpc:restart', cwd),

  listSessions: () => ipcRenderer.invoke('sessions:list'),
  deleteSession: (sessionPath) => ipcRenderer.invoke('sessions:delete', sessionPath),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),

  onRpcEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('rpc-event', listener);
    return () => ipcRenderer.removeListener('rpc-event', listener);
  },
  onSessionsChanged: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('sessions-changed', listener);
    return () => ipcRenderer.removeListener('sessions-changed', listener);
  },
  installAgent: () => ipcRenderer.invoke('agent:install'),

  hudPrompt: (text) => ipcRenderer.invoke('hud:prompt', text),
  hudHide: () => ipcRenderer.invoke('hud:hide'),
  onHudOpened: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('hud-opened', listener);
    return () => ipcRenderer.removeListener('hud-opened', listener);
  },

  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  writePrefs: (patch) => ipcRenderer.invoke('prefs:write', patch),
  listDir: (p) => ipcRenderer.invoke('fs:list-dir', p),
  readFile: (p, maxBytes) => ipcRenderer.invoke('fs:read-file', { path: p, maxBytes }),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  sessionTail: (p, max) => ipcRenderer.invoke('sessions:tail', { path: p, max }),

  xaiStatus: () => ipcRenderer.invoke('xai:status'),
  xaiConnect: () => ipcRenderer.invoke('xai:connect'),
  xaiDisconnect: () => ipcRenderer.invoke('xai:disconnect'),
  onXaiDeviceCode: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('xai-device-code', listener);
    return () => ipcRenderer.removeListener('xai-device-code', listener);
  },

  readConfig: () => ipcRenderer.invoke('config:read'),
  writeSettings: (patch) => ipcRenderer.invoke('config:write-settings', patch),
  writeModels: (modelsJson) => ipcRenderer.invoke('config:write-models', modelsJson),
  setApiKey: (provider, key) => ipcRenderer.invoke('config:set-api-key', { provider, key }),
  deleteApiKey: (provider) => ipcRenderer.invoke('config:delete-api-key', { provider }),
  onInstallProgress: (cb) => {
    const listener = (_e, line) => cb(line);
    ipcRenderer.on('agent-install-progress', listener);
    return () => ipcRenderer.removeListener('agent-install-progress', listener);
  },
  onMenuAction: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('menu-action', listener);
    return () => ipcRenderer.removeListener('menu-action', listener);
  },
  onFlushWait: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('rpc-flush-wait', listener);
    return () => ipcRenderer.removeListener('rpc-flush-wait', listener);
  },
  onRpcError: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('rpc-error', listener);
    return () => ipcRenderer.removeListener('rpc-error', listener);
  },
  onRpcExit: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('rpc-exit', listener);
    return () => ipcRenderer.removeListener('rpc-exit', listener);
  },
});
