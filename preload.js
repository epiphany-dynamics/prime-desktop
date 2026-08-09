// Narrow bridge between sandboxed renderers and the main process.
"use strict";
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
function filePaths(files) {
  return [...(files || [])].slice(0, 20).map((file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  }).filter(Boolean);
}

contextBridge.exposeInMainWorld('prime', {
  command: (key, cmd) => ipcRenderer.invoke('rpc:command', { key, cmd }),
  automationCommand: (key, cmd) => ipcRenderer.invoke('automation:command', { key, cmd }),
  activate: (options) => ipcRenderer.invoke('rpc:activate', options || {}),
  listClients: () => ipcRenderer.invoke('rpc:list-clients'),
  touchClient: (key) => ipcRenderer.invoke('rpc:touch-client', { key }),
  releasePane: (key, paneId) => ipcRenderer.invoke('pane:release', { key, paneId }),

  listSessions: () => ipcRenderer.invoke('sessions:list'),
  deleteSession: (sessionPath) => ipcRenderer.invoke('sessions:delete', sessionPath),
  sessionTail: (sessionPath, max) => ipcRenderer.invoke('sessions:tail', { path: sessionPath, max }),

  getWorkspace: (key, paneId) => ipcRenderer.invoke('workspace:get', { key, paneId }),
  pickWorkspace: (key, paneId) => ipcRenderer.invoke('workspace:pick', { key, paneId }),
  activateWorkspace: (key, paneId, choiceId) => ipcRenderer.invoke('workspace:activate', { key, paneId, choiceId }),
  listWorkspaceDirectory: (key, paneId, request) => ipcRenderer.invoke('workspace:list-dir', { key, paneId, request }),
  searchWorkspace: (key, paneId, request) => ipcRenderer.invoke('workspace:search', { key, paneId, request }),
  readWorkspaceFile: (key, paneId, nodeId, maxBytes) => ipcRenderer.invoke('workspace:read-file', { key, paneId, nodeId, maxBytes }),
  refreshWorkspace: (key, paneId) => ipcRenderer.invoke('workspace:refresh', { key, paneId }),
  showWorkspaceContextMenu: (key, paneId, nodeId) => ipcRenderer.invoke('workspace:context-menu', { key, paneId, nodeId }),

  getAttachments: (key, paneId) => ipcRenderer.invoke('attachments:get', { key, paneId }),
  pickAttachments: (key, paneId, draftId) => ipcRenderer.invoke('attachments:pick', { key, paneId, draftId }),
  dropAttachments: (key, paneId, draftId, files) => ipcRenderer.invoke('attachments:drop', { key, paneId, draftId, paths: filePaths(files) }),
  pasteImage: (key, paneId, draftId, bytes, name) => ipcRenderer.invoke('attachments:paste-image', { key, paneId, draftId, bytes, name }),
  addTreeAttachment: (key, paneId, draftId, nodeId) => ipcRenderer.invoke('attachments:add-tree-node', { key, paneId, draftId, nodeId }),
  addSessionAttachment: (key, paneId, draftId, sessionPath, name) => ipcRenderer.invoke('attachments:add-session', { key, paneId, draftId, sessionPath, name }),
  removeAttachment: (key, paneId, draftId, attachmentId) => ipcRenderer.invoke('attachments:remove', { key, paneId, draftId, attachmentId }),
  sendChat: (key, paneId, draftId, text, behavior) => ipcRenderer.invoke('chat:send', { key, paneId, draftId, text, behavior }),

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

  listSkills: () => ipcRenderer.invoke('skills:list'),
  readSkill: (id) => ipcRenderer.invoke('skills:read', id),
  toggleSkill: (id, enable) => ipcRenderer.invoke('skills:toggle', { id, enable }),
  addSkillFromFolder: () => ipcRenderer.invoke('skills:add-from-folder'),
  installAgent: () => ipcRenderer.invoke('agent:install'),
  killAllAgents: () => ipcRenderer.invoke('agent:kill-all'),
  popOut: (sessionPath) => ipcRenderer.invoke('window:pop-out', sessionPath),
  getSecurityEvents: () => ipcRenderer.invoke('security:get-events'),

  hudPrompt: (payload) => ipcRenderer.invoke('hud:prompt', payload),
  hudAbort: () => ipcRenderer.invoke('hud:abort'),
  hudOpenSession: () => ipcRenderer.invoke('hud:open-session'),
  hudHide: () => ipcRenderer.invoke('hud:hide'),

  onRpcEvent: (callback) => on('rpc-event', callback),
  onSessionsChanged: (callback) => on('sessions-changed', callback),
  onRpcExit: (callback) => on('rpc-exit', callback),
  onRpcError: (callback) => on('rpc-error', callback),
  onFlushWait: (callback) => on('rpc-flush-wait', callback),
  onMenuAction: (callback) => on('menu-action', callback),
  onInstallProgress: (callback) => on('agent-install-progress', callback),
  onXaiDeviceCode: (callback) => on('xai-device-code', callback),
  onHudOpened: (callback) => on('hud-opened', callback),
  onHudEvent: (callback) => on('hud-event', callback),
  onWorkspaceInvalidated: (callback) => on('workspace-invalidated', callback),
  onWorkspaceChanged: (callback) => on('workspace-changed', callback),
  onAttachmentsReset: (callback) => on('attachments-reset', callback),
});
