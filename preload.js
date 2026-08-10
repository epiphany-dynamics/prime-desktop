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

const MAX_PASTE_IMAGE_BYTES = 20_000_000;
function pasteImage(key, paneId, bindingEpoch, draftId, bytes, name) {
  const supportedBytes = bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes);
  const byteLength = supportedBytes && Number.isSafeInteger(bytes.byteLength) ? bytes.byteLength : -1;
  if (byteLength < 1 || byteLength > MAX_PASTE_IMAGE_BYTES) {
    const tooLarge = byteLength > MAX_PASTE_IMAGE_BYTES;
    return Promise.resolve({ ok: false, code: tooLarge ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE', error: tooLarge ? 'Images must be 20 MB or smaller' : 'The pasted image could not be read' });
  }
  if (typeof name !== 'string' || !name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
    return Promise.resolve({ ok: false, code: 'INVALID_IMAGE', error: 'The pasted image name is invalid' });
  }
  return ipcRenderer.invoke('attachments:paste-image', { key, paneId, bindingEpoch, draftId, bytes, name });
}

contextBridge.exposeInMainWorld('prime', {
  command: (key, cmd) => ipcRenderer.invoke('rpc:command', { key, cmd }),
  automationCommand: (key, cmd) => ipcRenderer.invoke('automation:command', { key, cmd }),
  activate: (options) => ipcRenderer.invoke('rpc:activate', options || {}),
  listClients: () => ipcRenderer.invoke('rpc:list-clients'),
  touchClient: (key) => ipcRenderer.invoke('rpc:touch-client', { key }),
  releasePane: (key, paneId, bindingEpoch) => ipcRenderer.invoke('pane:release', { key, paneId, bindingEpoch }),

  listSessions: () => ipcRenderer.invoke('sessions:list'),
  deleteSession: (sessionPath) => ipcRenderer.invoke('sessions:delete', sessionPath),
  sessionTail: (sessionPath, max) => ipcRenderer.invoke('sessions:tail', { path: sessionPath, max }),

  getWorkspace: (key, paneId, bindingEpoch) => ipcRenderer.invoke('workspace:get', { key, paneId, bindingEpoch }),
  pickWorkspace: (key, paneId, bindingEpoch) => ipcRenderer.invoke('workspace:pick', { key, paneId, bindingEpoch }),
  activateWorkspace: (key, paneId, bindingEpoch, choiceId) => ipcRenderer.invoke('workspace:activate', { key, paneId, bindingEpoch, choiceId }),
  listWorkspaceDirectory: (key, paneId, bindingEpoch, request) => ipcRenderer.invoke('workspace:list-dir', { key, paneId, bindingEpoch, request }),
  searchWorkspace: (key, paneId, bindingEpoch, request) => ipcRenderer.invoke('workspace:search', { key, paneId, bindingEpoch, request }),
  readWorkspaceFile: (key, paneId, bindingEpoch, nodeId, maxBytes) => ipcRenderer.invoke('workspace:read-file', { key, paneId, bindingEpoch, nodeId, maxBytes }),
  refreshWorkspace: (key, paneId, bindingEpoch) => ipcRenderer.invoke('workspace:refresh', { key, paneId, bindingEpoch }),
  showWorkspaceContextMenu: (key, paneId, bindingEpoch, nodeId) => ipcRenderer.invoke('workspace:context-menu', { key, paneId, bindingEpoch, nodeId }),

  getAttachments: (key, paneId, bindingEpoch) => ipcRenderer.invoke('attachments:get', { key, paneId, bindingEpoch }),
  pickAttachments: (key, paneId, bindingEpoch, draftId) => ipcRenderer.invoke('attachments:pick', { key, paneId, bindingEpoch, draftId }),
  dropAttachments: (key, paneId, bindingEpoch, draftId, files) => ipcRenderer.invoke('attachments:drop', { key, paneId, bindingEpoch, draftId, paths: filePaths(files) }),
  pasteImage,
  addTreeAttachment: (key, paneId, bindingEpoch, draftId, nodeId) => ipcRenderer.invoke('attachments:add-tree-node', { key, paneId, bindingEpoch, draftId, nodeId }),
  addSessionAttachment: (key, paneId, bindingEpoch, draftId, sessionPath, name) => ipcRenderer.invoke('attachments:add-session', { key, paneId, bindingEpoch, draftId, sessionPath, name }),
  removeAttachment: (key, paneId, bindingEpoch, draftId, attachmentId) => ipcRenderer.invoke('attachments:remove', { key, paneId, bindingEpoch, draftId, attachmentId }),
  sendChat: (key, paneId, bindingEpoch, draftId, text, behavior) => ipcRenderer.invoke('chat:send', { key, paneId, bindingEpoch, draftId, text, behavior }),

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
  killAllAgents: (options) => ipcRenderer.invoke('agent:kill-all', options || {}),
  popOut: (sessionPath) => ipcRenderer.invoke('window:pop-out', sessionPath),
  getSecurityEvents: () => ipcRenderer.invoke('security:get-events'),

  hudPrompt: (payload) => ipcRenderer.invoke('hud:prompt', payload),
  hudAbort: () => ipcRenderer.invoke('hud:abort'),
  hudOpenSession: () => ipcRenderer.invoke('hud:open-session'),
  hudHide: () => ipcRenderer.invoke('hud:hide'),
  toggleHud: () => ipcRenderer.invoke('hud:toggle'),
  setSplitAvailable: (available) => ipcRenderer.invoke('window:set-split-available', { available: available === true }),
  testWindowState: () => ipcRenderer.invoke('test:window-state'),

  onRpcEvent: (callback) => on('rpc-event', callback),
  onSessionsChanged: (callback) => on('sessions-changed', callback),
  onRpcExit: (callback) => on('rpc-exit', callback),
  onRpcError: (callback) => on('rpc-error', callback),
  onMenuAction: (callback) => on('menu-action', callback),
  onInstallProgress: (callback) => on('agent-install-progress', callback),
  onXaiDeviceCode: (callback) => on('xai-device-code', callback),
  onHudOpened: (callback) => on('hud-opened', callback),
  onHudShortcutStatus: (callback) => on('hud-shortcut-status', callback),
  onHudEvent: (callback) => on('hud-event', callback),
  onWorkspaceInvalidated: (callback) => on('workspace-invalidated', callback),
  onWorkspaceChanged: (callback) => on('workspace-changed', callback),
  onAttachmentsReset: (callback) => on('attachments-reset', callback),
});
