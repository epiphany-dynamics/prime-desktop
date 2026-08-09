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
const { pathToFileURL } = require('url');

const { primeDaemonLaunchConfig } = require('./daemon-launch');
const { prepareSessionHandoff } = require('./session-handoff');
const { RpcManager, canonicalDirectory } = require('./lib/rpc-manager');
const { WorkspaceService, isWithin } = require('./lib/workspace-service');
const { AttachmentService, AttachmentError, MAX_DIMENSION, MAX_IMAGE_BASE64, sniffImageMime, parseFileTransport } = require('./lib/attachment-service');
const { canonicalSessionsRoot, canonicalSessionPath, validateSessionHeader, safeDeleteSession, cleanupTrackedEmptySessions, countSessionMessages } = require('./lib/session-utils');

const TEST_MODE = !app.isPackaged && process.env.PRIME_DESKTOP_TEST_MODE === '1';
const HOME_INPUT = TEST_MODE && process.env.PRIME_DESKTOP_TEST_HOME ? path.resolve(process.env.PRIME_DESKTOP_TEST_HOME) : os.homedir();
if (TEST_MODE) fs.mkdirSync(HOME_INPUT, { recursive: true });
const HOME = fs.realpathSync(HOME_INPUT);
if (TEST_MODE) app.setPath('userData', path.join(HOME, '.prime-desktop-test-user-data'));
const SESSIONS_DIR = path.join(HOME, '.prime', 'agent', 'sessions');
const COMMAND_TIMEOUT_MS = 30000;
const SWITCH_SESSION_TIMEOUT_MS = 90000;
const MAX_CLIENTS = 8;
const MAX_IPC_JSON_BYTES = 2 * 1024 * 1024;
const WORKSPACE_STATE_PATH = path.join(app.getPath('userData'), 'workspaces.json');
const DAEMON_LAUNCH = primeDaemonLaunchConfig();
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

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

// ---------- Multi-client RPC manager ----------
// One hardened RpcManager per live session, routed by opaque pane contexts.

const clients = new Map();
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
  if (!client || !client.alive) return Promise.reject(new Error('Agent process is not running'));
  return client.rpc.command(command, timeoutMs ? { timeoutMs } : {});
}
function getClient(key) { return typeof key === 'string' ? clients.get(key) : null; }

function refreshClientViewers(client) {
  if (!client) return;
  const viewers = new Set();
  for (const context of paneContexts.values()) if (context.client === client && context.ownerWin && !context.ownerWin.isDestroyed()) viewers.add(context.ownerWin);
  client.viewers = viewers;
}
function trackCreatedSession(sessionPath) {
  if (typeof sessionPath === 'string') createdSessionFiles.add(sessionPath);
}
function handleClientMessage(client, obj) {
  if (!clientIsCurrent(client)) return;
  if (obj.type === 'agent_start') client.streaming = true;
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

async function disposeClient(client, reason = 'shutdown', remove = true) {
  if (!client) return;
  if (remove) for (const [key, value] of clients) if (value === client) clients.delete(key);
  client.committed = false;
  client.alive = false;
  if (client.workspace) client.workspace.dispose();
  await client.rpc.stop(reason);
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

async function spawnClient({ sessionPath = null, cwd, ownerWin, inspectedWorkspace = null }) {
  const targetCwd = canonicalDirectory(cwd || HOME);
  const temporaryKey = `new:${++tempSeq}`;
  const rpc = new RpcManager({
    defaultCwd: targetCwd,
    resolveInvocation: resolveAgentInvocation,
    buildEnv: buildChildEnv,
    extraArgs: ['--daemon-socket', DAEMON_LAUNCH.socketPath],
  });
  const client = {
    key: temporaryKey,
    rpc,
    sessionFile: sessionPath,
    cwd: targetCwd,
    viewers: new Set(ownerWin ? [ownerWin] : []),
    streaming: false,
    lastUsed: Date.now(),
    autoCreated: !sessionPath,
    alive: true,
    committed: false,
    workspace: null,
  };
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
    sendHudEvent(client, { type: 'error', error: payload.error || `Agent process exited (${payload.code})` });
  });

  try {
    await rpc.start({ cwd: targetCwd, sessionPath, reason: 'client activation' });
    const ready = await rpc.waitUntilReady();
    const reported = ready.data && ready.data.sessionFile;
    if (typeof reported !== 'string') throw new Error('Agent did not report a session file');
    const canonicalSession = await canonicalSessionPath(SESSIONS_DIR, reported);
    if (sessionPath && canonicalSession !== sessionPath) throw new Error('Agent resumed a different session than requested');
    client.sessionFile = canonicalSession;
    client.key = canonicalSession;
    client.streaming = !!(ready.data && ready.data.isStreaming);
    client.workspace = createWorkspaceService(client);
    if (targetCwd !== HOME) {
      const inspected = inspectedWorkspace || await client.workspace.inspectPath(targetCwd);
      await client.workspace.activatePath(targetCwd, { inspected, recordRecent: true });
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
  const existing = sessionPath && getClient(sessionPath);
  if (existing && existing.alive) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing) await disposeClient(existing, 'dead client replacement');
  return spawnClient({ sessionPath, cwd, ownerWin, inspectedWorkspace });
}

function runAgentCliJson(args, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const childEnv = buildChildEnv();
    const invocation = resolveAgentInvocation(childEnv);
    if (!invocation) return reject(new Error('prime-agent binary not found'));
    let stdout = '', stderr = '', settled = false;
    const proc = spawn(invocation.command, [...invocation.args, args[0], '--daemon-socket', DAEMON_LAUNCH.socketPath, ...args.slice(1)], {
      cwd: HOME, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`prime-agent ${args[0]} timed out`));
    }, timeoutMs);
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `prime-agent ${args[0]} exited with code ${code}`));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); }
      catch { reject(new Error(`prime-agent ${args[0]} returned invalid JSON`)); }
    });
  });
}
async function prepareTargetSession(sessionPath) {
  return prepareSessionHandoff(sessionPath, {
    list: async () => (await runAgentCliJson(['list', '--json'])).sessions || [],
    stop: async (activeSessionId) => { await runAgentCliJson(['stop', activeSessionId, '--json']); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: 5_000,
  });
}
async function waitForSessionPersisted(filePath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countSessionMessages(filePath) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function ownerForEvent(event) { return BrowserWindow.fromWebContents(event.sender); }
function paneContextFor(event, request = {}, options = {}) {
  assertSmallDto(request, options.cap || 64 * 1024);
  const context = paneContexts.get(request.paneId);
  const owner = ownerForEvent(event);
  if (!context || context.ownerWin !== owner) throw new Error('This pane is no longer available');
  if (request.key && context.client.key !== request.key) throw new Error('This pane changed sessions; retry the action');
  return context;
}
function bindPane(event, requestedPaneId, client) {
  const ownerWin = ownerForEvent(event);
  let paneId = typeof requestedPaneId === 'string' && requestedPaneId.length <= 100 ? requestedPaneId : null;
  const previous = paneId && paneContexts.get(paneId);
  if (previous && previous.ownerWin !== ownerWin) throw new Error('This pane is no longer available');
  if (!paneId || !previous) paneId = `pane_${crypto.randomUUID()}`;
  if (previous) {
    previous.attachmentService.deleteDraft(previous.draft.id);
    paneContexts.delete(paneId);
    refreshClientViewers(previous.client);
  }
  const attachmentService = new AttachmentService({
    homeDir: HOME,
    getWorkspace: () => client.workspace.describe(),
    normalizeImage: normalizeImageWithElectron,
  });
  const draft = attachmentService.createDraft();
  const context = { id: paneId, ownerWin, client, attachmentService, draft };
  paneContexts.set(paneId, context);
  refreshClientViewers(client);
  return context;
}
function describeActivation(context, state) {
  return {
    ok: true,
    key: context.client.key,
    paneId: context.id,
    sessionFile: context.client.sessionFile,
    state,
    workspace: context.client.workspace.describe(),
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
    assertSmallDto(request, 32 * 1024);
    const ownerWin = ownerForEvent(event);
    let sessionPath = null;
    let targetCwd = HOME;
    if (request.sessionPath) {
      const verified = await validateSessionHeader(SESSIONS_DIR, request.sessionPath);
      sessionPath = verified.sessionPath;
      targetCwd = verified.header.cwd;
      if (!clients.has(sessionPath) && !TEST_MODE) {
        const prepared = await prepareTargetSession(sessionPath);
        if (!prepared.ok) throw new Error(prepared.error);
      }
    } else {
      const sourceContext = request.paneId && paneContexts.get(request.paneId);
      const sourceClient = sourceContext && sourceContext.ownerWin === ownerWin
        ? sourceContext.client
        : getClient(request.sourceKey);
      if (sourceClient) targetCwd = sourceClient.cwd;
    }
    const client = await ensureClient({ sessionPath, cwd: targetCwd, ownerWin });
    const state = await stateForClient(client);
    const context = bindPane(event, request.paneId, client);
    if (ownerWin) lastFocusedMainWin = ownerWin;
    return describeActivation(context, state);
  } catch (error) { return publicError(error, 'The session could not be opened'); }
});

secureHandle('rpc:list-clients', async () => [...new Set(clients.values())].map((client) => ({
  key: client.key, sessionFile: client.sessionFile, streaming: client.streaming, alive: client.alive, cwd: client.cwd,
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
    const context = paneContextFor(event, request, { cap: 8 * 1024 });
    context.attachmentService.deleteDraft(context.draft.id);
    paneContexts.delete(context.id);
    refreshClientViewers(context.client);
    await evictIdleClients();
    return { ok: true };
  } catch (error) { return publicError(error); }
});

// ---------- Empty-session cleanup ----------

async function cleanupAutoCreatedSessions() {
  await cleanupTrackedEmptySessions(SESSIONS_DIR, createdSessionFiles, countSessionMessages);
}

// ---------- Session listing ----------

async function listSessions() {
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    const p = path.join(SESSIONS_DIR, f);
    try {
      const stat = fs.statSync(p);
      const content = fs.readFileSync(p, 'utf8');
      const lines = content.split('\n');
      let header = null, name = null, preview = null, messageCount = 0;
      let lastTs = stat.mtimeMs;
      for (const line of lines) {
        if (!line || line[0] !== '{') continue;
        let obj = null;
        if (!header && line.includes('"type":"session"')) {
          obj = JSON.parse(line);
          if (obj.type === 'session') { header = obj; continue; }
        }
        if (line.includes('"type":"session_info"') && line.includes('"name"')) {
          obj = obj || JSON.parse(line);
          if (obj.type === 'session_info' && obj.name) { name = obj.name; continue; }
        }
        if (line.includes('"type":"message"')) {
          obj = obj || JSON.parse(line);
          if (obj.type !== 'message') continue;
          messageCount++;
          if (obj.timestamp) lastTs = Date.parse(obj.timestamp) || lastTs;
          const m = obj.message;
          if (!preview && m && m.role === 'user') {
            const text = typeof m.content === 'string'
              ? m.content
              : (Array.isArray(m.content) ? (m.content.find((c) => c.type === 'text') || {}).text : '');
            if (text) preview = parseFileTransport(String(text)).text.replace(/\s+/g, ' ').slice(0, 140);
          }
        }
      }
      if (!header) continue;
      out.push({
        path: p, id: header.id, cwd: header.cwd, name, preview, messageCount,
        rlmDepth: header.rlmDepth || 0,
        parentSession: header.parentSession || null,
        createdAt: Date.parse(header.timestamp) || stat.birthtimeMs,
        updatedAt: lastTs,
      });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

let watchTimer = null;
function watchSessions() {
  try {
    fs.watch(SESSIONS_DIR, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => broadcast('sessions-changed', await listSessions()), 400);
    });
  } catch {}
}

secureHandle('sessions:list', () => listSessions());
secureHandle('sessions:delete', async (_event, sessionPath) => {
  try {
    const canonical = await canonicalSessionPath(SESSIONS_DIR, sessionPath);
    const client = clients.get(canonical);
    if (client) {
      if (client.streaming) throw new Error('Stop the current response before deleting this session');
      await disposeClient(client, 'session deletion');
    }
    await safeDeleteSession(SESSIONS_DIR, canonical);
    return { ok: true };
  } catch (error) { return publicError(error, 'That session could not be deleted'); }
});
secureHandle('sessions:tail', async (_event, request) => {
  try {
    assertSmallDto(request, 16 * 1024);
    const sessionPath = await canonicalSessionPath(SESSIONS_DIR, request && request.path);
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

secureHandle('agent:kill-all', async () => {
  const unique = [...new Set(clients.values())];
  await Promise.all(unique.map((client) => disposeClient(client, 'manual restart')));
  clients.clear();
  return { ok: true };
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
    const entry = { ...raw };
    delete entry.hasApiKey;
    delete entry.apiKeyMasked;
    if ((entry.apiKey == null || entry.apiKey === '') && existing.providers && existing.providers[id] && typeof existing.providers[id].apiKey === 'string') {
      entry.apiKey = existing.providers[id].apiKey;
    }
    providers[id] = entry;
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

function resizeWithin(width, height, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
async function normalizeImageWithElectron({ buffer, mimeType, maxDimension = MAX_DIMENSION, maxBase64 = MAX_IMAGE_BASE64 }) {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw new AttachmentError('IMAGE_DECODE', 'That image could not be decoded safely');
  const sourceSize = image.getSize();
  if (!sourceSize.width || !sourceSize.height || sourceSize.width * sourceSize.height > 36_000_000) {
    throw new AttachmentError('IMAGE_DIMENSIONS', 'That image is too large to decode safely (36 megapixels maximum)');
  }
  const target = resizeWithin(sourceSize.width, sourceSize.height, maxDimension);
  let normalizedImage = target.width === sourceSize.width && target.height === sourceSize.height
    ? image
    : image.resize({ width: target.width, height: target.height, quality: 'best' });
  let output = buffer;
  let outputMime = mimeType;
  if (target.width !== sourceSize.width || target.height !== sourceSize.height || buffer.toString('base64').length >= maxBase64 || mimeType === 'image/gif') {
    output = mimeType === 'image/png' ? normalizedImage.toPNG() : normalizedImage.toJPEG(90);
    outputMime = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  }
  let quality = 88;
  for (let round = 0; output.toString('base64').length >= maxBase64 && round < 12; round += 1) {
    const size = normalizedImage.getSize();
    if (round >= 4) normalizedImage = normalizedImage.resize({ width: Math.max(1, Math.round(size.width * 0.86)), height: Math.max(1, Math.round(size.height * 0.86)), quality: 'best' });
    output = normalizedImage.toJPEG(Math.max(45, quality));
    outputMime = 'image/jpeg';
    quality -= 7;
  }
  if (!output.length || output.toString('base64').length >= maxBase64 || !sniffImageMime(output)) {
    throw new AttachmentError('IMAGE_NORMALIZE_LIMIT', 'That image remains too large after resizing');
  }
  const size = normalizedImage.getSize();
  const previewSize = resizeWithin(size.width, size.height, 180);
  const preview = normalizedImage.resize({ ...previewSize, quality: 'good' }).toPNG();
  return { buffer: output, mimeType: outputMime, width: size.width, height: size.height, previewBuffer: preview, previewMimeType: 'image/png' };
}

function requireCurrentDraft(context, draftId) {
  if (!context || !context.draft || context.draft.id !== draftId) throw new AttachmentError('STALE_DRAFT', 'This attachment draft is no longer available');
}
function updateContextDraft(context) {
  context.draft = context.attachmentService.describeDraft(context.draft.id);
  return context.draft;
}
function rotateContextDraft(context) {
  if (context.draft && context.draft.id) context.attachmentService.deleteDraft(context.draft.id);
  context.draft = context.attachmentService.createDraft();
  sendToWindow(context.ownerWin, 'attachments-reset', { paneId: context.id, draft: context.draft });
  return context.draft;
}

async function activateProjectForPane(event, context, inspected) {
  let client = null;
  try {
    client = await spawnClient({ cwd: inspected.root, ownerWin: context.ownerWin, inspectedWorkspace: inspected });
    const state = await stateForClient(client);
    const replacement = bindPane(event, context.id, client);
    sendToWindow(replacement.ownerWin, 'workspace-changed', { key: client.key, paneId: replacement.id, workspace: client.workspace.describe() });
    return describeActivation(replacement, state);
  } catch (error) {
    // Rollback is simple and complete: bindPane commits only after both the RPC
    // client and workspace watcher are ready, so the prior pane/context remains.
    if (client && (!paneContexts.get(context.id) || paneContexts.get(context.id).client !== client)) {
      await disposeClient(client, 'failed workspace activation rollback').catch(() => {});
    }
    throw error;
  }
}

secureHandle('workspace:get', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    return { ok: true, workspace: context.client.workspace.describe(), choices: await context.client.workspace.choicesForRenderer() };
  } catch (error) { return publicError(error, 'Project details are unavailable'); }
});
secureHandle('workspace:pick', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    return await runPaneTransition(async () => {
      await requireIdleClient(context.client, 'changing projects');
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
      await requireIdleClient(context.client, 'changing projects');
      return await activateProjectForPane(event, context, inspected);
    });
  } catch (error) { return publicError(error, 'That project could not be opened'); }
});
secureHandle('workspace:activate', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    return await runPaneTransition(async () => {
      await requireIdleClient(context.client, 'changing projects');
      const inspected = await context.client.workspace.resolveChoice(request.choiceId);
      return await activateProjectForPane(event, context, inspected);
    });
  } catch (error) { return publicError(error, 'That project could not be opened'); }
});
secureHandle('workspace:list-dir', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 32 * 1024 });
    return await context.client.workspace.listDirectory(request.request || {});
  } catch (error) { return publicError(error, 'That folder could not be read'); }
});
secureHandle('workspace:search', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 32 * 1024 });
    return await context.client.workspace.search(request.request || {});
  } catch (error) { return { ...publicError(error, 'Project files could not be searched'), entries: [] }; }
});
secureHandle('workspace:read-file', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    return await context.client.workspace.readFile(request.nodeId, request.maxBytes);
  } catch (error) { return publicError(error, 'That file could not be read'); }
});
secureHandle('workspace:refresh', (event, request) => {
  try { const context = paneContextFor(event, request, { cap: 8 * 1024 }); context.client.workspace.refresh('manual'); return { ok: true }; }
  catch (error) { return publicError(error); }
});
secureHandle('workspace:context-menu', async (event, request) => {
  try {
    const context = paneContextFor(event, request, { cap: 16 * 1024 });
    const paths = await context.client.workspace.contextPaths(request.nodeId);
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
  try {
    context = paneContextFor(event, request, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
    let paths;
    if (TEST_MODE && process.env.PRIME_DESKTOP_TEST_ATTACH_PATHS) paths = JSON.parse(process.env.PRIME_DESKTOP_TEST_ATTACH_PATHS);
    else {
      const result = await dialog.showOpenDialog(context.ownerWin, { properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return { ok: true, canceled: true, draft: context.draft };
      paths = result.filePaths;
    }
    const result = await context.attachmentService.ingestPaths({ draftId: request.draftId, paths, source: 'picker' });
    return { ok: true, ...result, draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'A selected file could not be attached'), draft: context && context.draft }; }
});
secureHandle('attachments:drop', async (event, request) => {
  let context = null;
  try {
    context = paneContextFor(event, request, { cap: 128 * 1024 });
    requireCurrentDraft(context, request.draftId);
    if (!Array.isArray(request.paths) || request.paths.some((value) => typeof value !== 'string')) throw new AttachmentError('INVALID_SELECTION', 'That dropped file selection is invalid');
    const result = await context.attachmentService.ingestPaths({ draftId: request.draftId, paths: request.paths, source: 'drop' });
    return { ok: true, ...result, draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'A dropped file could not be attached'), draft: context && context.draft }; }
});
secureHandle('attachments:paste-image', async (event, request) => {
  let context = null;
  try {
    if (!request || typeof request.paneId !== 'string' || typeof request.draftId !== 'string' || typeof request.name !== 'string') throw new AttachmentError('INVALID_IMAGE', 'The pasted image could not be read');
    context = paneContextFor(event, { paneId: request.paneId, key: request.key }, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
    const raw = request.bytes;
    const length = raw && typeof raw.byteLength === 'number' ? raw.byteLength : -1;
    if (length < 0) throw new AttachmentError('INVALID_IMAGE', 'The pasted image could not be read');
    if (length > 20_000_000) throw new AttachmentError('IMAGE_TOO_LARGE', 'Images must be 20 MB or smaller');
    const bytes = Buffer.from(raw.buffer || raw, raw.byteOffset || 0, length);
    const result = await context.attachmentService.ingestClipboardImage({ draftId: request.draftId, bytes, name: request.name });
    return { ok: true, item: result.item, duplicate: result.duplicate, draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'The pasted image could not be attached'), draft: context && context.draft }; }
});
secureHandle('attachments:add-tree-node', async (event, request) => {
  let context = null;
  try {
    context = paneContextFor(event, request, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
    const node = await context.client.workspace.contextPaths(request.nodeId);
    let result;
    if (node.isDirectory) {
      result = context.attachmentService.ingestReference({
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
    return { ok: true, ...result, draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'That project entry could not be attached'), draft: context && context.draft }; }
});
secureHandle('attachments:add-session', async (event, request) => {
  let context = null;
  try {
    context = paneContextFor(event, request, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
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
    const result = context.attachmentService.ingestReference({
      draftId: request.draftId,
      kind: 'session',
      name: boundedText(request.name || path.basename(sessionPath), 255),
      dedupeKey: `session:${sessionPath}`,
      text: `<referenced_session>\n${transcript.join('\n')}\n</referenced_session>`,
    });
    return { ok: true, items: result.duplicate ? [] : [result.item], duplicates: result.duplicate ? 1 : 0, errors: [], draft: updateContextDraft(context) };
  } catch (error) { return { ...publicError(error, 'That session could not be attached'), draft: context && context.draft }; }
});
secureHandle('attachments:remove', async (event, request) => {
  let context = null;
  try {
    context = paneContextFor(event, request, { cap: 16 * 1024 });
    requireCurrentDraft(context, request.draftId);
    context.draft = context.attachmentService.remove({ draftId: request.draftId, attachmentId: request.attachmentId });
    return { ok: true, draft: context.draft };
  } catch (error) { return { ...publicError(error, 'That attachment could not be removed'), draft: context && context.draft }; }
});
secureHandle('chat:send', async (event, request) => {
  let context = null;
  try {
    context = paneContextFor(event, request, { cap: 256 * 1024 });
    requireCurrentDraft(context, request.draftId);
    if (context.sending) throw new Error('A message is already being sent from this pane');
    context.sending = true;
    const behavior = request.behavior === 'steer' ? 'steer' : request.behavior === 'followUp' ? 'followUp' : 'prompt';
    const sent = await context.attachmentService.sendDraft(
      { draftId: request.draftId, text: request.text || '', behavior },
      (command) => clientCommand(context.client, command),
    );
    if (!sent.accepted) return { ok: false, accepted: false, error: boundedText(sent.error, 500), draft: context.draft };
    const rendered = { text: sent.serialized.visibleText, attachments: sent.serialized.attachments };
    const draft = rotateContextDraft(context);
    return { ok: true, accepted: true, response: sent.response, rendered, draft };
  } catch (error) { return { ...publicError(error, 'The message could not be sent'), accepted: false, draft: context && context.draft }; }
  finally { if (context) context.sending = false; }
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
let lastFocusedMainWin = null;
const HUD_WIDTH = 620, HUD_HEIGHT = 480;
function installNavigationPolicy(window, localFile) {
  const allowed = pathToFileURL(localFile);
  const localPath = allowed.pathname;
  const isLocal = (target) => {
    try { const parsed = new URL(target); return parsed.protocol === 'file:' && parsed.pathname === localPath; }
    catch { return false; }
  };
  const deny = (target, kind) => {
    rememberSecurityEvent(kind, target);
    if (!TEST_MODE && /^https?:\/\//i.test(String(target || ''))) shell.openExternal(target).catch(() => {});
  };
  window.webContents.on('will-navigate', (event, target) => {
    if (isLocal(target)) return;
    event.preventDefault();
    deny(target, 'navigation-denied');
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (isLocal(target)) return;
    event.preventDefault();
    deny(target, 'redirect-denied');
  });
  window.webContents.setWindowOpenHandler(({ url }) => { deny(url, 'window-open-denied'); return { action: 'deny' }; });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function createHud() {
  hudWin = new BrowserWindow({
    width: HUD_WIDTH, height: HUD_HEIGHT, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#0f1011',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const hudFile = path.join(__dirname, 'renderer', 'hud.html');
  installNavigationPolicy(hudWin, hudFile);
  hudWin.loadFile(hudFile);
  hudWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWin.on('blur', () => { if (hudWin && !hudWin.webContents.isDevToolsOpened()) hudWin.hide(); });
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

function toggleHud() {
  if (!hudWin) return;
  if (hudWin.isVisible()) { hudWin.hide(); return; }
  hudClient = selectHudClient(null);
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  hudWin.setPosition(Math.round(x + (width - HUD_WIDTH) / 2), Math.round(y + height - HUD_HEIGHT - 72));
  hudWin.show(); hudWin.focus();
  hudWin.webContents.send('hud-opened', {
    key: hudClient && hudClient.key,
    sessionFile: hudClient && hudClient.sessionFile,
    streaming: !!(hudClient && hudClient.streaming),
  });
}
secureHandle('hud:hide', () => { if (hudWin) hudWin.hide(); });
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
  if (hudWin) hudWin.hide();
  return { ok: true, sessionFile: hudClient.sessionFile };
});

// ---------- Windows / pop-out ----------

const wins = new Set();
function createWindow(sessionQuery) {
  const win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 940, minHeight: 600,
    title: 'Prime Agent', backgroundColor: '#08090a', show: !TEST_MODE,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  wins.add(win);
  if (TEST_MODE) win.webContents.on('console-message', (_event, details) => {
    if (details && ['warning', 'error'].includes(details.level)) console.error('RENDERER_CONSOLE', boundedText(details.message, 2_000), boundedText(details.sourceId, 300), Number(details.lineNumber) || 0);
  });
  win.on('focus', () => { lastFocusedMainWin = win; });
  win.on('closed', () => {
    wins.delete(win);
    const affected = new Set();
    for (const [paneId, context] of paneContexts) {
      if (context.ownerWin !== win) continue;
      context.attachmentService.deleteDraft(context.draft.id);
      paneContexts.delete(paneId);
      affected.add(context.client);
    }
    for (const client of affected) refreshClientViewers(client);
    void evictIdleClients();
    if (lastFocusedMainWin === win) lastFocusedMainWin = null;
  });
  const file = path.join(__dirname, 'renderer', 'index.html');
  installNavigationPolicy(win, file);
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

function buildMenu() {
  const send = (id) => () => broadcast('menu-action', { id });
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
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Boot ----------

app.whenReady().then(async () => {
  buildMenu();
  createHud();
  if (!TEST_MODE) globalShortcut.register('CommandOrControl+Shift+Space', toggleHud);
  createWindow();
  watchSessions();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
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
      await Promise.all(unique.map((client) => disposeClient(client, 'shutdown')));
      await cleanupAutoCreatedSessions();
    } finally {
      clients.clear();
      shutdownComplete = true;
      app.quit();
    }
  })();
});
