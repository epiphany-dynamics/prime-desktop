// Bridge between sandboxed renderers and the main process.
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('prime', {
  // Keyed RPC: every command is routed to the client (agent process) for a pane
  command: (key, cmd) => ipcRenderer.invoke('rpc:command', { key, cmd }),
  activate: (opts) => ipcRenderer.invoke('rpc:activate', opts),
  listClients: () => ipcRenderer.invoke('rpc:list-clients'),
  touchClient: (key) => ipcRenderer.invoke('rpc:touch-client', key),

  listSessions: () => ipcRenderer.invoke('sessions:list'),
  deleteSession: (p) => ipcRenderer.invoke('sessions:delete', p),
  sessionTail: (p, max) => ipcRenderer.invoke('sessions:tail', { path: p, max }),

  gitInfo: (dir) => ipcRenderer.invoke('git:info', dir),

  readConfig: () => ipcRenderer.invoke('config:read'),
  writeSettings: (patch) => ipcRenderer.invoke('config:write-settings', patch),
  writeModels: (modelsJson) => ipcRenderer.invoke('config:write-models', modelsJson),
  setApiKey: (provider, key) => ipcRenderer.invoke('config:set-api-key', { provider, key }),
  deleteApiKey: (provider) => ipcRenderer.invoke('config:delete-api-key', { provider }),

  xaiStatus: () => ipcRenderer.invoke('xai:status'),
  xaiConnect: () => ipcRenderer.invoke('xai:connect'),
  xaiDisconnect: () => ipcRenderer.invoke('xai:disconnect'),

  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  writePrefs: (patch) => ipcRenderer.invoke('prefs:write', patch),

  listDir: (p) => ipcRenderer.invoke('fs:list-dir', p),
  readFile: (p, maxBytes) => ipcRenderer.invoke('fs:read-file', { path: p, maxBytes }),
  searchFiles: (root, query, limit) => ipcRenderer.invoke('fs:search', { root, query, limit }),
  pickAttachments: () => ipcRenderer.invoke('dialog:pick-attachments'),

  listSkills: () => ipcRenderer.invoke('skills:list'),
  toggleSkill: (dir, enable) => ipcRenderer.invoke('skills:toggle', { dir, enable }),
  addSkillFromFolder: () => ipcRenderer.invoke('skills:add-from-folder'),

  installAgent: () => ipcRenderer.invoke('agent:install'),
  killAllAgents: () => ipcRenderer.invoke('agent:kill-all'),

  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  popOut: (sessionPath) => ipcRenderer.invoke('window:pop-out', sessionPath),

  hudPrompt: (payload) => ipcRenderer.invoke('hud:prompt', payload),
  hudAbort: () => ipcRenderer.invoke('hud:abort'),
  hudOpenSession: () => ipcRenderer.invoke('hud:open-session'),
  hudHide: () => ipcRenderer.invoke('hud:hide'),

  onRpcEvent: (cb) => on('rpc-event', cb),
  onSessionsChanged: (cb) => on('sessions-changed', cb),
  onRpcExit: (cb) => on('rpc-exit', cb),
  onRpcError: (cb) => on('rpc-error', cb),
  onFlushWait: (cb) => on('rpc-flush-wait', cb),
  onKeyMapped: (cb) => on('rpc-key-mapped', cb),
  onMenuAction: (cb) => on('menu-action', cb),
  onInstallProgress: (cb) => on('agent-install-progress', cb),
  onXaiDeviceCode: (cb) => on('xai-device-code', cb),
  onHudOpened: (cb) => on('hud-opened', cb),
  onHudEvent: (cb) => on('hud-event', cb),
});
