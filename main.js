// Prime Desktop - Electron main process
// v0.6 multi-session architecture with pane-scoped workspaces and drafts.
"use strict";
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen, globalShortcut, nativeImage, clipboard } = require('electron');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const { primeDaemonLaunchConfig } = require('./daemon-launch');
const { RpcManager, canonicalDirectory } = require('./lib/rpc-manager');
const { DaemonRpcAdapter, NoResidentSessionError, findPrimeAgentModuleEntry, listResidentDaemonSessions, discoverResidentSession } = require('./lib/daemon-rpc-adapter');
const { WorkspaceService, activateWorkspaceForClient, isWithin } = require('./lib/workspace-service');
const { AttachmentService, AttachmentError, sniffImageMime, parseFileTransport } = require('./lib/attachment-service');
const { canonicalSessionPath, validateSessionHeader, safeDeleteSession, cleanupTrackedEmptySessions, countSessionMessages } = require('./lib/session-utils');
const {
  listSubagentsForParent,
  mergeAgentLists,
  normalizeLiveChild,
  canonicalPrimeSessionPath,
} = require('./lib/subagent-roster');
const { createSessionIndex } = require('./lib/session-index');
const { tryAcquireFlag } = require('./lib/inflight-lock');
const { classifyNavigation } = require('./lib/navigation-policy');
const { SessionLifecycleRegistry } = require('./lib/session-lifecycle');
const { createElectronImageNormalizer } = require('./lib/electron-image-normalizer');
const { providerEntryPreservingSecret } = require('./lib/config-secrets');

const TEST_MODE = !app.isPackaged && process.env.PRIME_DESKTOP_TEST_MODE === '1';
const HOME_INPUT = TEST_MODE && process.env.PRIME_DESKTOP_TEST_HOME ? path.resolve(process.env.PRIME_DESKTOP_TEST_HOME) : os.homedir();
if (TEST_MODE) fs.mkdirSync(HOME_INPUT, { recursive: true });
const HOME = fs.realpathSync(HOME_INPUT);
if (TEST_MODE) app.setPath('userData', path.join(HOME, '.prime-desktop-test-user-data'));
const SESSIONS_DIR = path.join(HOME, '.prime', 'agent', 'sessions');
const PRIME_AGENT_DIR = path.join(HOME, '.prime', 'agent');
const ARTIFACTS_DIR = path.join(PRIME_AGENT_DIR, 'session-artifacts');
const COMMAND_TIMEOUT_MS = 30000;
const MAX_CLIENTS = 8;
const MAX_IPC_JSON_BYTES = 2 * 1024 * 1024;
const WORKSPACE_STATE_PATH = path.join(app.getPath('userData'), 'workspaces.json');
const DAEMON_LAUNCH = primeDaemonLaunchConfig();
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
const sessionIndex = createSessionIndex({
  sessionsRoot: SESSIONS_DIR,
  canonicalSessionPath: (root, candidate) => canonicalSessionPath(root, candidate),
});


// ---------- Agent binary resolution ----------

function loginShellPath() {
  try { return execSync('/bin/zsh -lic \'echo $PATH\'', { timeout: 4000, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function buildChildEnv() {
  const extra = [path.join(HOME, '.hermes', 'node', 'bin'), path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  if (TEST_MODE) {
    const current = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    return {
      HOME,
      USER: 'prime-desktop-test',
      LOGNAME: 'prime-desktop-test',
      PATH: [...extra, ...current.split(':')].filter(Boolean).join(':'),
      SHELL: '/bin/zsh',
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      PRIME_DESKTOP_TEST_HOME: HOME,
    };
  }
  const env = { ...process.env };
  const current = (env.PATH && env.PATH.length > 10 ? env.PATH : loginShellPath()) || '/usr/bin:/bin:/usr/sbin:/sbin';
  env.PATH = [...extra, ...current.split(':')].filter(Boolean).join(':');
  if (!env.SHELL) env.SHELL = '/bin/zsh';
  env.TMPDIR = DAEMON_LAUNCH.tempDir;
  return env;
}

function findNode(childEnv) {
  const candidates = [
    path.join(HOME, '.hermes', 'node', 'bin', 'node'),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    process.execPath,
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return execSync('which node', { env: childEnv, encoding: 'utf8' }).trim(); }
  catch { return 'node'; }
}

function resolveAgentInvocation(childEnv) {
  if (TEST_MODE && process.env.PRIME_DESKTOP_AGENT_SCRIPT) {
    return { command: findNode(childEnv), args: [path.resolve(process.env.PRIME_DESKTOP_AGENT_SCRIPT)], display: 'offline fixture' };
  }
  const binCandidates = [
    path.join(HOME, '.local', 'bin', 'prime-agent'),
    path.join(HOME, '.local', 'lib', 'node_modules', 'prime-agent', 'dist', 'bundle', 'cli.js'),
    path.join(HOME, '.hermes', 'node', 'bin', 'prime-agent'),
    '/usr/local/bin/prime-agent',
    '/opt/homebrew/bin/prime-agent',
  ];
  let found = null;
  for (const c of binCandidates) if (fs.existsSync(c)) { found = c; break; }
  if (!found) {
    try { found = execSync('which prime-agent', { env: childEnv, encoding: 'utf8' }).trim(); }
    catch { found = null; }
  }
  if (!found) return null;
  const node = findNode(childEnv);
  try {
    const real = fs.realpathSync(found);
    if (/\.(js|mjs|cjs)$/.test(real)) return { command: node, args: [real], display: real };
  } catch {}
  return { command: found, args: [], display: found };
}

// ---------- Multi-client agent connections ----------
// One process-backed RPC manager or non-owning daemon adapter per canonical
// session, shared by panes and routed through opaque main-issued contexts.

const clients = new Map();
const sessionLifecycle = new SessionLifecycleRegistry();
const paneContexts = new Map();
const createdSessionFiles = new Set();
const securityEvents = [];
let tempSeq = 0;
let paneTransitionTail = Promise.resolve();

function boundedText(value, cap = 8_192) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, cap);
}
function publicError(error, fallback = 'That action could not be completed') {
  if (error instanceof AttachmentError) return { ok: false, code: error.code, error: error.message };
  const message = error && error.message;
  return { ok: false, error: typeof message === 'string' && message.length < 500 && !message.includes(HOME) ? message : fallback };
}
function assertSmallDto(value, cap = MAX_IPC_JSON_BYTES) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new Error('Invalid request'); }
  if (Buffer.byteLength(encoded || '', 'utf8') > cap) throw new Error('Request is too large');
}
function isTrustedIpc(event) {
  if (!event || !event.sender || !event.senderFrame) return false;
  const owner = BrowserWindow.fromWebContents(event.sender);
  return !!owner && event.senderFrame === event.sender.mainFrame;
}
function secureHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedIpc(event)) throw new Error('Untrusted IPC sender');
    return handler(event, ...args);
  });
}
function rememberSecurityEvent(type, target) {
  securityEvents.push({ type, target: boundedText(target, 300), at: Date.now() });
  if (securityEvents.length > 50) securityEvents.shift();
}
function sendToWindow(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function sendToClientWindows(client, channel, payload) {
  for (const win of client.viewers || []) sendToWindow(win, channel, payload);
}
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) sendToWindow(win, channel, payload);
}
function clientIsCurrent(client) {
  return !!client && client.committed && clients.get(client.key) === client;
}
function clientCommand(client, command, timeoutMs) {
  if (!client || !client.alive) return Promise.reject(new Error('Agent connection is not running'));
  return client.rpc.command(command, timeoutMs ? { timeoutMs } : {});
}
function getClient(key) { return typeof key === 'string' ? clients.get(key) : null; }

function refreshClientViewers(client) {
  if (!client) return;
  const viewers = new Set();
  for (const context of paneContexts.values()) if (context.client === client && context.ownerWin && !context.ownerWin.isDestroyed()) viewers.add(context.ownerWin);
  client.viewers = viewers;
}
function clientHasPaneConsumer(client) {
  return [...paneContexts.values()].some((context) => context.client === client);
}
function hudConsumesClient(client) {
  return hudClient === client && hudWin && !hudWin.isDestroyed() && (hudWin.isVisible() || hudOpenPending);
}
async function releaseUnreferencedDaemonClient(client, reason) {
  if (!client || client.transport !== 'daemon-attachment' || clientHasPaneConsumer(client) || hudConsumesClient(client)) return;
  try { await disposeClient(client, reason); }
  catch (error) { console.warn('PRIME_DAEMON_DETACH_FAILED', boundedText(error && error.message, 300)); }
}
function trackCreatedSession(sessionPath) {
  if (typeof sessionPath === 'string') createdSessionFiles.add(sessionPath);
}
function handleClientMessage(client, obj) {
  if (!clientIsCurrent(client)) return;
  if (obj.type === 'agent_start') client.streaming = true;
  if (obj.type === 'session_resynced' && obj.state) client.streaming = !!obj.state.isStreaming;
  if (obj.type === 'agent_end') {
    client.streaming = false;
    if (client.workspace) client.workspace.refresh('agent');
  }
  sendToClientWindows(client, 'rpc-event', { key: client.key, event: obj });
  const assistantEvent = (obj.type === 'message_update' || obj.type === 'message_end') && (!obj.message || obj.message.role === 'assistant');
  const errorEvent = obj.type === 'error' || (obj.type === 'message_update' && obj.assistantMessageEvent && obj.assistantMessageEvent.type === 'error');
  if (assistantEvent || errorEvent || obj.type === 'agent_end') sendHudEvent(client, obj);
}

function createWorkspaceService(client) {
  return new WorkspaceService({
    homeDir: HOME,
    statePath: WORKSPACE_STATE_PATH,
    onInvalidated: (payload) => {
      if (clientIsCurrent(client)) sendToClientWindows(client, 'workspace-invalidated', { key: client.key, ...payload });
    },
  });
}

async function disposeClient(client, reason = 'shutdown', remove = true, options = {}) {
  if (!client) return;
  if (client.disposePromise) return client.disposePromise;
  client.committed = false;
  client.alive = false;
  if (client.workspace) client.workspace.dispose();
  const sessionKey = client.sessionFile || (typeof client.key === 'string' && !client.key.startsWith('new:') ? client.key : null);
  // App quit / UI detach must not kill live workers. Daemon adapters already
  // detach-only; process RPC children are left running so they stay persistent.
  const detachOnly = options.detachOnly === true || reason === 'app-quit' || reason === 'detach' || reason === 'last desktop window released' || reason === 'last desktop pane switched sessions' || reason === 'last desktop pane released' || reason === 'Prime HUD closed' || reason === 'Prime HUD hidden';
  const stopOptions = detachOnly ? { killProcess: false } : {};
  const stopping = (async () => {
    try {
      if (typeof client.rpc.stop === 'function') await client.rpc.stop(detachOnly ? 'app-quit' : reason, stopOptions);
    } finally {
      if (remove) for (const [key, value] of clients) if (value === client) clients.delete(key);
    }
  })();
  client.disposePromise = sessionKey ? sessionLifecycle.trackDisposal(sessionKey, stopping) : stopping;
  return client.disposePromise;
}

async function evictIdleClients() {
  while (clients.size > MAX_CLIENTS) {
    const referenced = new Set([...paneContexts.values()].map((context) => context.client));
    const candidate = [...new Set(clients.values())]
      .filter((client) => !client.streaming && !referenced.has(client))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!candidate) return;
    await disposeClient(candidate, 'idle eviction');
  }
}

function createRpcManager(targetCwd) {
  return new RpcManager({
    defaultCwd: targetCwd,
    resolveInvocation: resolveAgentInvocation,
    buildEnv: buildChildEnv,
    extraArgs: ['--daemon-socket', DAEMON_LAUNCH.socketPath],
  });
}

function resolvePrimeAgentModuleEntry() {
  const childEnv = buildChildEnv();
  return findPrimeAgentModuleEntry({
    homeDir: HOME,
    invocation: resolveAgentInvocation(childEnv),
    override: process.env.PRIME_DESKTOP_AGENT_MODULE,
  });
}

function createDaemonAdapter(sessionPath) {
  if (!sessionPath) return null;
  const moduleEntry = resolvePrimeAgentModuleEntry();
  if (!moduleEntry) return null;
  return new DaemonRpcAdapter({ socketPath: DAEMON_LAUNCH.socketPath, sessionPath, moduleEntry });
}

function wireClientRpc(client, rpc) {
  client.rpc = rpc;
  rpc.on('event', (event) => handleClientMessage(client, event));
  // Never mirror provider stderr into the renderer; it can contain paths or credentials.
  rpc.on('stderr', () => {});
  rpc.on('error-event', (payload) => {
    if (clientIsCurrent(client)) sendToClientWindows(client, 'rpc-error', { key: client.key, message: boundedText(payload.message, 500) });
  });
  rpc.on('exit', (payload) => {
    if (!clientIsCurrent(client)) return;
    client.alive = false;
    sendToClientWindows(client, 'rpc-exit', { key: client.key, code: payload.code, error: payload.error });
    sendHudEvent(client, { type: 'error', error: payload.error || `Agent connection closed (${payload.code})` });
  });
}

async function spawnClient({ sessionPath = null, cwd, ownerWin, inspectedWorkspace = null }) {
  const targetCwd = canonicalDirectory(cwd || HOME);
  const temporaryKey = `new:${++tempSeq}`;
  let rpc = createDaemonAdapter(sessionPath) || createRpcManager(targetCwd);
  const client = {
    key: temporaryKey,
    rpc,
    transport: rpc instanceof DaemonRpcAdapter ? 'daemon-attachment' : 'rpc-process',
    sessionFile: sessionPath,
    cwd: targetCwd,
    viewers: new Set(ownerWin ? [ownerWin] : []),
    streaming: false,
    lastUsed: Date.now(),
    autoCreated: !sessionPath,
    alive: true,
    committed: false,
    workspace: null,
    workspaceWarning: null,
  };
  wireClientRpc(client, rpc);

  try {
    let ready;
    try {
      await rpc.start({ cwd: targetCwd, sessionPath, reason: 'client activation' });
      ready = await rpc.waitUntilReady();
    } catch (error) {
      if (!(rpc instanceof DaemonRpcAdapter) || !(error instanceof NoResidentSessionError)) throw error;
      // Discovery completed without a matching active worker (or no daemon is
      // running), so this saved session is genuinely inactive and may resume
      // through the existing RPC process path.
      await rpc.stop('inactive daemon fallback').catch(() => {});
      rpc.removeAllListeners();
      rpc = createRpcManager(targetCwd);
      client.transport = 'rpc-process';
      wireClientRpc(client, rpc);
      await rpc.start({ cwd: targetCwd, sessionPath, reason: 'inactive session activation' });
      ready = await rpc.waitUntilReady();
    }
    const reported = ready.data && ready.data.sessionFile;
    if (typeof reported !== 'string') throw new Error('Agent did not report a session file');
    // Allow top-level sessions and nested RLM child transcripts under session-artifacts.
    const canonicalSession = await canonicalPrimeSessionPath(PRIME_AGENT_DIR, reported);
    if (sessionPath && canonicalSession !== sessionPath) throw new Error('Agent resumed a different session than requested');
    client.sessionFile = canonicalSession;
    client.key = canonicalSession;
    client.streaming = !!(ready.data && ready.data.isStreaming);
    client.workspace = createWorkspaceService(client);
    if (targetCwd !== HOME) {
      const activated = await activateWorkspaceForClient(client.workspace, targetCwd, {
        inspected: inspectedWorkspace,
        recordRecent: true,
        // Saved sessions remain usable even when their historical cwd is too
        // broad/private/unwatchable for the Files surface. New/project-picker
        // clients stay transactional and fail instead of silently degrading.
        degradeOnFailure: !!sessionPath,
      });
      client.workspaceWarning = activated.warning;
    } else client.workspace.clear('home-session');
    const collision = clients.get(client.key);
    if (collision && collision !== client && collision.alive) {
      await disposeClient(client, 'duplicate session', false);
      return collision;
    }
    client.committed = true;
    clients.set(client.key, client);
    if (client.autoCreated) trackCreatedSession(client.sessionFile);
    await evictIdleClients();
    return client;
  } catch (error) {
    if (client.workspace) client.workspace.dispose();
    await rpc.stop('failed activation').catch(() => {});
    throw error;
  }
}

async function ensureClient({ sessionPath = null, cwd, ownerWin, inspectedWorkspace = null }) {
  const activate = async () => {
    if (sessionPath) await sessionLifecycle.waitForDisposal(sessionPath);
    const existing = sessionPath && getClient(sessionPath);
    if (existing && existing.alive && !existing.disposePromise) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing) await disposeClient(existing, 'dead client replacement');
    if (sessionPath) await sessionLifecycle.waitForDisposal(sessionPath);
    return spawnClient({ sessionPath, cwd, ownerWin, inspectedWorkspace });
  };
  return sessionPath ? sessionLifecycle.run(sessionPath, activate) : activate();
}

function ownerForEvent(event) { return BrowserWindow.fromWebContents(event.sender); }
function paneContextFor(event, request = {}, options = {}) {
  assertSmallDto(request, options.cap || 64 * 1024);
  const context = paneContexts.get(request.paneId);
  const owner = ownerForEvent(event);
  if (!context || context.ownerWin !== owner) throw new Error('This pane is no longer available');
  if (context.lifecycleLocked) throw new Error('This pane is completing a lifecycle change; retry the action');
  if (typeof request.key !== 'string' || !request.key || context.client.key !== request.key) throw new Error('This pane changed sessions; retry the action');
  if (typeof request.bindingEpoch !== 'string' || !request.bindingEpoch || context.bindingEpoch !== request.bindingEpoch) throw new Error('This pane changed sessions; retry the action');
  return context;
}
function bindPane(event, requestedPaneId, client, options = {}) {
  const ownerWin = ownerForEvent(event);
  if (!ownerWin || ownerWin.isDestroyed()) throw new Error('This window is no longer available');
  if (!client || !client.alive || client.disposePromise || !clientIsCurrent(client)) throw new Error('That agent session is no longer available');
  let paneId = typeof requestedPaneId === 'string' && requestedPaneId.length <= 100 ? requestedPaneId : null;
  const previous = paneId && paneContexts.get(paneId);
  if (previous && previous.ownerWin !== ownerWin) throw new Error('This pane is no longer available');
  if (!paneId || !previous) paneId = `pane_${crypto.randomUUID()}`;
  // Build the replacement completely before committing over the prior binding.
  const preserveDraft = !!(options.preserveDraft && previous);
  const workspaceProvider = () => client.workspace.describe();
  const attachmentService = preserveDraft
    ? previous.attachmentService
    : new AttachmentService({ homeDir: HOME, getWorkspace: workspaceProvider, normalizeImage: normalizeImageWithElectron });
  const draft = preserveDraft
    ? attachmentService.rebindDraftWorkspace(previous.draft.id, workspaceProvider)
    : attachmentService.createDraft();
  const context = { id: paneId, bindingEpoch: `binding_${crypto.randomUUID()}`, ownerWin, client, attachmentService, draft, sending: false, pendingActions: 0, lifecycleLocked: false };
  if (previous) {
    if (!preserveDraft) previous.attachmentService.deleteDraft(previous.draft.id);
    paneContexts.delete(paneId);
  }
  paneContexts.set(paneId, context);
  if (previous) refreshClientViewers(previous.client);
  refreshClientViewers(client);
  return context;
}
function describeActivation(context, state, options = {}) {
  return {
    ok: true,
    preservedDraft: !!options.preservedDraft,
    key: context.client.key,
    paneId: context.id,
    bindingEpoch: context.bindingEpoch,
    sessionFile: context.client.sessionFile,
    state,
    workspace: context.client.workspace.describe(),
    warning: context.client.workspaceWarning ? boundedText(context.client.workspaceWarning, 300) : null,
    draft: context.draft,
  };
}
async function stateForClient(client) {
  const response = await clientCommand(client, { type: 'get_state' });
  if (!response.success) throw new Error(response.error || 'Agent state is unavailable');
  client.streaming = !!response.data.isStreaming;
  client.sessionFile = response.data.sessionFile || client.sessionFile;
  return response.data;
}
async function requireIdleClient(client, action) {
  const state = await stateForClient(client);
  if (state.isStreaming) throw new Error(`Stop the current response before ${action}`);
  return state;
}
function assertCurrentPaneContext(context) {
  if (context && paneContexts.get(context.id) !== context) throw new Error('This pane changed sessions; retry the action');
  return context;
}
async function awaitForPane(context, promise) {
  const result = await promise;
  assertCurrentPaneContext(context);
  return result;
}
function reservePaneAction(context) {
  assertCurrentPaneContext(context);
  if (context.sending) throw new Error('Wait for the current message before adding attachments');
  context.pendingActions += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    context.pendingActions = Math.max(0, context.pendingActions - 1);
  };
}
function assertPaneLocallyIdle(context, action) {
  if (!context) return;
  assertCurrentPaneContext(context);
  if (context.sending) throw new Error(`Wait for the current message before ${action}`);
  if (context.pendingActions > 0 || context.attachmentService.pendingMutationCount(context.draft.id) > 0) throw new Error(`Wait for attachments to finish before ${action}`);
}
async function requirePaneProjectIdle(context, action, { allowStreaming = false } = {}) {
  if (!context) return null;
  assertPaneLocallyIdle(context, action);
  let state = { isStreaming: false };
  if (context.client.alive && !context.client.disposePromise && clientIsCurrent(context.client)) {
    // Session navigation can leave a live response running in the background
    // (Hermes model). Project changes / destructive actions still require idle.
    if (allowStreaming) state = await stateForClient(context.client);
    else state = await requireIdleClient(context.client, action);
  }
  assertPaneLocallyIdle(context, action);
  return state;
}
function runPaneTransition(task) {
  const run = paneTransitionTail.then(task, task);
  paneTransitionTail = run.catch(() => {});
  return run;
}

const GENERIC_RPC_COMMANDS = new Set([
  'get_messages', 'get_state', 'get_session_stats', 'get_tree', 'get_branch', 'navigate_tree',
  'list_agents', 'get_active_subagents', 'get_commands', 'get_available_models', 'set_model',
  'set_thinking_level', 'set_service_tier', 'set_streaming_behavior', 'set_follow_up_mode',
  'set_retry_settings', 'set_compaction_settings', 'set_session_name', 'abort', 'abort_retry',
  'abort_compaction', 'abort_branch_summary', 'reload', 'compact', 'extension_ui_response',
]);
const AUTOMATION_RPC_COMMANDS = new Set([
  'list_schedules', 'add_schedule', 'cancel_schedule', 'list_heartbeats', 'manage_heartbeat',
]);

secureHandle('rpc:command', async (_event, request) => {
  try {
    assertSmallDto(request);
    if (!request || typeof request.key !== 'string' || !request.cmd || !GENERIC_RPC_COMMANDS.has(request.cmd.type)) {
      throw new Error('Use the dedicated chat or session action for that command');
    }
    if (Object.prototype.hasOwnProperty.call(request.cmd, 'images')) throw new Error('Image data must use the attachment service');
    const client = getClient(request.key);
    if (!client) throw new Error('No agent is attached to this pane');
    client.lastUsed = Date.now();
    return await clientCommand(client, { ...request.cmd });
  } catch (error) { return { type: 'response', success: false, error: publicError(error).error }; }
});

secureHandle('automation:command', async (_event, request) => {
  try {
    assertSmallDto(request, 128 * 1024);
    if (!request || typeof request.key !== 'string' || !request.cmd || !AUTOMATION_RPC_COMMANDS.has(request.cmd.type)) {
      throw new Error('Unsupported automation action');
    }
    const client = getClient(request.key);
    if (!client) throw new Error('No agent is attached to this pane');
    return await clientCommand(client, { ...request.cmd });
  } catch (error) { return { type: 'response', success: false, error: publicError(error).error }; }
});

secureHandle('rpc:activate', async (event, request = {}) => {
  try {
    return await runPaneTransition(async () => {
      assertSmallDto(request, 32 * 1024);
      const ownerWin = ownerForEvent(event);
      const currentContext = request.paneId && paneContexts.get(request.paneId);
      let priorContext = null;
      let sourceContext = null;
      if (currentContext) {
        if (request.sourcePaneId != null || request.sourceBindingEpoch != null) throw new Error('Invalid split source');
        priorContext = paneContextFor(event, { paneId: request.paneId, key: request.sourceKey, bindingEpoch: request.bindingEpoch }, { cap: 8 * 1024 });
      } else if (request.sourcePaneId != null) {
        if (request.bindingEpoch != null) throw new Error('Invalid split source');
        sourceContext = paneContextFor(event, {
          paneId: request.sourcePaneId,
          key: request.sourceKey,
          bindingEpoch: request.sourceBindingEpoch,
        }, { cap: 8 * 1024 });
      } else if (request.sourceKey != null || request.bindingEpoch != null || request.sourceBindingEpoch != null) {
        throw new Error('The pane binding changed before this action completed');
      }
      // In-place session / New Chat navigation may leave a streaming agent.
      // Split is explicit-only; never forced by this path.
      const allowStreamingLeave = request.allowStreamingLeave !== false;
      await requirePaneProjectIdle(priorContext, 'changing sessions', { allowStreaming: allowStreamingLeave });
      let sessionPath = null;
      let targetCwd = HOME;
      let client = null;
      let clientWasExisting = false;
      let bound = false;
      try {
        if (request.sessionPath) {
          // Top-level sessions and nested RLM sub-agent transcripts under session-artifacts.
          const allowedPath = await canonicalPrimeSessionPath(PRIME_AGENT_DIR, request.sessionPath);
          let verified = null;
          try {
            // Fast path for normal top-level sessions in ~/.prime/agent/sessions.
            verified = await validateSessionHeader(SESSIONS_DIR, allowedPath);
          } catch {
            const headerLine = (await fsp.readFile(allowedPath, 'utf8')).split('\n').find((line) => line && line[0] === '{');
            const header = headerLine ? JSON.parse(headerLine) : null;
            if (!header || header.type !== 'session' || typeof header.id !== 'string') throw new Error('Session header is invalid');
            if (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) throw new Error('Session project folder is invalid');
            let cwd = header.cwd;
            try {
              cwd = await fsp.realpath(header.cwd);
              if (!(await fsp.stat(cwd)).isDirectory()) throw new Error('missing');
            } catch { throw new Error('The project folder for this session is no longer available'); }
            verified = { sessionPath: allowedPath, header: { ...header, cwd } };
          }
          sessionPath = verified.sessionPath;
          targetCwd = verified.header.cwd;
        } else {
          const sourceClient = priorContext ? priorContext.client : sourceContext ? sourceContext.client : null;
          if (sourceClient) targetCwd = sourceClient.cwd;
        }
        const existingBefore = new Set(clients.values());
        client = await ensureClient({ sessionPath, cwd: targetCwd, ownerWin });
        clientWasExisting = existingBefore.has(client);
        // Only re-check local pane locks; do not pay another get_state round-trip here.
        if (priorContext) assertPaneLocallyIdle(priorContext, 'changing sessions');
        const state = await stateForClient(client);
        const preserveDraft = !!(priorContext && priorContext.client.sessionFile === client.sessionFile);
        const context = bindPane(event, request.paneId, client, { preserveDraft });
        bound = true;
        if (priorContext && priorContext.client !== client) {
          // Detach in the background. Waiting here made session clicks feel like 10–20s.
          // Process RPC clients keep running until idle eviction; daemon attachments
          // detach only when no pane/HUD still references them.
          void releaseUnreferencedDaemonClient(priorContext.client, 'last desktop pane switched sessions');
        }
        if (ownerWin) lastFocusedMainWin = ownerWin;
        return describeActivation(context, state, { preservedDraft: preserveDraft });
      } catch (error) {
        if (client && !bound && !clientWasExisting && ![...paneContexts.values()].some((context) => context.client === client)) {
          await disposeClient(client, 'failed session activation rollback').catch(() => {});
        }
        throw error;
      }
    });
  } catch (error) { return publicError(error, 'The session could not be opened'); }
});

secureHandle('rpc:list-clients', async () => [...new Set(clients.values())].map((client) => ({
  key: client.key, sessionFile: client.sessionFile, streaming: client.streaming, alive: client.alive, cwd: client.cwd,
  transport: client.transport,
})));
secureHandle('rpc:touch-client', (event, request) => {
  try {
    assertSmallDto(request, 8 * 1024);
    const client = getClient(request && request.key);
    if (!client) return { ok: false };
    client.lastUsed = Date.now();
    const owner = ownerForEvent(event);
    if (owner) lastFocusedMainWin = owner;
    return { ok: true };
  } catch { return { ok: false }; }
});
secureHandle('pane:release', async (event, request) => {
  try {
    return await runPaneTransition(async () => {
      const context = paneContextFor(event, request, { cap: 8 * 1024 });
      // Closing a split pane is navigation. Streaming may continue in background.
      // Only local send/attachment locks block release (not agent isStreaming).
      assertPaneLocallyIdle(context, 'closing this pane');
      context.attachmentService.deleteDraft(context.draft.id);
      paneContexts.delete(context.id);
      refreshClientViewers(context.client);
      await releaseUnreferencedDaemonClient(context.client, 'last desktop pane released');
      await evictIdleClients();
      return { ok: true };
    });
  } catch (error) { return publicError(error); }
});

// ---------- Empty-session cleanup ----------

async function cleanupAutoCreatedSessions() {
  await cleanupTrackedEmptySessions(SESSIONS_DIR, createdSessionFiles, countSessionMessages);
}

// ---------- Session listing ----------

let residentSessionsCache = { at: 0, value: [] };
async function getResidentSessionsCached(moduleEntry) {
  const now = Date.now();
  if (now - residentSessionsCache.at < 2000 && residentSessionsCache.value) return residentSessionsCache.value;
  const residents = await getResidentSessionsCached(moduleEntry);
  residentSessionsCache = { at: now, value: residents };
  return residents;
}
async function listSessions() {
  // Fast cached index: never slurp multi-MB JSONL files for the sidebar.
  const out = (await sessionIndex.list()).map((entry) => ({ ...entry }));
  const moduleEntry = resolvePrimeAgentModuleEntry();
  if (moduleEntry) {
    try {
      const residents = await getResidentSessionsCached(moduleEntry);
      const byPath = new Map(residents.map((resident) => {
        try { return [fs.realpathSync(resident.sessionFile), resident]; } catch { return [path.resolve(resident.sessionFile), resident]; }
      }));
      for (const session of out) {
        const resident = byPath.get(session.path);
        const localClient = clients.get(session.path);
        if (!resident || (localClient && localClient.alive && localClient.transport === 'rpc-process')) continue;
        session.daemonResident = true;
        session.daemonStreaming = !!resident.isStreaming;
        const attachedClients = Number(resident.attachedClients || 0);
        session.daemonAttachedClients = Number.isSafeInteger(attachedClients) ? Math.max(0, Math.min(attachedClients, 10_000)) : 0;
      }
    } catch (error) {
      console.warn('PRIME_DAEMON_DISCOVERY_FAILED', boundedText(error && error.message, 300));
    }
  }

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

let watchTimer = null;
function watchSessions() {
  try {
    fs.watch(SESSIONS_DIR, (_eventType, filename) => {
      if (filename) sessionIndex.invalidate(filename);
      else sessionIndex.invalidate();
      clearTimeout(watchTimer);
      // Debounce rebuilds; first paint can use cache while rebuild runs.
      watchTimer = setTimeout(async () => broadcast('sessions-changed', await listSessions()), 150);
    });
  } catch {}
}

let artifactWatchTimer = null;
function watchArtifacts() {
  try {
    // Recursive watch so new rlm-subagents.jsonl rows surface quickly.
    fs.watch(ARTIFACTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (filename && !String(filename).includes('rlm-subagents') && !String(filename).includes('sub-')) return;
      clearTimeout(artifactWatchTimer);
      artifactWatchTimer = setTimeout(() => {
        broadcast('agents-changed', { at: Date.now() });
      }, 50);
    });
  } catch {
    // Fallback: poll flag only when recursive watch unsupported.
  }
}


async function listAgentsForFocusedSession(request = {}) {
  const parentSessionPath = request.parentSessionPath || request.sessionPath || null;
  const parentSessionId = request.parentSessionId || null;
  let parentPath = null;
  let parentId = parentSessionId;
  if (parentSessionPath) {
    try { parentPath = await canonicalPrimeSessionPath(PRIME_AGENT_DIR, parentSessionPath); }
    catch {
      try { parentPath = await canonicalSessionPath(SESSIONS_DIR, parentSessionPath); }
      catch { parentPath = null; }
    }
  }
  // Always resolve header.id — filename stem is often a different UUID.
  if (parentPath) {
    try {
      const { readSessionHeaderId } = require('./lib/subagent-roster');
      const headerId = readSessionHeaderId(parentPath);
      if (headerId) parentId = headerId;
    } catch {}
  }

  const fromDisk = listSubagentsForParent(PRIME_AGENT_DIR, {
    parentSessionPath: parentPath,
    parentSessionId: parentId,
  });

  let fromLive = [];
  if (parentPath) {
    const client = clients.get(parentPath);
    if (client && client.alive && client.rpc && typeof client.rpc.command === 'function') {
      try {
        const response = await clientCommand(client, { type: 'list_agents' });
        const data = response && response.success ? response.data : null;
        const raw = data && (data.agents || data.children || data.subagents || data);
        const list = Array.isArray(raw) ? raw : [];
        fromLive = list.map((item) => normalizeLiveChild(item)).filter(Boolean);
      } catch {}
    }
  }

  const agents = mergeAgentLists(fromDisk, fromLive).map((agent) => ({
    id: agent.id,
    childId: agent.childId,
    name: agent.name,
    label: agent.label,
    status: agent.status,
    running: !!agent.running,
    model: agent.model,
    recap: agent.recap ? boundedText(agent.recap, 280) : null,
    prompt: agent.prompt ? boundedText(agent.prompt, 280) : null,
    sessionFile: agent.sessionFile || agent.path || null,
    path: agent.sessionFile || agent.path || null,
    parentSessionFile: agent.parentSessionFile || parentPath,
    rlmDepth: agent.rlmDepth,
    tokenCount: agent.tokenCount,
    toolUseCount: agent.toolUseCount,
    activity: agent.activity || null,
    error: agent.error ? boundedText(agent.error, 200) : null,
    updatedAt: agent.updatedAt,
    source: agent.source,
    kind: 'subagent',
  }));

  return {
    ok: true,
    parentSessionPath: parentPath,
    parentSessionId: parentId,
    agents,
    runningCount: agents.filter((agent) => agent.running).length,
  };
}

secureHandle('agents:list', async (_event, request = {}) => {
  try {
    assertSmallDto(request, 16 * 1024);
    return await listAgentsForFocusedSession(request || {});
  } catch (error) { return publicError(error, 'Could not list agents'); }
});

secureHandle('sessions:list', () => listSessions());
secureHandle('sessions:delete', async (_event, sessionPath) => {
  try {
    const canonical = await canonicalSessionPath(SESSIONS_DIR, sessionPath);
    return await runPaneTransition(() => sessionLifecycle.run(canonical, async () => {
      await sessionLifecycle.waitForDisposal(canonical);
      const attached = [...paneContexts.values()].filter((context) => context.client.sessionFile === canonical);
      for (const context of attached) assertPaneLocallyIdle(context, 'deleting this session');
      const client = clients.get(canonical);
      if (client && client.alive && !client.disposePromise && clientIsCurrent(client)) await requireIdleClient(client, 'deleting this session');
      for (const context of attached) assertPaneLocallyIdle(context, 'deleting this session');
      if (attached.length) throw new Error('Switch or close every pane using this session before deleting it');
      const moduleEntry = resolvePrimeAgentModuleEntry();
      const resident = moduleEntry && await discoverResidentSession({ socketPath: DAEMON_LAUNCH.socketPath, sessionPath: canonical, moduleEntry });
      const soleLocalRpcOwner = !!(resident && client && client.alive && client.transport === 'rpc-process'
        && Number.isSafeInteger(resident.attachedClients) && resident.attachedClients <= 1);
      if ((client && client.transport === 'daemon-attachment') || (resident && !soleLocalRpcOwner)) {
        throw new Error('This session is active in Prime Agent. Stop it there before deleting it.');
      }
      if (client) await disposeClient(client, 'session deletion');
      const stillResident = moduleEntry && await discoverResidentSession({ socketPath: DAEMON_LAUNCH.socketPath, sessionPath: canonical, moduleEntry });
      if (stillResident) throw new Error('This session is still active in Prime Agent. Retry after it stops.');
      await safeDeleteSession(SESSIONS_DIR, canonical);
      return { ok: true };
    }));
  } catch (error) { return publicError(error, 'That session could not be deleted'); }
});
secureHandle('sessions:tail', async (_event, request) => {
  try {
    assertSmallDto(request, 16 * 1024);
    const sessionPath = await canonicalPrimeSessionPath(PRIME_AGENT_DIR, request && request.path);
    const maximum = Math.max(1, Math.min(Number(request.max) || 50, 100));
    const messages = [];
    for (const line of (await fsp.readFile(sessionPath, 'utf8')).split('\n')) {
      if (!line.trim() || line[0] !== '{') continue;
      try {
        const record = JSON.parse(line);
        if (record.type !== 'message') continue;
        const message = record.message || {};
        const raw = typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part) => part.type === 'text' ? part.text : part.type === 'toolCall' ? `[tool: ${part.name}]` : '').filter(Boolean).join('\n')
            : '';
        messages.push({ role: boundedText(message.role, 40), text: boundedText(parseFileTransport(raw).text, 2_000), timestamp: message.timestamp });
      } catch {}
    }
    return { ok: true, messages: messages.slice(-maximum) };
  } catch (error) { return publicError(error, 'That session could not be read'); }
});

// ---------- Agent self-repair / update ----------

const INSTALL_CMD = 'curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh';
function runAgentInstaller() {
  return new Promise((resolve) => {
    const childEnv = buildChildEnv();
    let proc;
    try { proc = spawn('/bin/sh', ['-c', INSTALL_CMD], { env: childEnv }); }
    catch (err) { resolve({ ok: false, error: String(err) }); return; }
    const pump = (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) broadcast('agent-install-progress', line.trim());
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('error', (err) => resolve({ ok: false, error: String(err) }));
    proc.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: 'Installer exited with code ' + code }));
  });
}
secureHandle('agent:install', () => runAgentInstaller());

secureHandle('agent:kill-all', async (_event, request = {}) => {
  try {
    assertSmallDto(request, 8 * 1024);
    return await runPaneTransition(async () => {
      const contexts = [...paneContexts.values()];
      const releases = [];
      try {
        // Restart is deliberate: local send/attachment locks still block, but a
        // live stream does not — we dispose every client including streaming ones.
        for (const context of contexts) assertPaneLocallyIdle(context, 'restarting agents');
        const unique = [...new Set(clients.values())];
        for (const context of contexts) {
          assertPaneLocallyIdle(context, 'restarting agents');
          releases.push(reservePaneAction(context));
          context.lifecycleLocked = true;
        }
        await Promise.all(unique.map((client) => disposeClient(client, request.preserveDrafts ? 'draft-preserving restart' : 'manual restart')));
        clients.clear();
        return { ok: true };
      } finally {
        for (const context of contexts) context.lifecycleLocked = false;
        for (const release of releases) release();
      }
    });
  } catch (error) { return publicError(error, 'Agents could not be restarted'); }
});

// ---------- Config files ----------

const PRIME_DIR = path.join(HOME, '.prime', 'agent');
const SETTINGS_PATH = path.join(PRIME_DIR, 'settings.json');
const MODELS_PATH = path.join(PRIME_DIR, 'models.json');
const AUTH_PATH = path.join(PRIME_DIR, 'auth.json');

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(p, obj) {
  JSON.parse(JSON.stringify(obj));
  if (fs.existsSync(p)) { try { fs.copyFileSync(p, p + '.bak'); } catch {} }
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}
function maskKey(key) {
  return typeof key === 'string' && key ? '••••' : null;
}
function sanitizeModelsForRenderer(modelsJson) {
  const value = modelsJson && typeof modelsJson === 'object' ? JSON.parse(JSON.stringify(modelsJson)) : { providers: {} };
  if (!value.providers || typeof value.providers !== 'object') value.providers = {};
  for (const provider of Object.values(value.providers)) {
    if (!provider || typeof provider !== 'object') continue;
    provider.hasApiKey = typeof provider.apiKey === 'string' && provider.apiKey !== 'none' && provider.apiKey.length > 0;
    provider.apiKeyMasked = provider.hasApiKey ? '••••' : null;
    delete provider.apiKey;
  }
  return value;
}
function readConfigForRenderer() {
  const settings = readJsonSafe(SETTINGS_PATH, {});
  const modelsJson = sanitizeModelsForRenderer(readJsonSafe(MODELS_PATH, { providers: {} }));
  const auth = readJsonSafe(AUTH_PATH, {});
  const authSummary = {};
  for (const [provider, entry] of Object.entries(auth)) {
    authSummary[provider] = entry && typeof entry === 'object'
      ? { type: entry.type || 'unknown', masked: entry.type === 'api_key' ? maskKey(entry.key) : null }
      : { type: 'unknown', masked: null };
  }
  return { settings, modelsJson, auth: authSummary };
}
function writeModelsPreservingSecrets(incoming) {
  assertSmallDto(incoming);
  if (!incoming || typeof incoming !== 'object' || !incoming.providers || typeof incoming.providers !== 'object' || Array.isArray(incoming.providers)) {
    throw new Error('models.json must contain a providers map');
  }
  const existing = readJsonSafe(MODELS_PATH, { providers: {} });
  const providers = {};
  for (const [id, raw] of Object.entries(incoming.providers)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid provider entry');
    providers[id] = providerEntryPreservingSecret(raw, existing.providers && existing.providers[id]);
  }
  writeJsonAtomic(MODELS_PATH, { ...incoming, providers });
  return { ok: true };
}

secureHandle('config:read', () => readConfigForRenderer());
secureHandle('config:write-settings', (_event, patch) => {
  try {
    assertSmallDto(patch, 64 * 1024);
    const allowed = new Set(['defaultProvider', 'defaultModel', 'defaultThinkingLevel']);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some((key) => !allowed.has(key))) throw new Error('Unsupported settings field');
    const settings = readJsonSafe(SETTINGS_PATH, {});
    Object.assign(settings, patch);
    writeJsonAtomic(SETTINGS_PATH, settings);
    return { ok: true };
  } catch (error) { return publicError(error, 'Settings could not be saved'); }
});
secureHandle('config:write-models', (_event, modelsJson) => {
  try { return writeModelsPreservingSecrets(modelsJson); }
  catch (error) { return publicError(error, 'Provider settings could not be saved'); }
});
secureHandle('config:set-api-key', (_event, request) => {
  try {
    assertSmallDto(request, 64 * 1024);
    if (!request || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(request.provider) || typeof request.key !== 'string' || !request.key.trim() || request.key.length > 32_000) throw new Error('Provider and key are required');
    const auth = readJsonSafe(AUTH_PATH, {});
    auth[request.provider] = { type: 'api_key', key: request.key.trim() };
    writeJsonAtomic(AUTH_PATH, auth);
    return { ok: true };
  } catch (error) { return publicError(error, 'The provider key could not be saved'); }
});
secureHandle('config:delete-api-key', (_event, request) => {
  try {
    if (!request || typeof request.provider !== 'string') throw new Error('Provider is required');
    const auth = readJsonSafe(AUTH_PATH, {});
    delete auth[request.provider];
    writeJsonAtomic(AUTH_PATH, auth);
    return { ok: true };
  } catch (error) { return publicError(error, 'The provider key could not be removed'); }
});

// ---------- xAI OAuth (device code flow) ----------

const XAI_ISSUER = 'https://auth.x.ai';
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_CACHE = path.join(PRIME_DIR, 'xai-oauth.json');
const XAI_BRIDGE = path.join(PRIME_DIR, 'xai-oauth-bridge.py');
const XAI_BRIDGE_SOURCE = `#!/usr/bin/env python3
import json, os, sys, time, urllib.request, urllib.parse
CACHE = os.path.expanduser('~/.prime/agent/xai-oauth.json')
TOKEN_URL = '${XAI_ISSUER}/oauth2/token'
CLIENT_ID = '${XAI_CLIENT_ID}'
def main():
    try:
        with open(CACHE) as f: data = json.load(f)
    except Exception: sys.exit(1)
    tokens = data.get('tokens') or {}
    if time.time() > data.get('expires_at', 0) - 300:
        try:
            body = urllib.parse.urlencode({'grant_type': 'refresh_token', 'client_id': CLIENT_ID,
                                           'refresh_token': tokens['refresh_token']}).encode()
            req = urllib.request.Request(TOKEN_URL, data=body,
                                         headers={'content-type': 'application/x-www-form-urlencoded'})
            with urllib.request.urlopen(req, timeout=30) as r: nt = json.load(r)
            tokens.update(nt)
            data['tokens'] = tokens
            data['expires_at'] = time.time() + int(nt.get('expires_in', 21600))
            tmp = CACHE + '.tmp'
            with open(tmp, 'w') as f: json.dump(data, f)
            os.chmod(tmp, 0o600); os.replace(tmp, CACHE)
        except Exception:
            if time.time() > data.get('expires_at', 0): sys.exit(1)
    sys.stdout.write(tokens.get('access_token', ''))
main()
`;

function xaiPost(urlStr, params) {
  return fetch(urlStr, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  }).then((r) => r.json().catch(() => ({})).then((j) => ({ status: r.status, json: j })));
}
function xaiEnsureOverride() {
  const modelsJson = readJsonSafe(MODELS_PATH, { providers: {} });
  if (!modelsJson.providers) modelsJson.providers = {};
  const prev = modelsJson.providers.xai || {};
  prev.apiKey = '!python3 ' + XAI_BRIDGE;
  modelsJson.providers.xai = prev;
  writeJsonAtomic(MODELS_PATH, modelsJson);
}
secureHandle('xai:status', () => {
  try {
    const data = JSON.parse(fs.readFileSync(XAI_CACHE, 'utf8'));
    return { connected: true, expiresAt: data.expires_at || 0, email: data.email || null };
  } catch { return { connected: false }; }
});
secureHandle('xai:disconnect', () => {
  try { fs.unlinkSync(XAI_CACHE); } catch {}
  try {
    const modelsJson = readJsonSafe(MODELS_PATH, { providers: {} });
    if (modelsJson.providers && modelsJson.providers.xai) {
      delete modelsJson.providers.xai.apiKey;
      if (!Object.keys(modelsJson.providers.xai).length) delete modelsJson.providers.xai;
      writeJsonAtomic(MODELS_PATH, modelsJson);
    }
  } catch {}
  return { ok: true };
});
secureHandle('xai:connect', async () => {
  const dc = await xaiPost(XAI_ISSUER + '/oauth2/device/code', { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE });
  if (dc.status !== 200 || !dc.json.device_code) return { ok: false, error: `xAI device flow failed (HTTP ${dc.status})` };
  const d = dc.json;
  let verificationUrl;
  try {
    verificationUrl = new URL(d.verification_uri_complete || d.verification_uri);
    if (verificationUrl.protocol !== 'https:') throw new Error();
  } catch { return { ok: false, error: 'xAI returned an invalid verification URL' }; }
  broadcast('xai-device-code', { userCode: boundedText(d.user_code, 100), verificationUri: verificationUrl.origin + verificationUrl.pathname });
  shell.openExternal(verificationUrl.href);
  const deadline = Date.now() + (d.expires_in || 900) * 1000;
  let interval = (d.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const t = await xaiPost(XAI_ISSUER + '/oauth2/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: d.device_code, client_id: XAI_CLIENT_ID,
    });
    if (t.status === 200 && t.json.access_token) {
      fs.writeFileSync(XAI_BRIDGE, XAI_BRIDGE_SOURCE, { mode: 0o700 });
      const cache = { tokens: t.json, expires_at: Math.floor(Date.now() / 1000) + (t.json.expires_in || 21600), obtained_at: new Date().toISOString() };
      fs.writeFileSync(XAI_CACHE, JSON.stringify(cache, null, 2), { mode: 0o600 });
      xaiEnsureOverride();
      return { ok: true };
    }
    const err = t.json && t.json.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    return { ok: false, error: 'xAI authorization failed: ' + (err || t.status) };
  }
  return { ok: false, error: 'xAI authorization timed out' };
});

// ---------- App prefs ----------

const APP_SETTINGS_PATH = path.join(app.getPath('userData'), 'app-settings.json');
function readAppSettings() {
  const value = readJsonSafe(APP_SETTINGS_PATH, { pins: [] });
  return { pins: Array.isArray(value.pins) ? value.pins.filter((item) => typeof item === 'string').slice(0, 500) : [] };
}
secureHandle('prefs:get', () => readAppSettings());
secureHandle('prefs:write', (_event, patch) => {
  try {
    assertSmallDto(patch, 256 * 1024);
    const current = readAppSettings();
    if (patch && Array.isArray(patch.pins)) current.pins = patch.pins.filter((item) => typeof item === 'string').slice(0, 500);
    writeJsonAtomic(APP_SETTINGS_PATH, current);
    return { ok: true };
  } catch (error) { return publicError(error, 'Preferences could not be saved'); }
});

// ---------- Pane workspaces, safe tree, and attachment registry ----------

const normalizeImageWithElectron = createElectronImageNormalizer({ nativeImage, AttachmentError, sniffImageMime });

function requireCurrentDraft(context, draftId) {
  if (!context || !context.draft || context.draft.id !== draftId) throw new AttachmentError('STALE_DRAFT', 'This attachment draft is no longer available');
}
function bindingMeta(context, fallback = null) {
  if (context) return { key: context.client.key, paneId: context.id, bindingEpoch: context.bindingEpoch };
  if (fallback && typeof fallback.key === 'string' && typeof fallback.paneId === 'string' && typeof fallback.bindingEpoch === 'string') {
    return { key: fallback.key, paneId: fallback.paneId, bindingEpoch: fallback.bindingEpoch };
  }
  return {};
}
function updateContextDraft(context) {
  context.draft = context.attachmentService.describeDraft(context.draft.id);
  return context.draft;
}
function rotateContextDraft(context) {
  if (context.draft && context.draft.id) context.attachmentService.deleteDraft(context.draft.id);
  context.draft = context.attachmentService.createDraft();
  sendToWindow(context.ownerWin, 'attachments-reset', { key: context.client.key, paneId: context.id, bindingEpoch: context.bindingEpoch, draft: context.draft });
  return context.draft;
}

async function activateProjectForPane(event, context, inspected) {
  let client = null;
  let bound = false;
  const existingBefore = new Set(clients.values());
  try {
    client = await spawnClient({ cwd: inspected.root, ownerWin: context.ownerWin, inspectedWorkspace: inspected });
    const state = await stateForClient(client);
    await requirePaneProjectIdle(context, 'changing projects');
    const replacement = bindPane(event, context.id, client);
    bound = true;
    sendToWindow(replacement.ownerWin, 'workspace-changed', { key: client.key, paneId: replacement.id, bindingEpoch: replacement.bindingEpoch, workspace: client.workspace.describe() });
    return describeActivation(replacement, state);
  } catch (error) {
    // Rollback is simple and complete: bindPane commits only after both the RPC
    // client and workspace watcher are ready, so the prior pane/context remains.
    if (client && !bound && !existingBefore.has(client) && ![...paneContexts.values()].some((candidate) => candidate.client === client)) {
      await disposeClient(client, 'failed workspace activation rollback').catch(() => {});
    }
    throw error;
  }
}

secureHandle('workspace:get', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    return { ok: true, workspace: context.client.workspace.describe(), choices: await awaitForPane(context, context.client.workspace.choicesForRenderer()) };
  } catch (error) { return publicError(error, 'Project details are unavailable'); }
});
secureHandle('workspace:pick', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    return await runPaneTransition(async () => {
      await requirePaneProjectIdle(context, 'changing projects');
      let selected;
      if (TEST_MODE && process.env.PRIME_DESKTOP_TEST_PROJECT) selected = path.resolve(process.env.PRIME_DESKTOP_TEST_PROJECT);
      else {
        const result = await dialog.showOpenDialog(context.ownerWin, { properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled) return { ok: false, canceled: true };
        selected = result.filePaths[0];
      }
      const choice = await context.client.workspace.issuePickerChoice(selected);
      const inspected = await context.client.workspace.resolveChoice(choice.id);
      // A response may have started while the native picker was open.
      await requirePaneProjectIdle(context, 'changing projects');
      return await activateProjectForPane(event, context, inspected);
    });
  } catch (error) { return publicError(error, 'That project could not be opened'); }
});
secureHandle('workspace:activate', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    return await runPaneTransition(async () => {
      await requirePaneProjectIdle(context, 'changing projects');
      const inspected = await context.client.workspace.resolveChoice(request.choiceId);
      return await activateProjectForPane(event, context, inspected);
    });
  } catch (error) { return publicError(error, 'That project could not be opened'); }
});
secureHandle('workspace:list-dir', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 32 * 1024 });
    return await awaitForPane(context, context.client.workspace.listDirectory(request.request || {}));
  } catch (error) { return publicError(error, 'That folder could not be read'); }
});
secureHandle('workspace:search', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 32 * 1024 });
    return await awaitForPane(context, context.client.workspace.search(request.request || {}));
  } catch (error) { return { ...publicError(error, 'Project files could not be searched'), entries: [] }; }
});
secureHandle('workspace:read-file', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    return await awaitForPane(context, context.client.workspace.readFile(request.nodeId, request.maxBytes));
  } catch (error) { return publicError(error, 'That file could not be read'); }
});
secureHandle('workspace:refresh', (event, request) => {
  try { const context = paneContextFor(event, request, { cap: 8 * 1024 }); context.client.workspace.refresh('manual'); return { ok: true }; }
  catch (error) { return publicError(error); }
});
secureHandle('workspace:context-menu', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    const paths = await awaitForPane(context, context.client.workspace.contextPaths(request.nodeId));
    const menu = Menu.buildFromTemplate([
      { label: 'Copy Relative Path', click: () => clipboard.writeText(paths.relative) },
      { label: 'Copy Absolute Path', click: () => clipboard.writeText(paths.absolute) },
      { type: 'separator' },
      { label: 'Reveal in Finder', click: () => shell.showItemInFolder(paths.absolute) },
    ]);
    menu.popup({ window: context.ownerWin });
    return { ok: true };
  } catch (error) { return publicError(error, 'That file action is no longer available'); }
});

secureHandle('attachments:get', (event, request) => {
  try { const context = paneContextFor(event, request, { cap: 8 * 1024 }); return { ok: true, draft: context.draft }; }
  catch (error) { return publicError(error); }
});
secureHandle('attachments:pick', async (event, request) => {
  let context = null;
  let releaseAction = null;
  try {
    context = paneContextFor(event, request, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
    releaseAction = reservePaneAction(context);
    let paths;
    if (TEST_MODE && process.env.PRIME_DESKTOP_TEST_ATTACH_PATHS) paths = JSON.parse(process.env.PRIME_DESKTOP_TEST_ATTACH_PATHS);
    else {
      const result = await dialog.showOpenDialog(context.ownerWin, { properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return { ok: true, canceled: true, draft: context.draft };
      paths = result.filePaths;
    }
    assertCurrentPaneContext(context);
    requireCurrentDraft(context, request.draftId);
    const result = await context.attachmentService.ingestPaths({ draftId: request.draftId, paths, source: 'picker' });
    assertCurrentPaneContext(context);
    return { ok: true, ...result, draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'A selected file could not be attached'), draft: context && context.draft }; }
  finally { if (releaseAction) releaseAction(); }
});
secureHandle('attachments:drop', async (event, request) => {
  let context = null;
  try {
    context = paneContextFor(event, request, { cap: 128 * 1024 });
    requireCurrentDraft(context, request.draftId);
    if (!Array.isArray(request.paths) || request.paths.some((value) => typeof value !== 'string')) throw new AttachmentError('INVALID_SELECTION', 'That dropped file selection is invalid');
    const result = await context.attachmentService.ingestPaths({ draftId: request.draftId, paths: request.paths, source: 'drop' });
    assertCurrentPaneContext(context);
    return { ok: true, ...result, draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'A dropped file could not be attached'), draft: context && context.draft }; }
});
secureHandle('attachments:paste-image', async (event, request) => {
  let context = null;
  try {
    if (!request || typeof request.paneId !== 'string' || typeof request.draftId !== 'string' || typeof request.name !== 'string') throw new AttachmentError('INVALID_IMAGE', 'The pasted image could not be read');
    context = paneContextFor(event, { paneId: request.paneId, key: request.key, bindingEpoch: request.bindingEpoch }, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
    const raw = request.bytes;
    const length = raw && typeof raw.byteLength === 'number' ? raw.byteLength : -1;
    if (length < 0) throw new AttachmentError('INVALID_IMAGE', 'The pasted image could not be read');
    if (length > 20_000_000) throw new AttachmentError('IMAGE_TOO_LARGE', 'Images must be 20 MB or smaller');
    const bytes = Buffer.from(raw.buffer || raw, raw.byteOffset || 0, length);
    const result = await context.attachmentService.ingestClipboardImage({ draftId: request.draftId, bytes, name: request.name });
    assertCurrentPaneContext(context);
    return { ok: true, item: result.item, duplicate: result.duplicate, draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'The pasted image could not be attached'), draft: context && context.draft }; }
});
secureHandle('attachments:add-tree-node', async (event, request) => {
  let context = null;
  let releaseAction = null;
  try {
    context = paneContextFor(event, request, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
    releaseAction = reservePaneAction(context);
    const node = await context.client.workspace.contextPaths(request.nodeId);
    let result;
    if (node.isDirectory) {
      result = await context.attachmentService.ingestReference({
        draftId: request.draftId,
        kind: 'folder',
        name: path.basename(node.relative) || context.client.workspace.describe().name,
        dedupeKey: `folder:${node.relative}`,
        text: `Referenced workspace folder: ${node.relative}`,
      });
      result = { items: result.duplicate ? [] : [result.item], duplicates: result.duplicate ? 1 : 0, errors: [] };
    } else {
      const file = await context.client.workspace.attachmentPath(request.nodeId);
      result = await context.attachmentService.ingestPaths({ draftId: request.draftId, paths: [file.path], source: 'tree' });
    }
    assertCurrentPaneContext(context);
    return { ok: true, ...result, draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'That project entry could not be attached'), draft: context && context.draft }; }
  finally { if (releaseAction) releaseAction(); }
});
secureHandle('attachments:add-session', async (event, request) => {
  let context = null;
  let releaseAction = null;
  try {
    context = paneContextFor(event, request, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
    releaseAction = reservePaneAction(context);
    const sessionPath = await canonicalSessionPath(SESSIONS_DIR, request.sessionPath);
    const lines = (await fsp.readFile(sessionPath, 'utf8')).split('\n');
    const transcript = [];
    for (const line of lines) {
      if (!line.trim() || line[0] !== '{') continue;
      try {
        const record = JSON.parse(line);
        if (record.type !== 'message') continue;
        const message = record.message || {};
        const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('') : '';
        if (text) transcript.push(`${boundedText(message.role, 40)}: ${boundedText(parseFileTransport(text).text, 2_000)}`);
      } catch {}
      if (transcript.length >= 30) break;
    }
    const result = await context.attachmentService.ingestReference({
      draftId: request.draftId,
      kind: 'session',
      name: boundedText(request.name || path.basename(sessionPath), 255),
      dedupeKey: `session:${sessionPath}`,
      text: `<referenced_session>\n${transcript.join('\n')}\n</referenced_session>`,
    });
    assertCurrentPaneContext(context);
    return { ok: true, items: result.duplicate ? [] : [result.item], duplicates: result.duplicate ? 1 : 0, errors: [], draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'That session could not be attached'), draft: context && context.draft }; }
  finally { if (releaseAction) releaseAction(); }
});
secureHandle('attachments:remove', async (event, request) => {
  let context = null;
  try {
    context = paneContextFor(event, request, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
    await context.attachmentService.remove({ draftId: request.draftId, attachmentId: request.attachmentId });
    assertCurrentPaneContext(context);
    context.draft = updateContextDraft(context);
    return { ok: true, draft: context.draft };
  } catch (error) { return { ...publicError(error, 'That attachment could not be removed'), draft: context && context.draft }; }
});
secureHandle('chat:send', async (event, request) => {
  let context = null;
  let releaseSend = null;
  try {
    context = paneContextFor(event, request, { cap: 256 * 1024 });
    requireCurrentDraft(context, request.draftId);
    if (context.pendingActions > 0) throw new AttachmentError('ATTACHMENTS_PENDING', 'Wait for attachments to finish before sending');
    releaseSend = tryAcquireFlag(context, 'sending');
    if (!releaseSend) throw new Error('A message is already being sent from this pane');
    const behavior = request.behavior === 'steer' ? 'steer' : request.behavior === 'followUp' ? 'followUp' : 'prompt';
    const sent = await context.attachmentService.sendDraft(
      { draftId: request.draftId, text: request.text || '', behavior },
      (command) => clientCommand(context.client, command),
    );
    assertCurrentPaneContext(context);
    if (!sent.accepted) return { ...bindingMeta(context), ok: false, accepted: false, error: boundedText(sent.error, 500), draft: context.draft };
    const rendered = { text: sent.serialized.visibleText, attachments: sent.serialized.attachments };
    const draft = rotateContextDraft(context);
    return { ...bindingMeta(context), ok: true, accepted: true, response: sent.response, rendered, draft };
  } catch (error) { return { ...bindingMeta(context, request), ...publicError(error, 'The message could not be sent'), accepted: false, draft: context && context.draft }; }
  finally { if (releaseSend) releaseSend(); }
});
secureHandle('security:get-events', () => ({ events: TEST_MODE ? [...securityEvents] : [] }));

// ---------- Skills (list / toggle / add) ----------

const SKILL_DIRS = [path.join(HOME, '.agents', 'skills'), path.join(PRIME_DIR, 'skills')];
const skillTokens = new Map();
function scanSkills() {
  skillTokens.clear();
  const output = [];
  for (const base of SKILL_DIRS) {
    let names;
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const name of names.slice(0, 1_000)) {
      const dir = path.join(base, name);
      const enabledPath = path.join(dir, 'SKILL.md');
      const disabledPath = path.join(dir, 'SKILL.md.disabled');
      const file = fs.existsSync(enabledPath) ? enabledPath : fs.existsSync(disabledPath) ? disabledPath : null;
      if (!file) continue;
      try {
        const realDir = fs.realpathSync(dir);
        const realFile = fs.realpathSync(file);
        if (!SKILL_DIRS.some((root) => isWithin(fs.realpathSync(root), realDir))) continue;
        const head = fs.readFileSync(realFile, 'utf8').slice(0, 4_000);
        const nameMatch = head.match(/^name:\s*(.+)$/m);
        const descriptionMatch = head.match(/^description:\s*(.+)$/m);
        const id = `skill_${crypto.randomUUID()}`;
        skillTokens.set(id, { dir: realDir, file: realFile, enabled: file === enabledPath });
        output.push({
          id,
          name: boundedText(nameMatch ? nameMatch[1].trim() : name, 200),
          description: boundedText(descriptionMatch ? descriptionMatch[1].trim() : '', 300),
          enabled: file === enabledPath,
          source: base.includes('.agents') ? 'user' : 'prime',
        });
      } catch {}
    }
  }
  output.sort((a, b) => a.name.localeCompare(b.name));
  return output;
}
secureHandle('skills:list', () => scanSkills());
secureHandle('skills:read', (_event, id) => {
  try {
    const entry = skillTokens.get(id);
    if (!entry) throw new Error('That skill is no longer available');
    const text = fs.readFileSync(entry.file, 'utf8');
    return { ok: true, text: text.slice(0, 200_000), truncated: text.length > 200_000 };
  } catch (error) { return publicError(error, 'That skill could not be read'); }
});
secureHandle('skills:toggle', (_event, request) => {
  try {
    const entry = skillTokens.get(request && request.id);
    if (!entry || typeof request.enable !== 'boolean') throw new Error('That skill is no longer available');
    const from = path.join(entry.dir, request.enable ? 'SKILL.md.disabled' : 'SKILL.md');
    const to = path.join(entry.dir, request.enable ? 'SKILL.md' : 'SKILL.md.disabled');
    fs.renameSync(from, to);
    return { ok: true };
  } catch (error) { return publicError(error, 'That skill could not be changed'); }
});
secureHandle('skills:add-from-folder', async (event) => {
  try {
    const result = await dialog.showOpenDialog(ownerForEvent(event), { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
    const source = canonicalDirectory(result.filePaths[0]);
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error('No SKILL.md in that folder');
    const destination = path.join(PRIME_DIR, 'skills', path.basename(source));
    if (fs.existsSync(destination)) throw new Error('A skill with that name already exists');
    fs.cpSync(source, destination, { recursive: true });
    return { ok: true };
  } catch (error) { return publicError(error, 'That skill could not be installed'); }
});

// ---------- HUD ----------

let hudWin = null;
let hudClient = null;
let hudReady = false;
let hudOpenPending = false;
let hudShortcutRegistered = false;
let hudShortcutRegistrationAttempted = false;
let lastFocusedMainWin = null;
const HUD_WIDTH = 620, HUD_HEIGHT = 480;
function installNavigationPolicy(window, localFile) {
  const deny = (target, kind) => {
    const classification = classifyNavigation(target, localFile);
    rememberSecurityEvent(kind, target);
    // Frozen policy: never replace the app document; explicit http(s) links are
    // opened by the OS browser, while every other remote/custom scheme is denied.
    if (!TEST_MODE && classification.action === 'external') shell.openExternal(classification.url).catch(() => {});
  };
  window.webContents.on('will-navigate', (event, target) => {
    if (classifyNavigation(target, localFile).action === 'local') return;
    event.preventDefault();
    deny(target, 'navigation-denied');
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (classifyNavigation(target, localFile).action === 'local') return;
    event.preventDefault();
    deny(target, 'redirect-denied');
  });
  window.webContents.setWindowOpenHandler(({ url }) => { deny(url, 'window-open-denied'); return { action: 'deny' }; });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function updateHudMenuLabel() {
  const menu = Menu.getApplicationMenu();
  const item = menu && menu.getMenuItemById('toggle-prime-hud');
  if (item) item.label = hudWin && !hudWin.isDestroyed() && hudWin.isVisible() ? 'Hide Prime HUD' : 'Show Prime HUD';
}

function createHud() {
  hudReady = false;
  hudOpenPending = false;
  hudWin = new BrowserWindow({
    width: HUD_WIDTH, height: HUD_HEIGHT, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#0f1011',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const hudFile = path.join(__dirname, 'renderer', 'hud.html');
  installNavigationPolicy(hudWin, hudFile);
  const candidate = hudWin;
  let documentLoaded = false;
  let readyToShow = false;
  const markHudReady = () => {
    if (candidate !== hudWin || candidate.isDestroyed() || !documentLoaded || !readyToShow) return;
    hudReady = true;
    if (hudOpenPending) showHud();
  };
  candidate.webContents.once('did-finish-load', () => { documentLoaded = true; markHudReady(); });
  candidate.once('ready-to-show', () => { readyToShow = true; markHudReady(); });
  hudWin.loadFile(hudFile).catch((error) => {
    hudOpenPending = false;
    console.warn('PRIME_HUD_LOAD_FAILED', boundedText(error && error.message, 300));
  });
  hudWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWin.on('blur', () => {
    if (hudWin && !hudWin.isDestroyed() && !hudWin.webContents.isDevToolsOpened()) hideHud();
  });
  hudWin.on('closed', () => {
    const previousClient = hudClient;
    hudClient = null;
    hudWin = null;
    hudReady = false;
    hudOpenPending = false;
    updateHudMenuLabel();
    void releaseUnreferencedDaemonClient(previousClient, 'Prime HUD closed');
  });
}
function selectHudClient(key) {
  if (key) {
    const explicit = clients.get(key);
    return explicit && explicit.alive ? explicit : null;
  }
  const available = [...clients.values()].filter((client) => client.alive);
  const focused = lastFocusedMainWin && !lastFocusedMainWin.isDestroyed()
    ? available.filter((client) => client.viewers && client.viewers.has(lastFocusedMainWin))
    : [];
  return (focused.length ? focused : available).sort((a, b) => b.lastUsed - a.lastUsed)[0] || null;
}

function sendHudEvent(client, event) {
  if (!hudWin || hudWin.isDestroyed() || client !== hudClient) return;
  sendToWindow(hudWin, 'hud-event', { key: client.key, event });
}

function showHud() {
  if (!hudWin || hudWin.isDestroyed()) return { ok: false, error: 'Prime HUD is unavailable' };
  if (!hudReady) { hudOpenPending = true; return { ok: true, pending: true, visible: false }; }
  hudOpenPending = false;
  hudClient = selectHudClient(null);
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  hudWin.setPosition(Math.round(x + (width - HUD_WIDTH) / 2), Math.round(y + height - HUD_HEIGHT - 72));
  hudWin.show(); hudWin.focus();
  sendToWindow(hudWin, 'hud-opened', {
    key: hudClient && hudClient.key,
    sessionFile: hudClient && hudClient.sessionFile,
    streaming: !!(hudClient && hudClient.streaming),
  });
  updateHudMenuLabel();
  return { ok: true, visible: true };
}

function hideHud() {
  const previousClient = hudClient;
  hudClient = null;
  hudOpenPending = false;
  if (hudWin && !hudWin.isDestroyed()) hudWin.hide();
  updateHudMenuLabel();
  void releaseUnreferencedDaemonClient(previousClient, 'Prime HUD hidden');
  return { ok: true, visible: false };
}

function toggleHud() {
  if (!hudWin || hudWin.isDestroyed()) return { ok: false, error: 'Prime HUD is unavailable' };
  if (hudWin.isVisible() || hudOpenPending) return hideHud();
  return showHud();
}
secureHandle('hud:toggle', () => toggleHud());
secureHandle('hud:hide', () => hideHud());

secureHandle('hud:prompt', async (_e, { key, text }) => {
  try {
    const client = key ? selectHudClient(key) : (hudClient && hudClient.alive ? hudClient : selectHudClient(null));
    if (!client) return { ok: false, error: 'no agent running' };
    hudClient = client;
    client.lastUsed = Date.now();
    const st = await clientCommand(client, { type: 'get_state' });
    const cmd = { type: 'prompt', message: text };
    if (st.success && st.data.isStreaming) cmd.streamingBehavior = 'steer';
    const r = await clientCommand(client, cmd);
    return {
      ok: !!r.success, error: r.error || null,
      streaming: !!(st.success && st.data.isStreaming),
      key: client.key, sessionFile: client.sessionFile,
    };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
secureHandle('hud:abort', async () => {
  try {
    if (!hudClient || !hudClient.alive) return { ok: false, error: 'no agent running' };
    const r = await clientCommand(hudClient, { type: 'abort' });
    return { ok: !!r.success, error: r.error || null };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
secureHandle('hud:open-session', () => {
  if (!hudClient) return { ok: false, error: 'no session selected' };
  const owner = (lastFocusedMainWin && hudClient.viewers && hudClient.viewers.has(lastFocusedMainWin))
    ? lastFocusedMainWin
    : [...(hudClient.viewers || [])].find((win) => win && !win.isDestroyed());
  if (owner && !owner.isDestroyed()) {
    if (owner.isMinimized()) owner.restore();
    owner.show();
    owner.focus();
  } else {
    createWindow(hudClient.sessionFile || undefined);
  }
  hideHud();
  return { ok: true, sessionFile: hudClient.sessionFile };
});

// ---------- Windows / pop-out ----------

const wins = new Set();
const splitAvailabilityByWindow = new WeakMap();
function createWindow(sessionQuery) {
  const win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 940, minHeight: 600,
    title: 'Prime Agent', backgroundColor: '#08090a', show: !TEST_MODE || process.env.PRIME_DESKTOP_TEST_SHOW_WINDOWS === '1',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  wins.add(win);
  splitAvailabilityByWindow.set(win, true);
  if (TEST_MODE) win.webContents.on('console-message', (_event, details) => {
    if (details && ['warning', 'error'].includes(details.level)) console.error('RENDERER_CONSOLE', boundedText(details.message, 2_000), boundedText(details.sourceId, 300), Number(details.lineNumber) || 0);
  });
  win.on('focus', () => { lastFocusedMainWin = win; updateSplitMenuItems(); });
  win.on('closed', () => {
    wins.delete(win);
    splitAvailabilityByWindow.delete(win);
    const affected = new Set();
    for (const [paneId, context] of paneContexts) {
      if (context.ownerWin !== win) continue;
      context.attachmentService.deleteDraft(context.draft.id);
      paneContexts.delete(paneId);
      affected.add(context.client);
    }
    for (const client of affected) refreshClientViewers(client);
    void (async () => {
      for (const client of affected) {
        if (clientHasPaneConsumer(client) || hudConsumesClient(client)) continue;
        // Detach without killing so live work continues after the window is gone.
        await disposeClient(client, 'last desktop window released', true, { detachOnly: true }).catch(() => {});
      }
      await evictIdleClients();
    })();
    if (lastFocusedMainWin === win) lastFocusedMainWin = null;
  });
  const file = path.join(__dirname, 'renderer', 'index.html');
  installNavigationPolicy(win, file);
  win.webContents.once('did-finish-load', () => {
    if (hudShortcutRegistrationAttempted && !hudShortcutRegistered) {
      sendToWindow(win, 'hud-shortcut-status', {
        registered: false,
        message: 'The global HUD shortcut could not be registered. Use Prime HUD here or Window → Show Prime HUD.',
      });
    }
  });
  if (sessionQuery) win.loadFile(file, { query: { session: sessionQuery } });
  else win.loadFile(file);
  if (!app.isPackaged && !TEST_MODE && process.env.PRIME_DESKTOP_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  if (TEST_MODE && process.env.PRIME_DESKTOP_EVAL) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const result = await win.webContents.executeJavaScript(process.env.PRIME_DESKTOP_EVAL, true);
          console.log('EVAL_RESULT', JSON.stringify(result));
        } catch (error) {
          console.error('EVAL_ERROR', boundedText(error && error.message));
          process.exitCode = 1;
        }
        if (process.env.PRIME_DESKTOP_QUIT_AFTER_EVAL === '1') app.quit();
      }, Math.max(100, Number(process.env.PRIME_DESKTOP_EVAL_DELAY) || 800));
    });
  }
  if (TEST_MODE && process.env.PRIME_DESKTOP_CAPTURE) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try { fs.writeFileSync(process.env.PRIME_DESKTOP_CAPTURE, (await win.webContents.capturePage()).toPNG()); }
      catch {}
    }, 1_000));
  }
  return win;
}

secureHandle('window:pop-out', async (_event, sessionPath) => {
  try {
    const canonical = sessionPath ? await canonicalSessionPath(SESSIONS_DIR, sessionPath) : null;
    createWindow(canonical || undefined);
    return { ok: true };
  } catch (error) { return publicError(error, 'That session could not be opened in a new window'); }
});

// ---------- Menu ----------

function focusedMainWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && wins.has(focused) && !focused.isDestroyed()) return focused;
  if (lastFocusedMainWin && wins.has(lastFocusedMainWin) && !lastFocusedMainWin.isDestroyed()) return lastFocusedMainWin;
  return [...wins].find((win) => win && !win.isDestroyed()) || null;
}
function sendMenuAction(id) {
  const target = focusedMainWindow();
  if (target) sendToWindow(target, 'menu-action', { id });
}
function updateSplitMenuItems() {
  const menu = Menu.getApplicationMenu();
  const focused = focusedMainWindow();
  const available = focused ? splitAvailabilityByWindow.get(focused) !== false : true;
  for (const id of ['split-view', 'new-chat-split']) {
    const item = menu && menu.getMenuItemById(id);
    if (item) item.enabled = available;
  }
}
secureHandle('window:set-split-available', (event, request = {}) => {
  const owner = ownerForEvent(event);
  if (!owner || !wins.has(owner)) return { ok: false };
  splitAvailabilityByWindow.set(owner, request.available === true);
  if (owner === focusedMainWindow()) updateSplitMenuItems();
  return { ok: true };
});
secureHandle('test:window-state', () => {
  if (!TEST_MODE) return { ok: false };
  const mainWindows = [...wins].filter((win) => win && !win.isDestroyed());
  return {
    ok: true,
    mainWindowCount: mainWindows.length,
    visibleMainWindowCount: mainWindows.filter((win) => win.isVisible()).length,
    hudExists: !!(hudWin && !hudWin.isDestroyed()),
    hudReady,
    hudPending: hudOpenPending,
    hudVisible: !!(hudWin && !hudWin.isDestroyed() && hudWin.isVisible()),
    hudAlwaysOnTop: !!(hudWin && !hudWin.isDestroyed() && hudWin.isAlwaysOnTop()),
    shortcutRegistered: hudShortcutRegistered,
    menuHasHud: !!(Menu.getApplicationMenu() && Menu.getApplicationMenu().getMenuItemById('toggle-prime-hud')),
    menuHasSplit: !!(Menu.getApplicationMenu() && Menu.getApplicationMenu().getMenuItemById('split-view')),
  };
});

function buildMenu() {
  const send = (id) => () => sendMenuAction(id);
  const template = [
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Open at Login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: send('new-chat') },
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('open-project') },
      { label: 'Attach Files…', accelerator: 'CmdOrCtrl+Shift+A', click: send('attach-files') },
      { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('open-settings') },
      { type: 'separator' }, { role: 'close' },
    ] },
    { label: 'Agent', submenu: [
      { label: 'Install or Repair Agent…', click: send('install-agent') },
      { label: 'Update Agent…', click: send('update-agent') },
      { type: 'separator' },
      { label: 'Restart All Agents', click: send('restart-agent') },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' },
    { label: 'Window', submenu: [
      { id: 'split-view', label: 'Split View', accelerator: 'CmdOrCtrl+Alt+S', enabled: true, click: send('split-view') },
      { id: 'new-chat-split', label: 'New Chat in Split', accelerator: 'CmdOrCtrl+Alt+N', enabled: true, click: send('new-chat-split') },
      { type: 'separator' },
      { id: 'toggle-prime-hud', label: 'Show Prime HUD', accelerator: 'CmdOrCtrl+Alt+H', click: () => toggleHud() },
      { type: 'separator' }, { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  updateHudMenuLabel();
  updateSplitMenuItems();
}

// ---------- Boot ----------

function registerHudShortcut() {
  const accelerator = 'CommandOrControl+Shift+Space';
  if (TEST_MODE && process.env.PRIME_DESKTOP_TEST_SHORTCUT_FAILURE !== '1') return false;
  hudShortcutRegistrationAttempted = true;
  if (TEST_MODE) hudShortcutRegistered = false;
  else {
    try {
      const accepted = globalShortcut.register(accelerator, toggleHud);
      hudShortcutRegistered = accepted === true && globalShortcut.isRegistered(accelerator);
    } catch { hudShortcutRegistered = false; }
  }
  if (!hudShortcutRegistered) {
    rememberSecurityEvent('hud-shortcut-unavailable', accelerator);
    console.warn('PRIME_HUD_SHORTCUT_UNAVAILABLE', accelerator, 'menu and in-app fallbacks remain available');
  }
  return hudShortcutRegistered;
}

function activateMainWindow() {
  const available = [...wins].filter((win) => win && !win.isDestroyed());
  if (!available.length) return createWindow();
  const target = focusedMainWindow() || available[0];
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

async function waitForTestCondition(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function runWindowLifecycleSmoke(firstWindow) {
  // toggleHud was called before the HUD document loaded; the queued request must
  // become a real, separate, always-on-top window once did-finish-load fires.
  const opened = await waitForTestCondition(() => hudReady && hudWin && hudWin.isVisible());
  const before = {
    opened,
    mainWindowCount: wins.size,
    mainVisible: firstWindow && firstWindow.isVisible(),
    hudSeparate: !!(hudWin && hudWin !== firstWindow),
    hudAlwaysOnTop: !!(hudWin && hudWin.isAlwaysOnTop()),
    menuFallback: !!(Menu.getApplicationMenu() && Menu.getApplicationMenu().getMenuItemById('toggle-prime-hud')),
    shortcutRegistered: hudShortcutRegistered,
  };
  hideHud();
  for (const win of [...wins]) if (!win.isDestroyed()) win.close();
  const closed = await waitForTestCondition(() => wins.size === 0);
  const hiddenHudSurvived = !!(hudWin && !hudWin.isDestroyed() && !hudWin.isVisible());
  app.emit('activate');
  const reactivated = await waitForTestCondition(() => wins.size === 1);
  const replacement = [...wins][0];
  const result = {
    ...before,
    closed,
    hiddenHudSurvived,
    reactivated,
    replacementVisible: !!(replacement && replacement.isVisible()),
  };
  console.log('WINDOW_SMOKE_RESULT', JSON.stringify(result));
  setTimeout(() => app.quit(), 50);
}

app.whenReady().then(async () => {
  buildMenu();
  createHud();
  registerHudShortcut();
  if (TEST_MODE && process.env.PRIME_DESKTOP_WINDOW_LIFECYCLE_SMOKE === '1') toggleHud();
  const firstWindow = createWindow();
  watchSessions();
watchArtifacts();
  app.on('activate', activateMainWindow);
  if (TEST_MODE && process.env.PRIME_DESKTOP_WINDOW_LIFECYCLE_SMOKE === '1') void runWindowLifecycleSmoke(firstWindow);
});

app.on('window-all-closed', () => { /* HUD hotkey keeps app alive; Cmd+Q to quit */ });
let shutdownStarted = false;
let shutdownComplete = false;
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  globalShortcut.unregisterAll();
  const unique = [...new Set(clients.values())];
  void (async () => {
    try {
      // Detach Desktop only. Never SIGTERM/SIGKILL agent workers on quit —
      // sessions must keep running (daemon-resident or orphaned RPC child).
      await Promise.all(unique.map((client) => disposeClient(client, 'app-quit', true, { detachOnly: true })));
      // Do NOT cleanup session files on quit — a "empty" auto-created session may
      // still be the live worker we just detached from.
    } finally {
      clients.clear();
      paneContexts.clear();
      shutdownComplete = true;
      app.quit();
    }
  })();
});
